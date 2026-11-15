// ffmpeg helpers: duration, audio for the ASR, and the screen frames — the
// moments the shared screen changed, spread over the call.

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { Frame } from '../types.js';

/** One sampled frame every N seconds goes into the change detection. */
const SAMPLE_EVERY_SEC = 2;
const FRAME_WIDTH = 1280;
const FFMPEG_TIMEOUT_MS = 10 * 60_000;

export function run(bin: string, args: string[], label: string, timeoutMs = FFMPEG_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new Error(`${label}: ${(e as Error).message}`));
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { out += d.toString(); if (out.length > 8_000_000) out = out.slice(-4_000_000); });
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 8_000_000) err = err.slice(-4_000_000); });
    p.on('close', (c) => {
      clearTimeout(timer);
      if (c === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${label}: ${err.slice(-600) || `exit ${c}`}`));
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${label}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? `${bin} not found (install it or set its path)` : e.message}`));
    });
  });
}

export async function probe(file: string): Promise<{ duration: number; hasVideo: boolean; hasAudio: boolean }> {
  const { stdout } = await run(config.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], 'ffprobe');
  const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
  const types = new Set((j.streams ?? []).map((s) => s.codec_type));
  return { duration: Number(j.format?.duration) || 0, hasVideo: types.has('video'), hasAudio: types.has('audio') };
}

/** Mono 16 kHz WAV: what whisper.cpp reads, and small enough for the APIs. */
export async function toWav16k(input: string, out: string, from?: number, length?: number): Promise<string> {
  mkdirSync(path.dirname(out), { recursive: true });
  const cut = [...(from != null ? ['-ss', from.toFixed(2)] : []), ...(length != null ? ['-t', length.toFixed(2)] : [])];
  await run(config.ffmpeg, ['-hide_banner', '-nostats', '-y', ...cut, '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], 'audio');
  return out;
}

/** The instants (s) the screen changed. Decided on a 320 px copy: the cursor
 *  and a typed letter don't count; a new screen, a modal or a slide does. The
 *  first frame always stays. */
export async function changedInstants(video: string): Promise<{ times: number[]; width: number | null; height: number | null }> {
  const filter = [
    `fps=1/${SAMPLE_EVERY_SEC}`,
    'scale=320:-2',
    // A block of 8x8 with mean difference > 48 per pixel, or 8% of blocks > 10.
    `mpdecimate=hi=${64 * 48}:lo=${64 * 10}:frac=0.08`,
    'showinfo',
  ].join(',');
  const { stderr } = await run(config.ffmpeg, ['-hide_banner', '-nostats', '-i', video, '-an', '-vf', filter, '-f', 'null', '-'], 'frames');
  const dim = stderr.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  const raw: number[] = [];
  for (const m of stderr.matchAll(/\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:(-?[\d.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) raw.push(t);
  }
  const t0 = raw.length ? raw[0]! : 0;
  return { times: raw.map((t) => Math.max(0, t - t0)), width: dim ? Number(dim[1]) : null, height: dim ? Number(dim[2]) : null };
}

/** Up to `max` items spread over the list (the first and the last stay). */
export function spread<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  if (max <= 1) return list.slice(0, max);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(list[Math.round((i * (list.length - 1)) / (max - 1))]!);
  return [...new Set(out)];
}

/** Extract the frames of a video into `dir` (F1.jpg…), replacing earlier ones.
 *  `offset` shifts the times onto the transcript's timeline. */
export async function extractFrames(video: string, dir: string, opts: { max?: number; offset?: number } = {}): Promise<Frame[]> {
  const found = await changedInstants(video);
  const chosen = spread(found.times, opts.max ?? config.maxFrames);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames: Frame[] = [];
  for (const t of chosen) {
    const label = `F${frames.length + 1}`;
    const file = path.join(dir, `${label}.jpg`);
    try {
      await run(config.ffmpeg, [
        '-hide_banner', '-nostats', '-ss', t.toFixed(2), '-i', video, '-frames:v', '1',
        '-vf', `scale='min(${FRAME_WIDTH},iw)':-2`, '-q:v', '4', '-y', file,
      ], 'frame');
      if (statSync(file).size > 0) frames.push({ label, t: Math.round((t + (opts.offset ?? 0)) * 10) / 10, file });
    } catch {}
  }
  // A frame that failed leaves no gap: the next one took its label. Drop any
  // leftover file that isn't one of the kept frames.
  const files = new Set(frames.map((f) => path.basename(f.file)));
  for (const f of readdirSync(dir)) if (!files.has(f)) rmSync(path.join(dir, f), { force: true });
  return frames;
}
