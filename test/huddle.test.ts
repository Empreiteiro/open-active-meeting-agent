// The huddle (a meeting in the web UI) through HTTP, the way its page uses it:
// the microphone for the live transcript, the recording in pieces, the screen,
// a typed question, the agent's answers back to the page, the end and the
// processing after it. A fake transcription API; no model (the agent says
// "noted"). Plus the pieces on their own: where a live turn is cut, whisper's
// noise.

import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { dropNoise } from '../src/asr/index.js';
import { findCut } from '../src/sources/huddle.js';
import { fakeServer, ROOT, tempDir, waitFor, type FakeServer } from './helpers.js';

const BUNDLE = path.join(ROOT, 'dist', 'oma.mjs');
let home: string;
let asr: FakeServer;
const servers: ChildProcess[] = [];
const SAID = 'Meeting Agent, what is on my screen?';

/** 16 kHz s16le: `voiced` seconds of a tone, then `quiet` seconds of silence. */
function pcm(voiced: number, quiet: number): Buffer {
  const n = Math.round((voiced + quiet) * 16000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < voiced * 16000; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 16000)), i * 2);
  return b;
}

before(async () => {
  home = tempDir('oma-huddle-');
  asr = await fakeServer(() => ({ json: { text: SAID, segments: [{ start: 0, end: 1.5, text: SAID }, { start: 1.5, end: 30, text: 'Thank you.' }] } }));
});

after(async () => {
  for (const p of servers) p.kill();
  await asr.close();
});

async function startUi() {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: path.join(home, 'user'),
    OMA_HOME: home,
    OMA_ASR: 'openai',
    OMA_ASR_BASE_URL: asr.url,
    OMA_ASR_API_KEY: 'test',
    OMA_CLAUDE_BIN: path.join(ROOT, 'test', 'fake-claude.mjs'),
  };
  mkdirSync(env.HOME!, { recursive: true });
  const p = spawn(process.execPath, ['--no-warnings', BUNDLE, 'ui', '--port', '0', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(p);
  let out = '';
  const base = await new Promise<string>((resolve, reject) => {
    p.stdout!.on('data', (d) => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) resolve(m[0]); });
    p.on('exit', (c) => reject(new Error(`ui exited ${c}: ${out}`)));
  });
  const token = (await (await fetch(`${base}/`)).text()).match(/name="oma-token" content="([0-9a-f]+)"/)![1]!;
  const json = async (method: string, p2: string, body?: unknown) => {
    const r = await fetch(`${base}${p2}`, { method, headers: { 'x-oma-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) as any };
  };
  const bin = async (p2: string, data: Buffer, type = 'application/octet-stream') => {
    const r = await fetch(`${base}${p2}`, { method: 'POST', headers: { 'x-oma-token': token, 'content-type': type }, body: new Uint8Array(data) });
    return { status: r.status, json: await r.json().catch(() => null) as any };
  };
  const events: Array<{ event: string; data: any }> = [];
  await new Promise<void>((resolve) => {
    http.get(`${base}/api/events?t=${token}`, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = chunk.match(/^event: (.+)$/m)?.[1];
          const data = chunk.match(/^data: (.+)$/m)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
          if (ev === 'hello') resolve();
        }
      });
    }).on('error', () => {});
  });
  return { json, bin, events };
}

