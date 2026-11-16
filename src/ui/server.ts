// `oma ui`: a local web UI — a chat with the local agent (Claude Code, or any
// command) beside the meetings: live transcript, plan, outputs.
//
// Only this machine reaches it: it listens on 127.0.0.1, answers only requests
// addressed to localhost (no DNS rebinding), and every API call carries the
// token the page was served with (no other site can drive it).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeVersion } from '../agents/claude.js';
import { config, CRM_TARGETS, DOC_TARGETS, reloadConfig, TASKS_TARGETS } from '../config.js';
import { agentNames, agentWatching, readLive, sayInMeeting } from '../live.js';
import { llmConfigured, llmLabel } from '../llm/index.js';
import { doctor } from '../mcp/server.js';
import { actOf, deliverOutputs, isLiveSource, liveTaskTarget, OUTPUT_KINDS, outputsOf, resultsText } from '../outputs/index.js';
import { cancelMeeting, endMeeting, joinMeeting, startHuddle } from '../pipeline.js';
import { botStatus } from '../sources/bot.js';
import {
  addAudio, addMedia, adoptHuddles, askInHuddle, endHuddle, HuddleError, huddleTick, markSpeaking, readMeta, setScreen, watchHuddle,
} from '../sources/huddle.js';
import { callPaths, getCall, getFrames, getPlan, getTranscript, listCalls, readJson, updateCall, writeJson } from '../store.js';
import { progress, readyTasks } from '../tasks.js';
import type { ActMode, Autonomy, Call, OutputKind } from '../types.js';
import {
  answerPermission, chatEvents, chatForCall, createChat, deleteChat, getChat, isRunning, listChats, sendMessage, stopAll, stopChat, updateChat, validWorkdir,
} from './chats.js';

const STATIC: Record<string, string> = {
  '/': 'index.html', '/index.html': 'index.html', '/app.css': 'app.css', '/app.js': 'app.js', '/favicon.svg': 'favicon.svg',
  '/pcm-worklet.js': 'pcm-worklet.js',
};
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };

/** The page's files: ui/ at the repository root (next to dist/ or src/). */
function uiDir(): string {
  if (process.env.OMA_UI_DIR) return process.env.OMA_UI_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const d of [path.resolve(here, '..', 'ui'), path.resolve(here, '..', '..', 'ui')]) {
    if (existsSync(path.join(d, 'index.html'))) return d;
  }
  throw new Error('The UI files (ui/index.html) were not found next to the oma command.');
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// ── What the page reads ──────────────────────────────────────────────────────

function callItem(c: Call) {
  return {
    id: c.id, title: c.title, status: c.status, error: c.error ?? null, source: c.source, created_at: c.created_at,
    updated_at: c.updated_at, act: actOf(c), provider: c.provider ?? null,
  };
}

function callDetail(c: Call) {
  const plan = getPlan(c.id);
  const inMeeting = isLiveSource(c) && (c.status === 'joining' || c.status === 'in_call');
  const live = isLiveSource(c) ? readLive(c.id, c.agent_name) : null;
  const meta = c.source === 'huddle' ? readMeta(c.id) : null;
  const pr = plan ? progress(plan) : null;
  return {
    call: {
      ...callItem(c), autonomy: c.autonomy, outputs: outputsOf(c), repos: c.repos, workdir: c.workdir, agent_name: c.agent_name,
      meeting_url: c.meeting_url ?? null, joined_at: c.joined_at ?? null, ended_at: c.ended_at ?? null, live_tasks: c.live_tasks ?? [],
      notes: c.notes, language: c.language,
    },
    bot: inMeeting && c.source === 'bot' ? botStatus(c.id) : null,
    huddle: meta ? { speaker: meta.speaker, parts: meta.parts.length, transcribing: config.asr !== 'none' } : null,
    live: live && (inMeeting || live.lines.length) ? live : null,
    /** Who answers when someone calls the agent in the meeting. */
    /** The names that call the agent in the meeting. */
    names: agentNames(c),
    brain: actOf(c) === 'after' ? null : llmConfigured() ? llmLabel() : agentWatching(c.id) ? 'agent' : null,
    live_tasks_to: inMeeting ? liveTaskTarget(c) : null,
    transcript: getTranscript(c.id),
    frames: getFrames(c.id).map((f) => ({ label: f.label, t: f.t })),
    plan: plan ? { ...plan, progress: pr, ready: readyTasks(plan).map((t) => t.key) } : null,
    chat_id: chatForCall(c.id),
  };
}

