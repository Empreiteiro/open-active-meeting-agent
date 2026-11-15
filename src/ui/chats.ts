// The UI's conversations with the local agent. Each chat is a JSON file
// (<home>/ui/chats/<id>.json); a turn runs the agent once:
//   - Claude Code: `claude -p` resumed with the chat's session, the meeting
//     tools allowed, the answer streamed, and every other permission asked to
//     the person in the UI;
//   - a command (OMA_UI_AGENT_COMMAND): the conversation as text on stdin.
// What happens is published on `chatEvents` (the UI's event stream).

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude, type ClaudeRun } from '../agents/claude.js';
import { runCommand, type CommandRun } from '../agents/command.js';
import { config } from '../config.js';
import { actOf, outputsLine, outputsOf } from '../outputs/index.js';
import { getCall, readJson, writeJson } from '../store.js';

export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: Record<string, unknown>; status: 'running' | 'ok' | 'error'; result?: string }
  | { type: 'permission'; id: string; tool: string; input: Record<string, unknown>; decision: 'pending' | 'allowed' | 'denied' };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  at: string;
  text?: string;
  parts?: ChatPart[];
  error?: string | null;
}

export interface Chat {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  /** The meeting this chat is about (its tab in the UI), if any. */
  call_id: string | null;
  /** The folder the agent works in. */
  workdir: string | null;
  /** Claude Code's session, resumed at each turn. */
  session_id: string | null;
  messages: ChatMessage[];
}

export const chatEvents = new EventEmitter();
chatEvents.setMaxListeners(100);

const dir = () => path.join(config.home, 'ui', 'chats');
const file = (id: string) => {
  if (!/^[a-z0-9-]{6,40}$/.test(id)) throw new Error(`invalid chat id: ${id}`);
  return path.join(dir(), `${id}.json`);
};
const newId = () => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const now = () => new Date().toISOString();

export function getChat(id: string): Chat | null {
  try { return readJson<Chat>(file(id)); } catch { return null; }
}

function mustGetChat(id: string): Chat {
  const c = getChat(id);
  if (!c) throw Object.assign(new Error(`chat not found: ${id}`), { status: 404 });
  return c;
}

const save = (c: Chat) => writeJson(file(c.id), c);

export function listChats(): Array<Pick<Chat, 'id' | 'title' | 'call_id' | 'updated_at'> & { running: boolean }> {
  if (!existsSync(dir())) return [];
  return readdirSync(dir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => getChat(f.slice(0, -5)))
    .filter((c): c is Chat => !!c)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map((c) => ({ id: c.id, title: c.title, call_id: c.call_id, updated_at: c.updated_at, running: running.has(c.id) }));
}

/** The chat about a meeting (the latest, if there are several). */
export const chatForCall = (callId: string): string | null => listChats().find((c) => c.call_id === callId)?.id ?? null;

export function validWorkdir(p: string | null | undefined): string | null {
  if (!p) return null;
  const abs = path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
  try { return statSync(abs).isDirectory() ? abs : null; } catch { return null; }
}

export function createChat(o: { call_id?: string | null; workdir?: string | null; title?: string } = {}): Chat {
  const call = o.call_id ? getCall(o.call_id) : null;
  if (o.call_id && !call) throw Object.assign(new Error(`call not found: ${o.call_id}`), { status: 404 });
  const c: Chat = {
    id: newId(),
    title: o.title?.trim() || (call ? call.title : ''),
    created_at: now(),
    updated_at: now(),
    call_id: call?.id ?? null,
    workdir: validWorkdir(o.workdir) ?? validWorkdir(call?.workdir) ?? validWorkdir(config.uiWorkdir) ?? os.homedir(),
    session_id: null,
    messages: [],
  };
  save(c);
  return c;
}

export function updateChat(id: string, patch: { title?: string; workdir?: string; call_id?: string | null }): Chat {
  const c = mustGetChat(id);
  if (patch.title != null) c.title = patch.title.trim().slice(0, 120);
  if (patch.workdir != null) {
    const w = validWorkdir(patch.workdir);
    if (!w) throw Object.assign(new Error(`not a folder: ${patch.workdir}`), { status: 400 });
    if (w !== c.workdir) { c.workdir = w; c.session_id = null; } // a Claude Code session belongs to its folder
  }
  if (patch.call_id !== undefined) {
    if (patch.call_id && !getCall(patch.call_id)) throw Object.assign(new Error(`call not found: ${patch.call_id}`), { status: 404 });
    c.call_id = patch.call_id;
  }
  c.updated_at = now();
  save(c);
  return c;
}

