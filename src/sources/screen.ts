// Local screen capture, for meetings recorded on this machine (meetily, a file)
// where no bot watched the shared screen. One frame per second is enough: the
// plan only needs the moments the screen changed. The recording is matched to
// a meeting by time when the meeting is imported.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { readJson, writeJson } from '../store.js';

const dir = () => path.join(config.home, 'screen');
const current = () => path.join(dir(), 'current.json');

export interface ScreenRecording { file: string; started_at: string; ended_at: string | null; pid?: number }

function inputArgs(): string[] {
  const dev = process.env.OMA_SCREEN_DEVICE;
  if (process.platform === 'darwin') return ['-f', 'avfoundation', '-capture_cursor', '1', '-framerate', '10', '-i', `${dev || 'Capture screen 0'}:none`];
  if (process.platform === 'win32') return ['-f', 'gdigrab', '-framerate', '10', '-i', dev || 'desktop'];
  return ['-f', 'x11grab', '-framerate', '10', '-i', dev || process.env.DISPLAY || ':0'];
}

export function screenStatus(): ScreenRecording | null {
  const c = readJson<ScreenRecording>(current());
  if (!c?.pid) return null;
  try { process.kill(c.pid, 0); return c; } catch { return null; }
}

export function startScreenCapture(): ScreenRecording {
  const running = screenStatus();
  if (running) return running;
  mkdirSync(dir(), { recursive: true });
  const started = new Date();
  const file = path.join(dir(), `screen-${started.toISOString().replace(/[:.]/g, '-')}.mp4`);
  const log = openSync(`${file}.log`, 'a');
  // Detached: the capture outlives the MCP server (the meeting can be long).
  const p = spawn(config.ffmpeg, [
    '-hide_banner', '-nostats', '-y', ...inputArgs(),
    '-vf', 'scale=1280:-2', '-r', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', file,
  ], { detached: true, stdio: ['ignore', 'ignore', log] });
  p.unref();
  const rec: ScreenRecording = { file, started_at: started.toISOString(), ended_at: null, pid: p.pid };
  writeJson(current(), rec);
  writeJson(`${file}.json`, rec);
  return rec;
}

export async function stopScreenCapture(): Promise<ScreenRecording | null> {
  const rec = screenStatus();
  if (!rec?.pid) return null;
  // SIGINT makes ffmpeg finish the MP4 (moov atom) and exit.
  try { process.kill(rec.pid, 'SIGINT'); } catch {}
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { process.kill(rec.pid, 0); } catch { break; }
  }
  const done: ScreenRecording = { file: rec.file, started_at: rec.started_at, ended_at: new Date().toISOString() };
  writeJson(`${rec.file}.json`, done);
  writeJson(current(), done);
  return done;
}

/** The screen recording that overlaps [from, to] the most (ISO times). */
export function findScreenRecording(fromIso: string, toIso: string | null): { file: string; offset: number } | null {
  if (!existsSync(dir())) return null;
  const from = Date.parse(fromIso);
  const to = toIso ? Date.parse(toIso) : from + 3 * 3600_000;
  let best: { file: string; offset: number; ovl: number } | null = null;
  for (const f of readdirSync(dir()).filter((x) => x.endsWith('.mp4.json'))) {
    const rec = readJson<ScreenRecording>(path.join(dir(), f));
    if (!rec || !existsSync(rec.file) || statSync(rec.file).size < 1024) continue;
    const s = Date.parse(rec.started_at);
    const e = rec.ended_at ? Date.parse(rec.ended_at) : Date.now();
    const ovl = Math.min(e, to) - Math.max(s, from);
    if (ovl > 0 && (!best || ovl > best.ovl)) best = { file: rec.file, offset: (s - from) / 1000, ovl };
  }
  return best ? { file: best.file, offset: best.offset } : null;
}
