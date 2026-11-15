// The bot: a container (Docker or Podman) with Chromium that joins the
// meeting as the agent, records the call and the shared screen, and reads who
// is speaking from the meeting UI. It talks to us only through its volume:
//   status.json   written by the bot (starting → joining → in_call → done | failed)
//   control.json  written by us ({ leave: true } ends the call, discard drops it)
//   audio.m4a, recording.mp4, timeline.json, exit.json   left by the bot at the end
//   live.jsonl     appended by the bot in the call: caption turns, chat messages, what it posted
//   commands.jsonl appended by us: {id, type: "chat", text} — the bot posts it in the meeting chat

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { callPaths, readJson, writeJson } from '../store.js';

export type Provider = 'google_meet' | 'microsoft_teams';

export function detectProvider(url: string): Provider | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.hostname === 'meet.google.com') return 'google_meet';
  if (/(^|\.)teams\.(microsoft|live)\.com$/.test(u.hostname)) return 'microsoft_teams';
  return null;
}

export interface BotStatus {
  state: 'starting' | 'joining' | 'in_call' | 'leaving' | 'done' | 'failed';
  step?: string;
  error?: string;
  participants?: number | null;
  updated_at?: string;
}

function exec(bin: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    p.on('close', (c) => resolve({ code: c ?? -1, out: out.trim(), err: err.trim() }));
  });
}

let engineCache: string | null = null;
export async function containerEngine(): Promise<string> {
  if (engineCache) return engineCache;
  const candidates = config.containerEngine ? [config.containerEngine] : ['docker', 'podman'];
  for (const c of candidates) {
    const r = await exec(c, ['version', '--format', '{{.Server.Version}}']);
    if (r.code === 0) return (engineCache = c);
  }
  throw new Error('No container engine is running (Docker Desktop, OrbStack, Colima or Podman). Start one, or set OMA_CONTAINER_ENGINE.');
}

export async function botImageReady(): Promise<boolean> {
  const engine = await containerEngine();
  return (await exec(engine, ['image', 'inspect', config.botImage])).code === 0;
}

/** Where the bot's build context lives: next to the bundle (dist/../bot) or the sources (src/sources/../../bot). */
export function botContextDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const c of [path.resolve(here, '..', 'bot'), path.resolve(here, '..', '..', 'bot')]) {
    if (existsSync(path.join(c, 'Dockerfile'))) return c;
  }
  return null;
}

export async function buildBotImage(onLine?: (l: string) => void): Promise<void> {
  const engine = await containerEngine();
  const ctx = botContextDir();
  if (!ctx) throw new Error('The bot sources (bot/Dockerfile) were not found next to this install.');
  await new Promise<void>((resolve, reject) => {
    const p = spawn(engine, ['build', '-t', config.botImage, ctx], { stdio: ['ignore', 'pipe', 'pipe'] });
    const relay = (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => onLine?.(l));
    p.stdout.on('data', relay);
    p.stderr.on('data', relay);
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`${engine} build exited ${c}`))));
  });
}

export const containerName = (callId: string) => `oma-bot-${callId}`;

export async function startBot(callId: string, a: { url: string; provider: Provider; displayName: string; live?: boolean }): Promise<string> {
  const engine = await containerEngine();
  if (!(await botImageReady())) {
    throw new Error(`The bot image ${config.botImage} is not built yet. Run \`oma bot build\` (or the build_bot tool) once — it takes a few minutes.`);
  }
  const dir = callPaths(callId).bot;
  mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'status.json'), { state: 'starting', updated_at: new Date().toISOString() } satisfies BotStatus);
  for (const f of ['control.json', 'live.jsonl', 'commands.jsonl']) rmSync(path.join(dir, f), { force: true });
  const auth = a.provider === 'google_meet' ? config.botAuthGoogle : config.botAuthTeams;
  const args = [
    'run', '-d', '--rm', '--name', containerName(callId), '--shm-size=1g',
    '-v', `${dir}:/out`,
    ...(auth && existsSync(auth) ? ['-v', `${path.resolve(auth)}:/auth/state.json:ro`, '-e', 'BOT_AUTH_PATH=/auth/state.json'] : []),
    '-e', `JOIN_URL=${a.url}`,
    '-e', `PROVIDER=${a.provider}`,
    '-e', `BOT_DISPLAY_NAME=${a.displayName}`,
    '-e', 'RECORD_VIDEO=1',
    '-e', 'OUT_DIR=/out',
    '-e', `BOT_LOCALE=${config.botLocale}`,
    '-e', `BOT_TIMEZONE=${config.botTimezone}`,
    '-e', `MAX_MEETING_MINUTES=${config.maxMeetingMinutes}`,
    ...(a.live ? ['-e', 'LIVE_CHAT=1'] : []),
    config.botImage,
  ];
  const r = await exec(engine, args);
  if (r.code !== 0) throw new Error(`${engine} run failed: ${r.err.slice(0, 400)}`);
  return containerName(callId);
}

export function botStatus(callId: string): BotStatus | null {
  return readJson<BotStatus>(path.join(callPaths(callId).bot, 'status.json'));
}

export async function containerRunning(callId: string): Promise<boolean> {
  const engine = await containerEngine().catch(() => null);
  if (!engine) return false;
  const r = await exec(engine, ['inspect', '-f', '{{.State.Running}}', containerName(callId)]);
  return r.code === 0 && r.out === 'true';
}

/** Ask the bot to leave: it stops recording and leaves its files. */
export function requestLeave(callId: string, discard = false): void {
  writeJson(path.join(callPaths(callId).bot, 'control.json'), { leave: true, discard, at: new Date().toISOString() });
}

export async function killBot(callId: string): Promise<void> {
  const engine = await containerEngine().catch(() => null);
  if (engine) await exec(engine, ['rm', '-f', containerName(callId)]);
}

/** One event the bot wrote to live.jsonl. */
export type LiveEvent =
  | { type: 'caption'; seg: string; speaker: string; text: string; final: boolean; at: number }
  | { type: 'chat'; speaker: string; text: string; at: number }
  | { type: 'sent'; id: string; ok: boolean; text?: string; error?: string; at: number }
  | { type: 'live'; captions: boolean; chat: boolean; at: number };

export function readLiveEvents(callId: string): LiveEvent[] {
  const file = path.join(callPaths(callId).bot, 'live.jsonl');
  if (!existsSync(file)) return [];
  const out: LiveEvent[] = [];
  for (const ln of readFileSync(file, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    try { out.push(JSON.parse(ln) as LiveEvent); } catch { /* a line being written */ }
  }
  return out;
}

/** Ask the bot to post a message in the meeting chat. Returns the command id
 *  (its result comes back as a "sent" event in live.jsonl). */
export function sendBotCommand(callId: string, text: string): string {
  const id = `k${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const dir = callPaths(callId).bot;
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, 'commands.jsonl'), `${JSON.stringify({ id, type: 'chat', text, at: new Date().toISOString() })}\n`);
  return id;
}

export function botOutputs(callId: string): { audio: string | null; video: string | null; timeline: string | null; exit: Record<string, unknown> | null } {
  const dir = callPaths(callId).bot;
  const f = (n: string) => (existsSync(path.join(dir, n)) ? path.join(dir, n) : null);
  return { audio: f('audio.m4a'), video: f('recording.mp4'), timeline: f('timeline.json'), exit: readJson(path.join(dir, 'exit.json')) };
}
