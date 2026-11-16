// A huddle: a meeting held in the web UI itself. You share your screen and talk
// in the browser; the agent hears you (a live transcript, whisper on the
// microphone a few seconds at a time), sees the screen, and answers there —
// written, and read aloud by the page. Only you and the agent.
//
// The browser records; the UI server plays the bot's part and writes the same
// files the bot writes, so the worker, the live loop (live.ts) and the
// processing after the call work as for a bot call:
//   bot/status.json   in_call → done (+ `at`: the last sign of life)
//   bot/live.jsonl    caption turns (what you said), chat (what you typed), sent (the agent's answers)
//   bot/commands.jsonl  the agent's answers to show — marked "sent" here and pushed to the page
//   bot/control.json  end_meeting / cancel_meeting: the page is told to stop
// and its own:
//   bot/huddle.json   who talks, the recording parts, when the page read an answer aloud
//   bot/rec-<n>.<ext> the recording (screen + microphone), one part per capture in a tab
//   bot/live.pcm      the microphone, 16 kHz mono s16le, for the live transcript
//   bot/live-asr.json how much of live.pcm was transcribed
//   bot/screen.jpg    the shared screen, a few seconds old at most

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NOISE_TEXT, transcribe } from '../asr/index.js';
import { config } from '../config.js';
import { probe, run } from '../media/ffmpeg.js';
import { callPaths, getCall, listCalls, logCall, readJson, writeJson } from '../store.js';
import { readLiveEvents } from './bot.js';

export interface HuddleMeta {
  speaker: string;
  parts: Array<{ part: number; ext: string; started_ms: number; bytes: number; next_seq: number }>;
  /** When the page read an answer aloud (its voice is in the recording). */
  speaking: Array<{ start_ms: number; end_ms: number }>;
}

const RATE = 16_000;
const BYTES_PER_SEC = RATE * 2;
const FRAME = 320; // 20 ms
/** No upload for this long: the page is gone, the huddle ends. */
const IDLE_END_MS = 3 * 60_000;
/** The worker's view: no sign of life for this long, the huddle is over. */
const ALIVE_MS = 4 * 60_000;

const bot = (id: string) => callPaths(id).bot;
const file = (id: string, name: string) => path.join(bot(id), name);
export const readMeta = (id: string): HuddleMeta | null => readJson<HuddleMeta>(file(id, 'huddle.json'));
const writeMeta = (id: string, m: HuddleMeta) => writeJson(file(id, 'huddle.json'), m);

function appendLive(id: string, e: Record<string, unknown>): void {
  appendFileSync(file(id, 'live.jsonl'), `${JSON.stringify({ at: Date.now(), ...e })}\n`);
}
function writeStatus(id: string, state: 'in_call' | 'done', extra: Record<string, unknown> = {}): void {
  writeJson(file(id, 'status.json'), { state, at: Date.now(), ...extra });
}

/** Set up a new huddle's folder (the call exists, status in_call). */
export function initHuddle(id: string, speaker: string, transcribing: boolean): void {
  mkdirSync(bot(id), { recursive: true });
  writeMeta(id, { speaker, parts: [], speaking: [] });
  writeStatus(id, 'in_call');
  appendLive(id, { type: 'live', captions: transcribing, chat: true });
}

/** For the worker: the page or the UI server still there. */
export function huddleAlive(id: string): boolean {
  const st = readJson<{ state: string; at?: number }>(file(id, 'status.json'));
  return !!st && st.state === 'in_call' && Date.now() - (st.at ?? 0) < ALIVE_MS;
}

export function huddleHasRecording(id: string): boolean {
  return (readMeta(id)?.parts ?? []).some((p) => p.bytes > 0);
}

/** The latest screen (for an answer), if it is recent. */
export function huddleScreen(id: string, maxAgeMs = 60_000): string | null {
  const f = file(id, 'screen.jpg');
  try { return Date.now() - statSync(f).mtimeMs < maxAgeMs ? f : null; } catch { return null; }
}

// ── The UI server's side ────────────────────────────────────────────────────

export class HuddleError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type Notify = (id: string, e: Record<string, unknown>) => void;
interface Runtime { lastUpload: number; lastBeat: number; busy: boolean; leaveAt: number | null; told: boolean; ending: Promise<void> | null }
const runtimes = new Map<string, Runtime>();

function runtime(id: string): Runtime {
  let rt = runtimes.get(id);
  if (!rt) { rt = { lastUpload: Date.now(), lastBeat: 0, busy: false, leaveAt: null, told: false, ending: null }; runtimes.set(id, rt); }
  return rt;
}