test('huddle: live transcript, answers back to the page, the recording, the end and the processing', async () => {
  const ui = await startUi();
  const started = Date.now();
  const r = await ui.json('POST', '/api/huddles', { title: 'Board huddle', speaker: 'Ana', tasks: 'none', spoken: 'en' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const id = r.json.call.id;
  assert.equal(r.json.call.source, 'huddle');
  assert.equal(r.json.call.status, 'in_call');
  assert.equal(r.json.call.act, 'both'); // a huddle answers unless told otherwise
  assert.deepEqual(r.json.huddle, { speaker: 'Ana', parts: 0, transcribing: true });

  // The microphone: a turn (sound, then a pause) → the live transcript.
  assert.equal((await ui.bin(`/api/huddles/${id}/audio`, pcm(2, 1.2))).status, 200);
  const caption = await waitFor(() => ui.events.find((e) => e.event === 'huddle' && e.data.id === id && e.data.type === 'caption') ?? null, (e) => !!e, 30_000);
  assert.equal(caption!.data.text, SAID); // whisper's "Thank you." over the pause is dropped
  // Called by name, no model, nobody watching: the agent says "noted", and the page hears it.
  const say = await waitFor(() => ui.events.find((e) => e.event === 'huddle' && e.data.id === id && e.data.type === 'say') ?? null, (e) => !!e, 30_000);
  assert.match(say!.data.text, /noted/i);

  // Typed in the huddle: always for the agent.
  assert.equal((await ui.json('POST', `/api/huddles/${id}/ask`, { text: 'and the deadline?' })).status, 200);
  await waitFor(() => ui.events.filter((e) => e.event === 'huddle' && e.data.id === id && e.data.type === 'say').length, (n) => n >= 2, 30_000);
  const live = (await ui.json('GET', `/api/calls/${id}`)).json.live;
  assert.deepEqual(live.lines.map((l: { kind: string }) => l.kind), ['speech', 'agent', 'chat', 'agent']);
  assert.equal(live.lines[0].speaker, 'Ana');

  // The screen and the recording (two pieces of one file, in order).
  const frame = path.join(home, 'shot.jpg');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=1', '-frames:v', '1', frame]);
  assert.equal((await ui.bin(`/api/huddles/${id}/screen`, readFileSync(frame), 'image/jpeg')).status, 200);
  const rec = path.join(home, 'rec.webm');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=3', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3',
    '-c:v', 'libvpx', '-deadline', 'realtime', '-c:a', 'libopus', '-shortest', rec]);
  const bytes = readFileSync(rec);
  const half = Math.floor(bytes.length / 2);
  const q = (seq: number) => `/api/huddles/${id}/media?part=1&seq=${seq}&ext=webm&started=${started}`;
  assert.deepEqual((await ui.bin(q(0), bytes.subarray(0, half))).json, { next: 1 });
  assert.deepEqual((await ui.bin(q(0), bytes.subarray(0, half))).json, { next: 1 }); // sent twice: kept once
  assert.equal((await ui.bin(q(5), bytes.subarray(half))).status, 409); // a gap
  assert.deepEqual((await ui.bin(q(1), bytes.subarray(half))).json, { next: 2 });
  assert.equal((await ui.json('POST', `/api/huddles/${id}/speaking`, { start: started + 2000, end: started + 2500 })).status, 200);
  assert.equal((await ui.bin(`/api/huddles/${id}/media`, bytes, 'text/plain')).status, 415);

  // The end: then the worker processes it like any recording.
  const ended = await ui.json('POST', `/api/huddles/${id}/end`, {});
  assert.equal(ended.status, 200, JSON.stringify(ended.json));
  assert.equal((await ui.bin(`/api/huddles/${id}/audio`, pcm(1, 0))).status, 409); // over
  const done = await waitFor(async () => (await ui.json('GET', `/api/calls/${id}`)).json, (d) => ['needs_plan', 'failed'].includes(d.call.status), 60_000);
  assert.equal(done.call.status, 'needs_plan', done.call.error ?? '');
  assert.equal(done.frames.length >= 1, true);
  assert.deepEqual(done.transcript.map((s: { speaker: string; text: string }) => [s.speaker, s.text]), [['Ana', SAID]]);
  const timeline = JSON.parse(readFileSync(path.join(home, 'calls', id, 'bot', 'timeline.json'), 'utf8')) as { transcriptEntries: Array<{ participant: { displayName: string } }> };
  assert.deepEqual(timeline.transcriptEntries.map((e) => e.participant.displayName), ['Ana', 'Meeting Agent', 'Ana']);
  const notes = done.call.notes.map((n: { text: string }) => n.text).join('\n');
  assert.match(notes, /Asked during the meeting by Ana: and the deadline\?/);
});

test('huddle: cancelled — the page is told, nothing is kept', async () => {
  const ui = await startUi();
  const id = (await ui.json('POST', '/api/huddles', { speaker: 'Bo' })).json.call.id;
  assert.equal((await ui.bin(`/api/huddles/${id}/audio`, pcm(0.5, 0))).status, 200);
  assert.equal((await ui.json('POST', `/api/calls/${id}/cancel`, {})).json.call.status, 'cancelled');
  await waitFor(() => ui.events.find((e) => e.event === 'huddle' && e.data.id === id && e.data.type === 'leave') ?? null, (e) => !!e && e.data.discard === true, 10_000);
  assert.equal((await ui.bin(`/api/huddles/${id}/audio`, pcm(0.5, 0))).status, 409);
  assert.equal(existsSync(path.join(home, 'calls', id, 'bot')), false);
});

test('huddle: where a live turn is cut, and whisper\'s noise', () => {
  const s = (b: Buffer) => new Int16Array(b.buffer, b.byteOffset, b.length / 2);
  assert.equal(findCut(s(pcm(0, 1)), false), null); // too little to decide
  assert.deepEqual(findCut(s(pcm(0, 4)), false), { from: 0, to: (200 - 25) * 320, speech: false }); // silence: let go
  const turn = findCut(s(pcm(2, 1.2)), false)!;
  assert.equal(turn.speech, true);
  assert.equal(turn.from, 0);
  assert.ok(turn.to > 2 * 16000 && turn.to < 2.6 * 16000); // just after the speech
  assert.equal(findCut(s(pcm(3, 0.2)), false), null); // still talking
  assert.equal(findCut(s(pcm(3, 0.2)), true)!.speech, true); // …unless it ends now
  assert.equal(findCut(s(pcm(21, 0)), false)!.to, 21 * 16000); // 20 s at most

  const seg = (text: string, start: number, end: number) => ({ start, end, speaker: 'Unknown', text });
  assert.deepEqual(dropNoise([seg('Thank you.', 0, 30), seg('Obrigado.', 30, 31), seg('[Música]', 31, 32), seg('Let us start.', 32, 34)]).map((x) => x.text), ['Obrigado.', 'Let us start.']);
});
