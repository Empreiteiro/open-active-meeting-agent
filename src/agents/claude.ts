// Claude Code on this machine, driven through its print mode with JSON in and
// out (`claude -p --input-format stream-json --output-format stream-json`): its
// own sign-in, no API key. Two uses:
//   - as the model (provider claude-code): no tools, our system prompt, one answer;
//   - as the UI's chat: its tools and MCP servers (the meeting tools among
//     them), sessions resumed turn after turn, the answer streamed, and each
//     permission it needs asked to the person in the UI (--permission-prompt-tool stdio).

import { spawn } from 'node:child_process';
import { config } from '../config.js';

export type ClaudeBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface PermissionRequest { id: string; tool: string; input: Record<string, unknown>; toolUseId: string | null }

export type ClaudeEvent =
  | { type: 'init'; sessionId: string; model: string | null; mcp: Array<{ name: string; status: string }> }
  /** A piece of the answer, as it is written. */
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; ok: boolean; text: string };

export interface ClaudeTurn {
  content: string | ClaudeBlock[];
  cwd: string;
  /** Continue this session (the answer carries the id to pass next time). */
  sessionId?: string | null;
  model?: string | null;
  /** Replaces Claude Code's own system prompt (the model use). */
  systemPrompt?: string;
  appendSystemPrompt?: string;
  /** Built-in tools it may use ([] = none); unset: its defaults. */
  tools?: string[];
  /** Permission rules allowed without asking (e.g. "mcp__meeting-agent", "Bash(git status:*)"). */
  allowedTools?: string[];
  mcpConfig?: Record<string, unknown> | null;
  /** Only the MCP servers in mcpConfig (none without it). */
  strictMcp?: boolean;
  /** Keep the session on disk so it can be resumed (default true). */
  persist?: boolean;
  /** Stream the answer as it is written. */
  partial?: boolean;
  timeoutMs?: number;
  onEvent?: (e: ClaudeEvent) => void;
  /** Asked for each tool use that needs permission. Without it, those are refused. */
  onPermission?: (r: PermissionRequest) => Promise<{ allow: boolean; message?: string }>;
}

export interface ClaudeResult {
  sessionId: string | null;
  /** The final answer (the last message's text). */
  text: string;
  isError: boolean;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface ClaudeRun { result: Promise<ClaudeResult>; stop(): void }

export class ClaudeError extends Error {}

export function claudeArgs(t: ClaudeTurn): string[] {
  const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  if (t.partial) a.push('--include-partial-messages');
  if (t.onPermission) a.push('--permission-prompt-tool', 'stdio');
  if (t.sessionId) a.push('--resume', t.sessionId);
  if (t.model) a.push('--model', t.model);
  if (t.systemPrompt != null) a.push('--system-prompt', t.systemPrompt);
  if (t.appendSystemPrompt) a.push('--append-system-prompt', t.appendSystemPrompt);
  if (t.tools) a.push('--tools', t.tools.join(','));
  if (t.allowedTools?.length) a.push('--allowedTools', t.allowedTools.join(','));
  if (t.mcpConfig) a.push('--mcp-config', JSON.stringify(t.mcpConfig));
  if (t.strictMcp) a.push('--strict-mcp-config');
  if (t.persist === false) a.push('--no-session-persistence');
  return a;
}

const short = (s: string, n = 2000): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c as { text?: string }).text ?? '').filter(Boolean).join('\n');
  return '';
}