export function deleteChat(id: string): void {
  running.get(id)?.stop();
  rmSync(file(id), { force: true });
}

// ── A turn ─────────────────────────────────────────────────────────────────

interface Running { stop(): void; permissions: Map<string, (d: { allow: boolean; message?: string }) => void> }
const running = new Map<string, Running>();

export const isRunning = (id: string) => running.has(id);

function emit(chatId: string, e: Record<string, unknown>) {
  chatEvents.emit('chat', { chat_id: chatId, ...e });
}

/** Where the bundled CLI is (for an MCP server of our own when Claude Code has none). */
function cliPath(): string {
  if (process.env.OMA_CLI_PATH) return process.env.OMA_CLI_PATH;
  const self = fileURLToPath(import.meta.url);
  return self.endsWith('.mjs') ? self : path.resolve(path.dirname(self), '..', '..', 'dist', 'oma.mjs');
}

/** Whether Claude Code already has the meeting tools (the plugin, or `claude mcp add meeting-agent`). */
function claudeHasMeetingTools(): boolean {
  const settings = readJson<{ enabledPlugins?: Record<string, boolean> }>(path.join(os.homedir(), '.claude', 'settings.json'));
  if (Object.entries(settings?.enabledPlugins ?? {}).some(([k, on]) => on && k.startsWith('meeting-agent@'))) return true;
  try {
    const user = JSON.parse(readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
    return !!user.mcpServers?.['meeting-agent'];
  } catch {
    return false;
  }
}

/** What the agent is told about this UI (and the meeting, for a meeting's chat). */
export function chatSystemPrompt(c: Chat): string {
  const lines = [
    'You are talking with the person through the open-meeting-agent web UI, a chat in their browser on this machine.',
    'You are the meeting agent\'s brain. For anything about meetings use the meeting-agent MCP tools: join_meeting (someone admits the bot), call_status, watch_meeting / send_meeting_message (in the meeting), get_call_context + save_plan (the plan), distribute_plan (the outputs), next_task / update_task (the work).',
    'The UI already shows each meeting\'s live transcript, plan and status in its own tabs: summarize, don\'t paste long transcripts or plans back.',
    'Answer in the person\'s language, in short Markdown.',
  ];
  const call = c.call_id ? getCall(c.call_id) : null;
  if (call) {
    lines.push(
      `This chat is about the meeting "${call.title}" — call_id ${call.id} (pass it to the tools). Status: ${call.status}${call.error ? ` (${call.error})` : ''}; source: ${call.source}; acts: ${actOf(call)}; autonomy: ${call.autonomy}; outputs: ${outputsLine(outputsOf(call))}${call.repos.length ? `; repositories: ${call.repos.join(', ')}` : ''}.`,
    );
  }
  return lines.join('\n');
}

function commandPrompt(c: Chat, text: string): string {
  const history = c.messages.slice(-21, -2).map((m) => (m.role === 'user'
    ? `User: ${m.text ?? ''}`
    : `Assistant: ${(m.parts ?? []).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')}`));
  return [chatSystemPrompt(c), '', ...history, `User: ${text}`, 'Assistant:'].join('\n');
}

export function sendMessage(chatId: string, text: string): { user: ChatMessage; assistant: ChatMessage } {
  const c = mustGetChat(chatId);
  if (running.has(c.id)) throw Object.assign(new Error('The agent is still answering in this chat.'), { status: 409 });
  if (config.uiAgent === 'command' && !config.uiAgentCommand) throw Object.assign(new Error('OMA_UI_AGENT=command needs OMA_UI_AGENT_COMMAND.'), { status: 400 });
  const user: ChatMessage = { id: newId(), role: 'user', at: now(), text: text.trim() };
  const assistant: ChatMessage = { id: newId(), role: 'assistant', at: now(), parts: [], error: null };
  if (!c.title) c.title = text.trim().split('\n')[0]!.slice(0, 60);
  c.messages.push(user, assistant);
  c.updated_at = now();
  save(c);

  const parts = assistant.parts!;
  const lastText = (): { type: 'text'; text: string } => {
    const p = parts.at(-1);
    if (p?.type === 'text') return p;
    const t = { type: 'text' as const, text: '' };
    parts.push(t);
    return t;
  };
  let saveTimer: NodeJS.Timeout | null = null;
  const saveSoon = () => { saveTimer ??= setTimeout(() => { saveTimer = null; save(c); }, 1500); };
  const state: Running = { stop: () => {}, permissions: new Map() };
  running.set(c.id, state);
  emit(c.id, { type: 'start', user, assistant });

  const end = (error: string | null) => {
    if (saveTimer) clearTimeout(saveTimer);
    for (const p of parts) if (p.type === 'tool' && p.status === 'running') p.status = 'error';
    for (const p of parts) if (p.type === 'permission' && p.decision === 'pending') p.decision = 'denied';
    assistant.error = error;
    c.updated_at = now();
    save(c);
    running.delete(c.id);
    emit(c.id, { type: 'done', message: assistant, error });
  };

  if (config.uiAgent === 'command') {
    const run: CommandRun = runCommand(config.uiAgentCommand!, commandPrompt(c, text), {
      cwd: c.workdir ?? os.homedir(),
      onText: (s) => { lastText().text += s; emit(c.id, { type: 'text', message_id: assistant.id, text: s }); saveSoon(); },
    });
    state.stop = run.stop;
    run.result.then(() => end(null), (e: Error) => end(e.message === 'stopped' ? null : e.message));
    return { user, assistant };
  }

  const run: ClaudeRun = runClaude({
    content: text.trim(),
    cwd: c.workdir ?? os.homedir(),
    sessionId: c.session_id,
    model: config.uiModel,
    appendSystemPrompt: chatSystemPrompt(c),
    allowedTools: ['mcp__plugin_meeting-agent_meeting-agent', 'mcp__meeting-agent', ...config.uiAllowedTools],
    mcpConfig: claudeHasMeetingTools() ? null : { mcpServers: { 'meeting-agent': { command: process.execPath, args: ['--no-warnings', cliPath(), 'mcp'] } } },
    partial: true,
    onEvent: (e) => {
      if (e.type === 'init') {
        if (e.sessionId && e.sessionId !== c.session_id) { c.session_id = e.sessionId; saveSoon(); }
      } else if (e.type === 'text') {
        lastText().text += e.text;
        emit(c.id, { type: 'text', message_id: assistant.id, text: e.text });
        saveSoon();
      } else if (e.type === 'tool') {
        const part: ChatPart = { type: 'tool', id: e.id, name: e.name, input: e.input, status: 'running' };
        parts.push(part);
        emit(c.id, { type: 'part', message_id: assistant.id, part });
        save(c);
      } else if (e.type === 'tool_result') {
        const part = parts.find((p) => p.type === 'tool' && p.id === e.id) as Extract<ChatPart, { type: 'tool' }> | undefined;
        if (!part) return;
        part.status = e.ok ? 'ok' : 'error';
        part.result = e.text;
        emit(c.id, { type: 'part', message_id: assistant.id, part });
        save(c);
      }
    },
    onPermission: (r) => new Promise((resolve) => {
      const part: ChatPart = { type: 'permission', id: r.id, tool: r.tool, input: r.input, decision: 'pending' };
      parts.push(part);
      save(c);
      emit(c.id, { type: 'part', message_id: assistant.id, part });
      state.permissions.set(r.id, (d) => {
        state.permissions.delete(r.id);
        part.decision = d.allow ? 'allowed' : 'denied';
        save(c);
        emit(c.id, { type: 'part', message_id: assistant.id, part });
        resolve(d);
      });
    }),
  });
  state.stop = run.stop;
  run.result.then(
    (r) => {
      if (r.sessionId) c.session_id = r.sessionId;
      if (!parts.some((p) => p.type === 'text' && p.text.trim()) && r.text) lastText().text = r.text;
      end(r.isError ? (r.text || 'Claude Code failed') : null);
    },
    (e: Error) => end(e.message === 'stopped' ? null : e.message),
  );
  return { user, assistant };
}

export function answerPermission(chatId: string, requestId: string, allow: boolean): void {
  const r = running.get(chatId)?.permissions.get(requestId);
  if (!r) throw Object.assign(new Error('That request is no longer open.'), { status: 404 });
  r(allow ? { allow: true } : { allow: false, message: 'The person said no in the UI.' });
}

export function stopChat(chatId: string): boolean {
  const r = running.get(chatId);
  if (!r) return false;
  for (const answer of r.permissions.values()) answer({ allow: false, message: 'Stopped.' });
  r.stop();
  return true;
}

export function stopAll(): void {
  for (const id of [...running.keys()]) stopChat(id);
}
