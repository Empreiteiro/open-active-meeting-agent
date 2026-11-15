// The bot ↔ host contract, through files in OUT_DIR (the container's volume):
//   status.json   { state: starting|joining|in_call|leaving|done|failed, step, error, participants, updated_at }
//   control.json  written by the host: { leave: true } → leave and save; { discard: true } → leave, save nothing
//   audio.m4a / recording.mp4 / timeline.json / exit.json   the result, written at the end
// While in the call (the agent acting in the meeting):
//   live.jsonl     appended by the bot, one JSON event per line:
//                    {type:"caption", seg, speaker, text, final, at}   a turn (non-final ones are replaced by the next with the same seg)
//                    {type:"chat", speaker, text, at}                  a chat message from someone else
//                    {type:"sent", id, ok, text?, error?, at}          the result of a host command
//                    {type:"live", captions, chat, at}                 what the bot can read and post
//   commands.jsonl appended by the host: {id, type:"chat", text}; the bot runs each one once, in order

import { appendFileSync, chownSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

type State = 'starting' | 'joining' | 'in_call' | 'leaving' | 'done' | 'failed';

let last: Record<string, unknown> = {};

function writeOut(name: string, value: unknown): void {
  mkdirSync(config.outDir, { recursive: true });
  const file = path.join(config.outDir, name);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

export function setStatus(state: State, extra: Record<string, unknown> = {}): void {
  last = { ...last, ...extra, state, updated_at: new Date().toISOString() };
  try {
    writeOut('status.json', last);
  } catch (e) {
    log.error({ error: (e as Error).message }, 'could not write status.json');
  }
}

export async function markJoining(): Promise<void> {
  setStatus('joining');
}

export async function markInCall(): Promise<void> {
  setStatus('in_call');
}

/** Liveness while in the call, with the participant count. */
export async function heartbeat(participants?: number): Promise<void> {
  setStatus((last.state as State) ?? 'in_call', { participants: participants ?? null });
}

function control(): { leave?: boolean; discard?: boolean } {
  const file = path.join(config.outDir, 'control.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { leave?: boolean; discard?: boolean };
  } catch {
    return {};
  }
}

/** The host asked the bot to leave (end of the call, or cancel). */
export async function shouldLeave(): Promise<boolean> {
  return control().leave === true;
}

export function shouldDiscard(): boolean {
  return control().discard === true;
}

/** One event in live.jsonl (best-effort: a failed write never stops the call). */
export function appendLive(event: Record<string, unknown>): void {
  try {
    mkdirSync(config.outDir, { recursive: true });
    appendFileSync(path.join(config.outDir, 'live.jsonl'), `${JSON.stringify({ ...event, at: event.at ?? Date.now() })}\n`);
  } catch (e) {
    log.warn({ error: (e as Error).message }, 'could not write live.jsonl');
  }
}

export interface HostCommand { id: string; type: 'chat'; text: string }

/** The host's commands after the first `skip` (commands.jsonl, append-only). */
export function readCommands(skip: number): HostCommand[] {
  const file = path.join(config.outDir, 'commands.jsonl');
  if (!existsSync(file)) return [];
  const out: HostCommand[] = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  // A line still being written (no newline yet) waits for the next read.
  const complete = lines.slice(0, -1);
  for (const ln of complete.slice(skip)) {
    try {
      const c = JSON.parse(ln) as Partial<HostCommand>;
      out.push({ id: String(c.id ?? ''), type: 'chat', text: String(c.text ?? '') });
    } catch {
      out.push({ id: '', type: 'chat', text: '' }); // unreadable: counted, skipped
    }
  }
  return out;
}

export async function markFailed(step: string, message: string): Promise<void> {
  log.error({ step, message }, 'bot failed');
  setStatus('failed', { step, error: message.slice(0, 1000) });
}

/** How and why the bot left the call (exit.json). */
export interface ExitInfo {
  reason: string;
  detail?: string;
  inCallSec?: number;
  recordedSec?: number;
  sawOthers?: boolean;
  evidence?: string;
}

/** Leave the recording and the speaker timeline in OUT_DIR, then say "done". */
export async function uploadAndHandoff(
  audioPath: string,
  speakerTimelineJson: string,
  videoPath?: string | null,
  exitInfo?: ExitInfo,
): Promise<void> {
  if (shouldDiscard()) {
    log.info('discard requested: the recording is not kept');
    setStatus('done', { discarded: true });
    return;
  }
  mkdirSync(config.outDir, { recursive: true });
  copyFileSync(audioPath, path.join(config.outDir, 'audio.m4a'));
  if (videoPath && existsSync(videoPath)) copyFileSync(videoPath, path.join(config.outDir, 'recording.mp4'));
  writeFileSync(path.join(config.outDir, 'timeline.json'), speakerTimelineJson);
  if (exitInfo) writeOut('exit.json', exitInfo);
  setStatus('done');
  giveBackOwnership();
  log.info({ withVideo: !!videoPath }, 'recording handed back');
}

/** A logged-in session after joining: kept so the next meeting skips the login. */
export async function reportBotAuth(r: { storageState?: unknown; error?: string }): Promise<void> {
  if (!r.storageState || !process.env.BOT_SAVE_AUTH) return;
  try {
    writeOut('storage-state.json', r.storageState);
  } catch {}
}

/** The container runs as root: on Linux hosts the files would belong to root.
 *  Hand them to whoever owns the mounted folder (no-op where it is root). */
function giveBackOwnership(): void {
  try {
    const { uid, gid } = statSync(config.outDir);
    if (uid === 0) return;
    for (const f of readdirSync(config.outDir)) chownSync(path.join(config.outDir, f), uid, gid);
  } catch {}
}
