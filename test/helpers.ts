// Test helpers: a temp home, an ffmpeg-made "meeting" video, small fake servers.

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export function tempDir(prefix = 'oma-test-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A 12 s "screen share": three different screens (4 s each) with a tone. */
export function makeMeetingVideo(file: string): string {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=4',
    '-f', 'lavfi', '-i', 'testsrc=s=640x360:d=4',
    '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
  ]);
  return file;
}

export interface FakeServer { url: string; requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: string }>; close(): Promise<void> }

export async function fakeServer(handler: (req: { method: string; path: string; body: string; n: number }) => { status?: number; json: unknown }): Promise<FakeServer> {
  const requests: FakeServer['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      const out = handler({ method: req.method ?? '', path: req.url ?? '', body, n: requests.length });
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

/** An OpenAI-compatible transcription answer covering the 12 s video. */
export const ASR_SEGMENTS = {
  text: 'x',
  segments: [
    { start: 0.2, end: 3.5, text: 'This is the board, the due date disappears on long titles.' },
    { start: 4.2, end: 7.8, text: 'Here in the settings I want a filter by due date.' },
    { start: 8.3, end: 11.6, text: 'And this blue screen should show the overdue tasks first.' },
  ],
};

export async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 60_000): Promise<T> {
  const until = Date.now() + ms;
  let last: T = await fn();
  while (!ok(last)) {
    if (Date.now() > until) throw new Error(`timed out; last value: ${JSON.stringify(last).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 300));
    last = await fn();
  }
  return last;
}
