// Calls live on disk, one folder each:
//   <home>/calls/<id>/call.json        the call (status, source, autonomy…)
//   <home>/calls/<id>/transcript.json  segments with speaker names
//   <home>/calls/<id>/frames.json      the screen frames kept (F1…), files in frames/
//   <home>/calls/<id>/plan.json        the plan and the state of each task
//   <home>/calls/<id>/bot/             the bot's volume (status, control, audio, video, timeline)
//   <home>/calls/<id>/log.txt          what happened, for people

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { Call, Frame, Plan, Segment } from './types.js';

export function callDir(id: string): string {
  if (!/^[a-z0-9-]{6,64}$/.test(id)) throw new Error(`invalid call id: ${id}`);
  return path.join(config.callsDir, id);
}

export const callPaths = (id: string) => {
  const dir = callDir(id);
  return {
    dir,
    call: path.join(dir, 'call.json'),
    transcript: path.join(dir, 'transcript.json'),
    frames: path.join(dir, 'frames.json'),
    framesDir: path.join(dir, 'frames'),
    plan: path.join(dir, 'plan.json'),
    bot: path.join(dir, 'bot'),
    media: path.join(dir, 'media'),
    log: path.join(dir, 'log.txt'),
    lock: path.join(dir, 'processing.lock'),
  };
};

export function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Write through a temp file + rename, so a reader never sees half a file. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

export function newCallId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${randomBytes(3).toString('hex')}`;
}

export function createCall(c: Omit<Call, 'id' | 'created_at' | 'updated_at' | 'notes'> & { id?: string }): Call {
  const now = new Date().toISOString();
  const call: Call = { ...c, id: c.id ?? newCallId(), created_at: now, updated_at: now, notes: [] };
  const p = callPaths(call.id);
  mkdirSync(p.dir, { recursive: true });
  writeJson(p.call, call);
  logCall(call.id, `call created (${call.source}): ${call.title}`);
  return call;
}

export function getCall(id: string): Call | null {
  try {
    return readJson<Call>(callPaths(id).call);
  } catch {
    return null;
  }
}

export function mustGetCall(id: string): Call {
  const c = getCall(id);
  if (!c) throw new Error(`call not found: ${id}`);
  return c;
}

export function updateCall(id: string, patch: Partial<Call>): Call {
  const cur = mustGetCall(id);
  const next: Call = { ...cur, ...patch, id: cur.id, updated_at: new Date().toISOString() };
  writeJson(callPaths(id).call, next);
  if (patch.status && patch.status !== cur.status) logCall(id, `status ${cur.status} → ${patch.status}${patch.error ? ` (${patch.error})` : ''}`);
  return next;
}

export function listCalls(): Call[] {
  if (!existsSync(config.callsDir)) return [];
  return readdirSync(config.callsDir)
    .map((id) => { try { return getCall(id); } catch { return null; } })
    .filter((c): c is Call => !!c)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** The latest call, for tools called without an id. */
export function latestCall(): Call | null {
  return listCalls()[0] ?? null;
}

export function deleteCall(id: string): void {
  rmSync(callDir(id), { recursive: true, force: true });
}

export function logCall(id: string, line: string): void {
  try {
    appendFileSync(callPaths(id).log, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

export const getTranscript = (id: string) => readJson<Segment[]>(callPaths(id).transcript);
export const saveTranscript = (id: string, segs: Segment[]) => writeJson(callPaths(id).transcript, segs);
export const getFrames = (id: string) => readJson<Frame[]>(callPaths(id).frames) ?? [];
export const saveFrames = (id: string, frames: Frame[]) => writeJson(callPaths(id).frames, frames);
export const getPlan = (id: string) => readJson<Plan>(callPaths(id).plan);
export const savePlan = (id: string, plan: Plan) => writeJson(callPaths(id).plan, plan);

/** A lock for the work on one call that must not run twice (processing). A
 *  lock whose process is gone is taken over. */
export function tryLock(id: string): boolean {
  const file = callPaths(id).lock;
  const held = readJson<{ pid: number }>(file);
  if (held && held.pid !== process.pid && pidAlive(held.pid)) return false;
  writeJson(file, { pid: process.pid, at: new Date().toISOString() });
  return true;
}

export function unlock(id: string): void {
  const file = callPaths(id).lock;
  const held = readJson<{ pid: number }>(file);
  if (held?.pid === process.pid) rmSync(file, { force: true });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