async function agentState(): Promise<{ kind: string; label: string; ready: boolean; detail: string }> {
  if (config.uiAgent === 'command') {
    return { kind: 'command', label: config.uiAgentCommand?.split(/\s+/)[0] ?? 'command', ready: !!config.uiAgentCommand, detail: config.uiAgentCommand ?? 'OMA_UI_AGENT_COMMAND is not set' };
  }
  const v = await claudeVersion();
  return { kind: 'claude', label: 'Claude Code', ready: !!v, detail: v ?? `not found (${config.claudeBin}) — install Claude Code or set OMA_CLAUDE_BIN` };
}

async function state() {
  return {
    app: 'oma-ui',
    home: config.home,
    agent: await agentState(),
    model: { configured: llmConfigured(), label: llmConfigured() ? llmLabel() : null, provider: config.llm },
    defaults: {
      act: config.act, autonomy: config.autonomy, tasks: config.tasksTarget, crm: config.crmTarget, doc: config.docTarget,
      agent_name: config.agentName, language: config.language, workdir: validWorkdir(config.uiWorkdir) ?? os.homedir(),
    },
    targets: { tasks: TASKS_TARGETS, crm: CRM_TARGETS, doc: DOC_TARGETS },
    user: os.userInfo().username,
  };
}

// Settings the page may change (defaults only — secrets stay in config.json).
const SETTABLE: Record<string, (v: string) => boolean> = {
  OMA_LLM_PROVIDER: (v) => ['claude-code', 'anthropic', 'openai', 'command'].includes(v),
  OMA_ACT: (v) => ['after', 'during', 'both'].includes(v),
  OMA_AUTONOMY: (v) => ['suggest', 'issues', 'prs'].includes(v),
  OMA_TASKS_TARGET: (v) => v === 'none' || (TASKS_TARGETS as readonly string[]).includes(v),
  OMA_CRM_TARGET: (v) => v === 'none' || (CRM_TARGETS as readonly string[]).includes(v),
  OMA_DOC_TARGET: (v) => v === 'none' || (DOC_TARGETS as readonly string[]).includes(v),
  OMA_AGENT_NAME: (v) => v.length <= 60,
  OMA_LANGUAGE: (v) => /^[a-z]{2}(-[A-Za-z]{2})?$/.test(v),
  OMA_UI_WORKDIR: (v) => !!validWorkdir(v),
};

function setConfig(changes: Record<string, unknown>): string[] {
  const file = path.join(config.home, 'config.json');
  const cur = readJson<Record<string, unknown>>(file) ?? {};
  const warnings: string[] = [];
  for (const [k, raw] of Object.entries(changes)) {
    const v = String(raw ?? '').trim();
    const ok = SETTABLE[k];
    if (!ok) throw new HttpError(400, `${k} can't be changed here (edit ${file})`);
    if (v && !ok(v)) throw new HttpError(400, `invalid ${k}: ${v}`); // empty: back to the default
    if (v) cur[k] = v; else delete cur[k];
    if (process.env[k] != null) warnings.push(`${k} is also set in the environment, which wins`);
  }
  writeJson(file, cur);
  reloadConfig();
  return warnings;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function rawBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, 'too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function body(req: http.IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

const json = (res: http.ServerResponse, status: number, v: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(v));
};

const mustCall = (id: string): Call => {
  const c = getCall(id);
  if (!c) throw new HttpError(404, `call not found: ${id}`);
  return c;
};

function str(v: unknown, max = 2000): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