export function runClaude(t: ClaudeTurn): ClaudeRun {
  const p = spawn(config.claudeBin, claudeArgs(t), { cwd: t.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let stopped = false;
  const result = new Promise<ClaudeResult>((resolve, reject) => {
    let buf = '';
    let stderr = '';
    let session: string | null = t.sessionId ?? null;
    let model: string | null = null;
    let lastText = '';
    let done = false;
    const timer = t.timeoutMs ? setTimeout(() => { fail(new ClaudeError(`Claude Code took more than ${Math.round(t.timeoutMs! / 1000)} s`)); p.kill('SIGTERM'); }, t.timeoutMs) : null;
    const finish = (r: ClaudeResult) => { if (done) return; done = true; if (timer) clearTimeout(timer); p.stdin.end(); resolve(r); };
    const fail = (e: Error) => { if (done) return; done = true; if (timer) clearTimeout(timer); reject(e); };
    const send = (o: unknown) => { if (!p.stdin.destroyed) p.stdin.write(`${JSON.stringify(o)}\n`); };

    const handle = (ev: Record<string, any>) => {
      switch (ev.type) {
        case 'system':
          if (ev.subtype === 'init') {
            session = ev.session_id ?? session;
            model = ev.model ?? null;
            t.onEvent?.({ type: 'init', sessionId: session ?? '', model, mcp: Array.isArray(ev.mcp_servers) ? ev.mcp_servers : [] });
          }
          return;
        case 'stream_event': {
          const e = ev.event;
          if (t.partial && !ev.parent_tool_use_id && e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') t.onEvent?.({ type: 'text', text: e.delta.text });
          return;
        }
        case 'assistant': {
          if (ev.parent_tool_use_id) return; // a subagent's own steps
          const blocks: Array<Record<string, any>> = ev.message?.content ?? [];
          const texts = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? ''));
          if (texts.length) lastText = texts.join('\n');
          for (const b of blocks) {
            if (b.type === 'text' && !t.partial) t.onEvent?.({ type: 'text', text: String(b.text ?? '') });
            if (b.type === 'tool_use') t.onEvent?.({ type: 'tool', id: String(b.id), name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> });
          }
          return;
        }
        case 'user': {
          if (ev.parent_tool_use_id) return;
          const blocks: Array<Record<string, any>> = Array.isArray(ev.message?.content) ? ev.message.content : [];
          for (const b of blocks) {
            if (b.type === 'tool_result') t.onEvent?.({ type: 'tool_result', id: String(b.tool_use_id), ok: !b.is_error, text: short(resultText(b.content)) });
          }
          return;
        }
        case 'control_request': {
          const r = ev.request ?? {};
          const reply = (response: Record<string, unknown>) => send({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response } });
          if (r.subtype !== 'can_use_tool') { reply({}); return; }
          const input = (r.input ?? {}) as Record<string, unknown>;
          const ask = t.onPermission
            ? t.onPermission({ id: String(ev.request_id), tool: String(r.tool_name), input, toolUseId: r.tool_use_id ?? null })
            : Promise.resolve({ allow: false, message: 'Not allowed here.' });
          ask.then(
            (d) => reply(d.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: d.message || 'The person refused.' }),
            () => reply({ behavior: 'deny', message: 'The person refused.' }),
          );
          return;
        }
        case 'result':
          finish({
            sessionId: ev.session_id ?? session,
            text: typeof ev.result === 'string' && ev.result ? ev.result : lastText,
            isError: !!ev.is_error,
            model,
            inputTokens: ev.usage?.input_tokens ?? 0,
            outputTokens: ev.usage?.output_tokens ?? 0,
            costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
          });
          return;
        default:
      }
    };

    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { handle(JSON.parse(line) as Record<string, any>); } catch { /* not JSON: ignore */ }
      }
    });
    p.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString('utf8')).slice(-4000); });
    p.on('error', (e: NodeJS.ErrnoException) => fail(new ClaudeError(e.code === 'ENOENT'
      ? `Claude Code (${config.claudeBin}) is not installed: https://claude.com/claude-code — or set OMA_CLAUDE_BIN`
      : e.message)));
    p.on('close', (code) => {
      if (stopped) fail(new ClaudeError('stopped'));
      else fail(new ClaudeError(`Claude Code ended without an answer (exit ${code})${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`));
    });
    p.stdin.on('error', () => {});
    send({ type: 'user', message: { role: 'user', content: t.content } });
  });
  return {
    result,
    stop: () => { stopped = true; p.kill('SIGTERM'); },
  };
}

let version: { at: number; value: string | null } | null = null;

/** Claude Code's version, or null when it is not installed (cached a minute). */
export async function claudeVersion(): Promise<string | null> {
  if (version && Date.now() - version.at < 60_000) return version.value;
  const value = await new Promise<string | null>((resolve) => {
    const p = spawn(config.claudeBin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { p.kill(); resolve(null); }, 15_000);
    p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out.trim().split('\n')[0] ?? '' : null); });
  });
  version = { at: Date.now(), value };
  return value;
}