/** The huddle still takes uploads: in progress, not asked to stop. */
function active(id: string): Runtime {
  const call = getCall(id);
  if (!call || call.source !== 'huddle') throw new HuddleError(404, 'no such huddle');
  const st = readJson<{ state: string }>(file(id, 'status.json'));
  if (call.status !== 'in_call' || st?.state !== 'in_call') throw new HuddleError(409, 'the huddle is over');
  const rt = runtime(id);
  if (rt.ending) throw new HuddleError(409, 'the huddle is ending');
  rt.lastUpload = Date.now();
  if (Date.now() - rt.lastBeat > 5_000) { rt.lastBeat = Date.now(); writeStatus(id, 'in_call'); }
  return rt;
}

/** A piece of the recording, in order (MediaRecorder's chunks, concatenated). */
export function addMedia(id: string, q: { part: number; seq: number; ext: string; started: number }, data: Buffer): { next: number } {
  active(id);
  if (!Number.isInteger(q.part) || q.part < 1 || q.part > 50) throw new HuddleError(400, 'bad part');
  const ext = /^(webm|mp4|ogg|mkv)$/.test(q.ext) ? q.ext : 'webm';
  const m = readMeta(id) ?? { speaker: 'Me', parts: [], speaking: [] };
  let p = m.parts.find((x) => x.part === q.part);
  if (!p) { p = { part: q.part, ext, started_ms: Number.isFinite(q.started) ? q.started : Date.now(), bytes: 0, next_seq: 0 }; m.parts.push(p); }
  if (q.seq < p.next_seq) return { next: p.next_seq }; // sent twice
  if (q.seq > p.next_seq) throw new HuddleError(409, `expected piece ${p.next_seq}`);
  appendFileSync(file(id, `rec-${p.part}.${p.ext}`), data);
  p.bytes += data.length;
  p.next_seq++;
  writeMeta(id, m);
  return { next: p.next_seq };
}

/** The microphone for the live transcript: 16 kHz mono s16le. */
export function addAudio(id: string, data: Buffer): void {
  active(id);
  appendFileSync(file(id, 'live.pcm'), data.length % 2 ? data.subarray(0, data.length - 1) : data);
}