type Handler = (m: string[], b: Record<string, any>, url: URL) => Promise<unknown> | unknown;
const routes: Array<[string, RegExp, Handler]> = [
  ['GET', /^\/api\/state$/, () => state()],
  ['GET', /^\/api\/setup$/, async () => ({ text: await doctor() })],
  ['POST', /^\/api\/config$/, (_m, b) => ({ warnings: setConfig(b) })],

  ['GET', /^\/api\/calls$/, () => listCalls().map(callItem)],
  ['POST', /^\/api\/calls$/, async (_m, b) => {
    const url = str(b.url);
    if (!url) throw new HttpError(400, 'the meeting link is missing');
    const act = ['after', 'during', 'both'].includes(b.act) ? b.act as ActMode : undefined;
    const autonomy = ['suggest', 'issues', 'prs'].includes(b.autonomy) ? b.autonomy as Autonomy : undefined;
    const outputs: Partial<Record<OutputKind, string | null>> = {};
    for (const k of OUTPUT_KINDS) if (typeof b[k] === 'string' && b[k]) outputs[k] = b[k];
    const repo = str(b.repo, 200);
    try {
      const call = await joinMeeting(url, {
        title: str(b.title, 200) || undefined, act, autonomy, outputs, repos: repo ? [repo] : [],
        workdir: validWorkdir(str(b.workdir)) ?? validWorkdir(config.uiWorkdir),
      });
      return callDetail(call);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }],
  ['GET', /^\/api\/calls\/([a-z0-9-]+)$/, (m) => callDetail(mustCall(m[1]!))],

  // A huddle: a meeting in this UI (the page records and uploads; see sources/huddle.ts).
  ['POST', /^\/api\/huddles$/, (_m, b) => {
    const act = ['after', 'during', 'both'].includes(b.act) ? b.act as ActMode : undefined;
    const autonomy = ['suggest', 'issues', 'prs'].includes(b.autonomy) ? b.autonomy as Autonomy : undefined;
    const outputs: Partial<Record<OutputKind, string | null>> = {};
    for (const k of OUTPUT_KINDS) if (typeof b[k] === 'string' && b[k]) outputs[k] = b[k];
    const repo = str(b.repo, 200);
    const spoken = /^[a-z]{2}$/.test(str(b.spoken, 5)) ? str(b.spoken, 5) : null;
    const call = startHuddle({
      title: str(b.title, 200) || undefined, act, autonomy, outputs, repos: repo ? [repo] : [],
      workdir: validWorkdir(str(b.workdir)) ?? validWorkdir(config.uiWorkdir), speaker: str(b.speaker, 60), spokenLanguage: spoken,
    });
    watchHuddle(call.id);
    return callDetail(call);
  }],
  ['POST', /^\/api\/huddles\/([a-z0-9-]+)\/ask$/, (m, b) => {
    const text = str(b.text, 4000);
    if (!text) throw new HttpError(400, 'nothing to ask');
    askInHuddle(m[1]!, text);
    return { ok: true };
  }],
  ['POST', /^\/api\/huddles\/([a-z0-9-]+)\/speaking$/, (m, b) => { markSpeaking(m[1]!, Number(b.start), Number(b.end)); return { ok: true }; }],
  ['POST', /^\/api\/huddles\/([a-z0-9-]+)\/end$/, async (m) => {
    await endHuddle(m[1]!, 'manual', notifyHuddle);
    return callDetail(mustCall(m[1]!));
  }],
  ['PATCH', /^\/api\/calls\/([a-z0-9-]+)$/, (m, b) => {
    const c = mustCall(m[1]!);
    const patch: Partial<Call> = {};
    if (['after', 'during', 'both'].includes(b.act)) patch.act = b.act;
    if (['suggest', 'issues', 'prs'].includes(b.autonomy)) patch.autonomy = b.autonomy;
    if (str(b.title)) patch.title = str(b.title, 200);
    return callDetail(updateCall(c.id, patch));
  }],
  ['POST', /^\/api\/calls\/([a-z0-9-]+)\/end$/, async (m) => {
    try { return callDetail(await endMeeting(mustCall(m[1]!).id)); } catch (e) { throw new HttpError(400, (e as Error).message); }
  }],
  ['POST', /^\/api\/calls\/([a-z0-9-]+)\/cancel$/, async (m) => callDetail(await cancelMeeting(mustCall(m[1]!).id))],
  ['POST', /^\/api\/calls\/([a-z0-9-]+)\/say$/, async (m, b) => {
    const c = mustCall(m[1]!);
    const text = str(b.text, 4000);
    if (!text) throw new HttpError(400, 'nothing to say');
    if (!isLiveSource(c) || !['joining', 'in_call'].includes(c.status)) throw new HttpError(400, 'The agent is not in this meeting.');
    return sayInMeeting(c.id, text, 6000);
  }],
  ['POST', /^\/api\/calls\/([a-z0-9-]+)\/deliver$/, async (m, b) => {
    const c = mustCall(m[1]!);
    const only = (OUTPUT_KINDS as readonly string[]).includes(b.only) ? b.only as OutputKind : undefined;
    try {
      const results = await deliverOutputs(c.id, { only });
      return { results, text: resultsText(results), detail: callDetail(mustCall(c.id)) };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }],

  ['GET', /^\/api\/chats$/, () => listChats()],
  ['POST', /^\/api\/chats$/, (_m, b) => createChat({ call_id: str(b.call_id) || null, workdir: str(b.workdir) || null, title: str(b.title, 120) })],
  ['GET', /^\/api\/chats\/([a-z0-9-]+)$/, (m) => {
    const c = getChat(m[1]!);
    if (!c) throw new HttpError(404, 'chat not found');
    return { ...c, running: isRunning(c.id) };
  }],
  ['PATCH', /^\/api\/chats\/([a-z0-9-]+)$/, (m, b) => updateChat(m[1]!, {
    title: typeof b.title === 'string' ? b.title : undefined,
    workdir: typeof b.workdir === 'string' ? b.workdir : undefined,
    call_id: b.call_id === null || typeof b.call_id === 'string' ? (b.call_id || null) : undefined,
  })],
  ['DELETE', /^\/api\/chats\/([a-z0-9-]+)$/, (m) => { deleteChat(m[1]!); return { ok: true }; }],
  ['POST', /^\/api\/chats\/([a-z0-9-]+)\/messages$/, (m, b) => {
    const text = str(b.text, 100_000);
    if (!text) throw new HttpError(400, 'empty message');
    return sendMessage(m[1]!, text);
  }],
  ['POST', /^\/api\/chats\/([a-z0-9-]+)\/stop$/, (m) => ({ stopped: stopChat(m[1]!) })],
  ['POST', /^\/api\/chats\/([a-z0-9-]+)\/permissions\/([A-Za-z0-9_-]+)$/, (m, b) => { answerPermission(m[1]!, m[2]!, b.allow === true); return { ok: true }; }],
];

// ── Events (server-sent) ────────────────────────────────────────────────────

const clients = new Set<http.ServerResponse>();
function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
chatEvents.on('chat', (e) => broadcast('chat', e));
/** A huddle's news for its page: a turn transcribed, an answer to read aloud, asked to stop. */
function notifyHuddle(id: string, e: Record<string, unknown>) {
  broadcast('huddle', { id, ...e });
  broadcast('call', { id });
}

/** What changed on disk: the call list, and each call (status, plan, live lines). */
const sigs = new Map<string, string>();
let listSig = '';
function mtime(f: string): number { try { return statSync(f).mtimeMs; } catch { return 0; } }
function size(f: string): number { try { return statSync(f).size; } catch { return 0; } }
function poll() {
  if (!clients.size) return;
  const calls = listCalls();
  const ls = calls.map((c) => `${c.id}:${c.status}:${c.title}`).join('|');
  if (ls !== listSig) { listSig = ls; broadcast('calls', calls.map(callItem)); }
  for (const c of calls.slice(0, 50)) {
    const p = callPaths(c.id);
    const s = `${c.updated_at}:${mtime(p.plan)}:${mtime(p.transcript)}:${size(path.join(p.bot, 'live.jsonl'))}:${mtime(path.join(p.bot, 'status.json'))}`;
    const prev = sigs.get(c.id);
    sigs.set(c.id, s);
    if (prev !== undefined && prev !== s) broadcast('call', { id: c.id });
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

export interface UiServer { url: string; port: number; close(): Promise<void> }

export async function startUi(o: { port?: number } = {}): Promise<UiServer> {
  const dir = uiDir();
  const token = randomBytes(18).toString('hex');
  const tokenBuf = Buffer.from(token);
  let port = o.port ?? config.uiPort;
  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const tokenOk = (t: string | null) => !!t && t.length === token.length && timingSafeEqual(Buffer.from(t), tokenBuf);

  const server = http.createServer(async (req, res) => {
    try {
      if (!hosts().has(req.headers.host ?? '')) throw new HttpError(403, 'forbidden host');
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const p = url.pathname;
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');

      if (req.method === 'GET' && STATIC[p]) {
        const f = path.join(dir, STATIC[p]!);
        if (!existsSync(f)) throw new HttpError(404, 'not found');
        const type = TYPES[path.extname(f)] ?? 'application/octet-stream';
        let content = readFileSync(f);
        if (f.endsWith('index.html')) content = Buffer.from(content.toString('utf8').replace('__OMA_TOKEN__', token));
        res.writeHead(200, {
          'content-type': type, 'cache-control': 'no-store', 'x-frame-options': 'DENY',
          ...(f.endsWith('.html') ? { 'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" } : {}),
        });
        res.end(content);
        return;
      }
      if (p === '/api/ping') return json(res, 200, { app: 'oma-ui' });
      if (!p.startsWith('/api/')) throw new HttpError(404, 'not found');
      if (!tokenOk(req.headers['x-oma-token'] as string ?? url.searchParams.get('t'))) throw new HttpError(403, 'missing or wrong token: reload the page');

      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('event: hello\ndata: {}\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      // A huddle's uploads: binary, from its page.
      const up = /^\/api\/huddles\/([a-z0-9-]+)\/(media|audio|screen)$/.exec(p);
      if (req.method === 'POST' && up) {
        const type = req.headers['content-type'] ?? '';
        if (!/^(application\/octet-stream|image\/jpeg)/.test(type)) throw new HttpError(415, 'binary only');
        const id = up[1]!;
        const kind = up[2]!;
        const data = await rawBody(req, kind === 'media' ? 64_000_000 : kind === 'screen' ? 8_000_000 : 4_000_000);
        if (kind === 'media') {
          const q = url.searchParams;
          return json(res, 200, addMedia(id, { part: Number(q.get('part')), seq: Number(q.get('seq')), ext: q.get('ext') ?? 'webm', started: Number(q.get('started')) }, data));
        }
        if (kind === 'audio') addAudio(id, data); else setScreen(id, data);
        return json(res, 200, { ok: true });
      }
      const frame = /^\/api\/calls\/([a-z0-9-]+)\/frames\/(F\d+)$/.exec(p);
      if (req.method === 'GET' && frame) {
        const f = getFrames(mustCall(frame[1]!).id).find((x) => x.label === frame[2]);
        if (!f || !existsSync(f.file)) throw new HttpError(404, 'no such frame');
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' });
        createReadStream(f.file).pipe(res);
        return;
      }
      for (const [method, re, h] of routes) {
        const m = re.exec(p);
        if (!m || method !== req.method) continue;
        if ((method === 'POST' || method === 'PATCH') && !(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'JSON only');
        const b = method === 'GET' ? {} : await body(req);
        return json(res, 200, await h(m, b, url));
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      const status = e instanceof HttpError || e instanceof HuddleError ? e.status : (e as { status?: number }).status ?? 500;
      if (!res.headersSent) json(res, status, { error: (e as Error).message });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  port = (server.address() as { port: number }).port;
  const timer = setInterval(poll, 1500);
  adoptHuddles();
  const huddles = setInterval(() => huddleTick(notifyHuddle), 500);
  const keepAlive = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20_000);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((resolve) => {
      clearInterval(timer);
      clearInterval(huddles);
      clearInterval(keepAlive);
      stopAll();
      for (const c of clients) c.end();
      clients.clear();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
