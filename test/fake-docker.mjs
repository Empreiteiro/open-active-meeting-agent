#!/usr/bin/env node
// A stand-in for `docker` in the tests. `run` starts a fake bot that follows
// the real bot's volume contract (status.json, control.json, outputs, and in
// the call live.jsonl + commands.jsonl).
//   env FAKE_DOCKER_STATE  json file: container name → { pid, dir }
//   env FAKE_BOT_VIDEO     the "recording" the fake bot hands back
//   env FAKE_BOT_LIVE      json list of live events to write once in the call: [{ after_ms, type, … }]

import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [cmd, ...args] = process.argv.slice(2);
const stateFile = process.env.FAKE_DOCKER_STATE;
const state = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {});
const save = (s) => writeFileSync(stateFile, JSON.stringify(s));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

if (cmd === 'version') { console.log('99.0'); process.exit(0); }
if (cmd === 'image') process.exit(0); // image inspect: the image exists
if (cmd === 'bot') await fakeBot(args[0]);
if (cmd === 'run') {
  const name = args[args.indexOf('--name') + 1];
  const vol = args[args.indexOf('-v') + 1];
  const dir = vol.slice(0, vol.lastIndexOf(':/out'));
  const p = spawn(process.execPath, [process.argv[1], 'bot', dir], { detached: true, stdio: 'ignore', env: process.env });
  p.unref();
  save({ ...state(), [name]: { pid: p.pid, dir, args } });
  console.log(`fake-${name}`);
  process.exit(0);
}
if (cmd === 'inspect') {
  const c = state()[args.at(-1)];
  if (!c) process.exit(1);
  console.log(alive(c.pid) ? 'true' : 'false');
  process.exit(0);
}
if (cmd === 'rm') {
  const c = state()[args.at(-1)];
  if (c && alive(c.pid)) process.kill(c.pid, 'SIGKILL');
  process.exit(0);
}
if (cmd !== 'bot') { console.error(`fake docker: unknown ${cmd}`); process.exit(2); }

async function fakeBot(dir) {
  const write = (name, v) => writeFileSync(path.join(dir, name), JSON.stringify(v));
  const control = () => { try { return JSON.parse(readFileSync(path.join(dir, 'control.json'), 'utf8')); } catch { return {}; } };
  write('status.json', { state: 'joining' });
  await new Promise((r) => setTimeout(r, 500));
  write('status.json', { state: 'in_call', participants: 3 });
  const live = (e) => appendFileSync(path.join(dir, 'live.jsonl'), `${JSON.stringify({ at: Date.now(), ...e })}\n`);
  live({ type: 'live', captions: true, chat: true });
  const script = process.env.FAKE_BOT_LIVE ? JSON.parse(process.env.FAKE_BOT_LIVE) : [];
  const t0 = Date.now();
  let next = 0;
  let commandsRun = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 200));
    while (next < script.length && Date.now() - t0 >= script[next].after_ms) {
      const { after_ms, ...e } = script[next++];
      live(e);
    }
    // The host's commands: "posted" in the chat.
    const cf = path.join(dir, 'commands.jsonl');
    const cmds = existsSync(cf) ? readFileSync(cf, 'utf8').split('\n').filter(Boolean) : [];
    for (const ln of cmds.slice(commandsRun)) {
      commandsRun++;
      const cmd = JSON.parse(ln);
      live({ type: 'sent', id: cmd.id, ok: true, text: cmd.text });
    }
    const c = control();
    if (!c.leave) continue;
    if (c.discard) { write('status.json', { state: 'done', discarded: true }); process.exit(0); }
    copyFileSync(process.env.FAKE_BOT_VIDEO, path.join(dir, 'recording.mp4'));
    copyFileSync(process.env.FAKE_BOT_VIDEO, path.join(dir, 'audio.m4a'));
    write('timeline.json', { transcriptEntries: [
      { participant: { displayName: 'Ana' }, startTime: '0.000s', endTime: '8.000s' },
      { participant: { displayName: 'Bruno' }, startTime: '8.000s', endTime: '12.000s' },
    ] });
    write('exit.json', { reason: 'manual', inCallSec: 12, sawOthers: true });
    write('status.json', { state: 'done' });
    process.exit(0);
  }
}