export function setScreen(id: string, data: Buffer): void {
  active(id);
  const tmp = file(id, `screen.${process.pid}.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, file(id, 'screen.jpg'));
}

/** A question typed in the huddle: for the agent. */
export function askInHuddle(id: string, text: string): void {
  active(id);
  appendLive(id, { type: 'chat', speaker: readMeta(id)?.speaker ?? 'Me', text: text.slice(0, 4000) });
}

export function markSpeaking(id: string, start: number, end: number): void {
  active(id);
  if (!(end > start) || end - start > 10 * 60_000) return;
  const m = readMeta(id);
  if (!m) return;
  m.speaking.push({ start_ms: start, end_ms: end });
  writeMeta(id, m);
}

/** The huddle ends: what is left of the microphone is transcribed, then done. */
export function endHuddle(id: string, reason: string, notify?: Notify): Promise<void> {
  const call = getCall(id);
  if (!call || call.source !== 'huddle') return Promise.reject(new HuddleError(404, 'no such huddle'));
  const rt = runtime(id);
  rt.ending ??= (async () => {
    try {
      while (rt.busy) await new Promise((r) => setTimeout(r, 100));
      if (call.status === 'in_call' && existsSync(bot(id))) {
        await transcribeStep(id, rt, notify, true).catch((e) => logCall(id, `huddle: live transcript: ${(e as Error).message}`));
        consumeCommands(id, notify);
        const joined = Date.parse(call.joined_at ?? call.created_at);
        writeJson(file(id, 'exit.json'), { reason, inCallSec: Math.round((Date.now() - joined) / 1000), sawOthers: false });
        writeStatus(id, 'done');
        logCall(id, `huddle ended (${reason})`);
      }
    } finally {
      runtimes.delete(id);
      notify?.(id, { type: 'ended', reason });
    }
  })();
  return rt.ending;
}

/** Called about twice a second by the UI server. */
export function huddleTick(notify: Notify): void {
  for (const [id, rt] of runtimes) {
    if (rt.ending) continue;
    const call = getCall(id);
    if (!call || call.status === 'cancelled' || !existsSync(bot(id))) {
      runtimes.delete(id);
      notify(id, { type: 'leave', discard: true });
      continue;
    }
    if (call.status !== 'in_call') { runtimes.delete(id); continue; }
    consumeCommands(id, notify);
    // end_meeting / cancel_meeting: tell the page; end it here if the page doesn't.
    const control = readJson<{ leave?: boolean; discard?: boolean }>(file(id, 'control.json'));
    if (control?.leave) {
      if (!rt.told) { rt.told = true; rt.leaveAt = Date.now(); notify(id, { type: 'leave', discard: !!control.discard }); }
      if (Date.now() - (rt.leaveAt ?? 0) > 15_000) { void endHuddle(id, 'manual', notify); continue; }
    }
    if (Date.now() - rt.lastUpload > IDLE_END_MS) { void endHuddle(id, 'disconnected', notify); continue; }
    if (!rt.busy) {
      rt.busy = true;
      transcribeStep(id, rt, notify, false)
        .catch((e) => logCall(id, `huddle: live transcript: ${(e as Error).message}`))
        .finally(() => { rt.busy = false; });
    }
  }
}

/** A new huddle: watched from the start (its answers, end_meeting, a page that never uploads). */
export function watchHuddle(id: string): void { runtime(id); }

/** Huddles in progress when the UI server starts: watched again (and ended if
 *  their page doesn't come back). */
export function adoptHuddles(): void {
  for (const c of listCalls()) if (c.source === 'huddle' && c.status === 'in_call') runtime(c.id);
}

/** The agent's answers: shown in the page (and "sent" for the live loop). */
function consumeCommands(id: string, notify?: Notify): void {
  const cf = file(id, 'commands.jsonl');
  if (!existsSync(cf)) return;
  const sent = new Set(readLiveEvents(id).filter((e) => e.type === 'sent').map((e) => (e as { id: string }).id));
  let raw: string;
  try { raw = readFileSync(cf, 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let cmd: { id?: string; text?: string };
    try { cmd = JSON.parse(line) as { id?: string; text?: string }; } catch { continue; }
    if (!cmd.id || sent.has(cmd.id)) continue;
    appendLive(id, { type: 'sent', id: cmd.id, ok: true, text: cmd.text ?? '' });
    sent.add(cmd.id);
    notify?.(id, { type: 'say', text: cmd.text ?? '' });
  }
}

// ── The live transcript ─────────────────────────────────────────────────────

/** Where to cut the microphone audio waiting to be transcribed: after a pause
 *  that follows speech (or at 20 s); silence alone is dropped (whisper makes
 *  things up on silence). */
export function findCut(samples: Int16Array, final: boolean): { from: number; to: number; speech: boolean } | null {
  const frames = Math.floor(samples.length / FRAME);
  if (!frames) return null;
  const rms: number[] = [];
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) s += samples[i]! * samples[i]!;
    rms.push(Math.sqrt(s / FRAME));
  }
  // Speech is louder than the room: 3× its noise floor, kept between 400 and
  // 1500 (a stretch that is almost all speech has no floor of its own).
  const sorted = [...rms].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const thresh = Math.min(1500, Math.max(400, floor * 3));
  const voiced = rms.map((r) => r > thresh);
  const first = voiced.indexOf(true);
  const secs = frames * FRAME / RATE;
  if (first < 0) {
    // Only silence: let it go, keeping the last half second (a word may start there).
    if (final) return { from: 0, to: frames * FRAME, speech: false };
    return secs >= 3 ? { from: 0, to: (frames - 25) * FRAME, speech: false } : null;
  }
  const voicedCount = voiced.filter(Boolean).length;
  const from = Math.max(0, first - 15) * FRAME;
  // A pause of 0.7 s after the speech ends a turn.
  let run = 0;
  for (let f = first + 1; f < frames; f++) {
    run = voiced[f] ? 0 : run + 1;
    if (run >= 35) {
      const to = (f - run + 1 + 12) * FRAME;
      return { from, to, speech: voicedCount >= 15 };
    }
  }
  if (final || secs >= 20) return { from, to: frames * FRAME, speech: voicedCount >= 15 };
  return null;
}

function readPcm(f: string, from: number, max: number): Int16Array {
  const size = statSync(f).size;
  const len = Math.min(size - from, max) & ~1;
  if (len <= 0) return new Int16Array(0);
  const buf = Buffer.alloc(len);
  const fd = openSync(f, 'r');
  try { readSync(fd, buf, 0, len, from); } finally { closeSync(fd); }
  return new Int16Array(buf.buffer, buf.byteOffset, len / 2);
}

function wav(samples: Int16Array): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(BYTES_PER_SEC, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function transcribeStep(id: string, _rt: Runtime, notify: Notify | undefined, final: boolean): Promise<void> {
  const pcm = file(id, 'live.pcm');
  if (config.asr === 'none' || !existsSync(pcm)) return;
  const stateFile = file(id, 'live-asr.json');
  // Several turns may be waiting (a slow transcription): take them one by one.
  for (let round = 0; round < 6; round++) {
    const st = readJson<{ offset: number; seg: number }>(stateFile) ?? { offset: 0, seg: 0 };
    const size = statSync(pcm).size;
    const pending = size - st.offset;
    if (pending < (final ? FRAME * 2 * 10 : BYTES_PER_SEC * 1.2)) return;
    const samples = readPcm(pcm, st.offset, 30 * BYTES_PER_SEC);
    const cut = findCut(samples, final || pending > 30 * BYTES_PER_SEC);
    if (!cut) return;
    if (cut.speech) {
      const dir = file(id, 'live-asr');
      mkdirSync(dir, { recursive: true });
      const input = path.join(dir, 'turn.wav');
      writeFileSync(input, wav(samples.subarray(cut.from, cut.to)));
      try {
        const call = getCall(id);
        const segs = await transcribe(input, dir, config.asrLanguage ?? call?.spoken_language ?? null);
        // A live turn is short: any of whisper's noise phrases alone is dropped.
        const text = segs.map((s) => s.text.trim()).filter((t) => t && !NOISE_TEXT.test(t)).join(' ').trim();
        if (text) {
          // When it was said: the audio waiting after this turn came in since.
          const at = Date.now() - Math.round(((size - st.offset) / 2 - cut.from) / RATE * 1000);
          appendLive(id, { type: 'caption', seg: `h${st.seg + 1}`, speaker: readMeta(id)?.speaker ?? 'Me', text, final: true, at });
          st.seg++;
          notify?.(id, { type: 'caption', text });
        }
      } finally {
        rmSync(input, { force: true });
      }
    }
    st.offset += cut.to * 2;
    if (!existsSync(bot(id))) return; // cancelled meanwhile: nothing to keep
    writeJson(stateFile, st);
  }
}

// ── After the huddle: one recording, and who spoke when ─────────────────────

/** The recording parts as one file (stream copy), and the timeline: you,
 *  except while the page read the agent's answers aloud. */
export async function huddleRecording(id: string, agentName: string): Promise<{ media: string | null; hasVideo: boolean; timeline: string | null }> {
  const m = readMeta(id);
  const parts = (m?.parts ?? []).filter((p) => p.bytes > 0).sort((a, b) => a.part - b.part);
  if (!m || !parts.length) return { media: null, hasVideo: false, timeline: null };
  const ready: Array<{ file: string; started: number; duration: number; hasVideo: boolean }> = [];
  for (const p of parts) {
    const src = file(id, `rec-${p.part}.${p.ext}`);
    const out = file(id, `part-${p.part}.mkv`);
    try {
      // MediaRecorder files have no duration or index: a copy into a fresh container gives them both.
      await run(config.ffmpeg, ['-hide_banner', '-nostats', '-y', '-i', src, '-c', 'copy', out], 'huddle remux');
      const info = await probe(out);
      ready.push({ file: out, started: p.started_ms, duration: info.duration, hasVideo: info.hasVideo });
    } catch (e) {
      logCall(id, `huddle: part ${p.part} unreadable: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  if (!ready.length) return { media: null, hasVideo: false, timeline: null };
  let media = ready[0]!.file;
  if (ready.length > 1) {
    const list = file(id, 'parts.txt');
    writeFileSync(list, ready.map((r) => `file '${r.file.replace(/'/g, "'\\''")}'`).join('\n'));
    const joined = file(id, 'recording.mkv');
    try {
      await run(config.ffmpeg, ['-hide_banner', '-nostats', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined], 'huddle concat');
      media = joined;
    } catch (e) {
      logCall(id, `huddle: parts not joined (${(e as Error).message.slice(0, 160)}): the longest one is used`);
      media = [...ready].sort((a, b) => b.duration - a.duration)[0]!.file;
      ready.splice(0, ready.length, ready.find((r) => r.file === media)!);
    }
  }
  // Who spoke when, on the recording's clock (the parts one after another).
  const entries: Array<{ name: string; start: number; end: number }> = [];
  let offset = 0;
  for (const r of ready) {
    const agent = m.speaking
      .filter((s) => s.end_ms > r.started && s.start_ms < r.started + r.duration * 1000)
      .map((s) => ({ start: Math.max(0, (s.start_ms - r.started) / 1000), end: Math.min(r.duration, (s.end_ms - r.started) / 1000) }))
      .sort((a, b) => a.start - b.start);
    let t = 0;
    for (const a of agent) {
      if (a.start > t) entries.push({ name: m.speaker, start: offset + t, end: offset + a.start });
      entries.push({ name: agentName, start: offset + a.start, end: offset + a.end });
      t = Math.max(t, a.end);
    }
    if (r.duration > t) entries.push({ name: m.speaker, start: offset + t, end: offset + r.duration });
    offset += r.duration;
  }
  const timeline = file(id, 'timeline.json');
  writeJson(timeline, {
    transcriptEntries: entries.map((e) => ({ participant: { displayName: e.name }, startTime: `${e.start.toFixed(3)}s`, endTime: `${e.end.toFixed(3)}s` })),
  });
  return { media, hasVideo: ready.some((r) => r.hasVideo), timeline };
}
