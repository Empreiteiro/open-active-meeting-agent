// The web UI (oma ui) through HTTP, the way the page uses it, with a fake
// Claude Code (test/fake-claude.mjs) and a fake container engine; and the local
// agents as the planning model (claude-code, command).

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { makeMeetingVideo, ROOT, tempDir, waitFor } from './helpers.js';

const BUNDLE = path.join(ROOT, 'dist', 'oma.mjs');
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fake-claude.mjs');
const FAKE_CMD = `${process.execPath} ${path.join(ROOT, 'test', 'fake-agent-cmd.mjs')}`;
let home: string;
let video: string;
const servers: ChildProcess[] = [];

interface Ui {
  base: string;
  token: string;
  api: (method: string, p: string, body?: unknown) => Promise<{ status: number; json: any }>;
  events: Array<{ event: string; data: any }>;
  waitEvent: (pred: (e: { event: string; data: any }) => boolean, ms?: number) => Promise<{ event: string; data: any }>;
}

async function startUi(extra: Record<string, string> = {}): Promise<Ui> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: path.join(home, 'user'), // no ~/.claude here: the UI adds its own MCP server
    OMA_HOME: home,
    OMA_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_LOG: path.join(home, 'claude.log'),
    OMA_CONTAINER_ENGINE: path.join(ROOT, 'test', 'fake-docker.mjs'),
    FAKE_DOCKER_STATE: path.join(home, 'fake-docker.json'),
    FAKE_BOT_VIDEO: video,
    OMA_ASR: 'none',
    ...extra,
  };
  mkdirSync(env.HOME!, { recursive: true });
  const p = spawn(process.execPath, ['--no-warnings', BUNDLE, 'ui', '--port', '0', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(p);
  let out = '';
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the UI did not start: ${out}`)), 15_000);
    p.stdout!.on('data', (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    p.stderr!.on('data', (d) => { out += d; });
    p.on('exit', (code) => reject(new Error(`the UI exited (${code}): ${out}`)));
  });
  const page = await (await fetch(`${base}/`)).text();
  const token = page.match(/name="oma-token" content="([0-9a-f]+)"/)![1]!;
  const api = async (method: string, p2: string, body?: unknown) => {
    const r = await fetch(`${base}${p2}`, {
      method,
      headers: { 'x-oma-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  // The page's event stream.
  const events: Ui['events'] = [];
  await new Promise<void>((resolve) => {
    const req = http.get(`${base}/api/events?t=${token}`, (res) => {
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
    });
    req.on('error', () => {});
  });
  const waitEvent = (pred: (e: { event: string; data: any }) => boolean, ms = 15_000) =>
    waitFor(() => events.find(pred) ?? null, (e) => !!e, ms) as Promise<{ event: string; data: any }>;
  return { base, token, api, events, waitEvent };
}

const claudeRuns = (): Array<{ args: string[]; cwd: string }> => {
  const f = path.join(home, 'claude.log');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
const arg = (args: string[], flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

before(() => {
  home = tempDir('oma-ui-');
  video = makeMeetingVideo(path.join(home, 'meeting.mp4'));
  chmodSync(FAKE_CLAUDE, 0o755);
  chmodSync(path.join(ROOT, 'test', 'fake-docker.mjs'), 0o755);
});

after(() => {
  for (const p of servers) p.kill();
});

test('ui: only this machine\'s page drives it (token, host, JSON)', async () => {
  const ui = await startUi();
  const page = await fetch(`${ui.base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.equal((await fetch(`${ui.base}/app.js`)).status, 200);
  assert.equal((await fetch(`${ui.base}/api/ping`)).status, 200);
  assert.equal((await fetch(`${ui.base}/api/calls`)).status, 403); // no token
  assert.equal((await fetch(`${ui.base}/api/calls`, { headers: { 'x-oma-token': 'nope' } })).status, 403);
  // Another host name (DNS rebinding) is refused, token or not.
  const port = new URL(ui.base).port;
  const status = await new Promise<number>((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/calls', headers: { host: `evil.example:${port}`, 'x-oma-token': ui.token } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); });
  });
  assert.equal(status, 403);
  // Writes are JSON only (no plain form posts).
  const form = await fetch(`${ui.base}/api/chats`, { method: 'POST', headers: { 'x-oma-token': ui.token, 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);
  const st = await ui.api('GET', '/api/state');
  assert.equal(st.json.agent.label, 'Claude Code');
  assert.equal(st.json.agent.ready, true);
  assert.equal(st.json.model.configured, false);
});

test('ui: a chat with Claude Code — streamed, a permission asked in the page, the session resumed', async () => {
  const ui = await startUi();
  const runs0 = claudeRuns().length;
  const chat = (await ui.api('POST', '/api/chats', {})).json;
  assert.match(chat.id, /^[a-z0-9-]+$/);

  const sent = await ui.api('POST', `/api/chats/${chat.id}/messages`, { text: 'Please write the notes file' });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  // Busy: a second message waits for the answer.
  assert.equal((await ui.api('POST', `/api/chats/${chat.id}/messages`, { text: 'again' })).status, 409);

  const ask = await ui.waitEvent((e) => e.event === 'chat' && e.data.type === 'part' && e.data.part.type === 'permission');
  assert.equal(ask.data.part.tool, 'Write');
  assert.equal(ask.data.part.decision, 'pending');
  assert.ok(ui.events.some((e) => e.event === 'chat' && e.data.type === 'text' && e.data.text.length <= 6)); // streamed in pieces
  assert.equal((await ui.api('POST', `/api/chats/${chat.id}/permissions/${ask.data.part.id}`, { allow: true })).status, 200);
  const done = await ui.waitEvent((e) => e.event === 'chat' && e.data.type === 'done' && e.data.chat_id === chat.id);
  assert.equal(done.data.error, null);

  const saved = (await ui.api('GET', `/api/chats/${chat.id}`)).json;
  assert.equal(saved.title, 'Please write the notes file');
  assert.match(saved.session_id, /^sess-/);
  const parts = saved.messages[1].parts;
  assert.deepEqual(parts.map((p: { type: string }) => p.type), ['text', 'tool', 'permission', 'text']);
  assert.equal(parts[0].text, 'Writing it. ');
  assert.equal(parts[1].status, 'ok');
  assert.equal(parts[1].result, 'written');
  assert.equal(parts[2].decision, 'allowed');
  assert.equal(parts[3].text, 'Done.');

  // How Claude Code was started: the meeting tools allowed, our MCP server
  // (none in this HOME), the UI described, permissions asked over stdio.
  const run = claudeRuns()[runs0]!;
  assert.equal(arg(run.args, '--permission-prompt-tool'), 'stdio');
  assert.match(arg(run.args, '--allowedTools')!, /mcp__meeting-agent/);
  assert.match(arg(run.args, '--append-system-prompt')!, /web UI/);
  const mcp = JSON.parse(arg(run.args, '--mcp-config')!);
  assert.deepEqual(mcp.mcpServers['meeting-agent'].args.slice(-2), [BUNDLE, 'mcp']);
  assert.ok(!run.args.includes('--resume'));
  assert.equal(realpathSync(run.cwd), realpathSync(path.join(home, 'user')));

  // Next turn: same session.
  await ui.api('POST', `/api/chats/${chat.id}/messages`, { text: 'hello again' });
  await waitFor(() => ui.events.filter((e) => e.event === 'chat' && e.data.type === 'done' && e.data.chat_id === chat.id).length, (n) => n >= 2);
  const again = (await ui.api('GET', `/api/chats/${chat.id}`)).json;
  assert.equal(again.messages[3].parts[0].text, `resumed ${saved.session_id}: You said: hello again`);
  assert.equal(arg(claudeRuns().at(-1)!.args, '--resume'), saved.session_id);

  // A denied permission reaches the agent as a refusal.
  await ui.api('POST', `/api/chats/${chat.id}/messages`, { text: 'write it once more' });
  const asks = await waitFor(
    () => ui.events.filter((e) => e.event === 'chat' && e.data.chat_id === chat.id && e.data.type === 'part' && e.data.part.type === 'permission' && e.data.part.decision === 'pending'),
    (l) => l.length >= 2,
  );
  const ask2 = asks.at(-1)!;
  await ui.api('POST', `/api/chats/${chat.id}/permissions/${ask2.data.part.id}`, { allow: false });
  await waitFor(() => ui.events.filter((e) => e.event === 'chat' && e.data.type === 'done' && e.data.chat_id === chat.id).length, (n) => n >= 3);
  const last = (await ui.api('GET', `/api/chats/${chat.id}`)).json.messages.at(-1);
  assert.equal(last.parts.find((p: { type: string }) => p.type === 'permission').decision, 'denied');
  assert.equal(last.parts.at(-1).text, 'Refused.');

  assert.equal((await ui.api('DELETE', `/api/chats/${chat.id}`)).status, 200);
  assert.equal((await ui.api('GET', `/api/chats/${chat.id}`)).status, 404);
});

test('ui: join a meeting, follow it live, post in its chat, a chat about it, leave', async () => {
  const ui = await startUi({ FAKE_BOT_LIVE: JSON.stringify([{ after_ms: 300, type: 'caption', seg: 's1', speaker: 'Ana', text: 'Meeting Agent, note the deadline.', final: true }]) });
  const bad = await ui.api('POST', '/api/calls', { url: 'https://example.com/x' });
  assert.equal(bad.status, 400);
  const joined = await ui.api('POST', '/api/calls', { url: 'https://meet.google.com/abc-defg-hij', title: 'UI call', act: 'both', tasks: 'none', doc: 'file' });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  const id = joined.json.call.id;
  assert.equal(joined.json.call.act, 'both');
  assert.deepEqual(joined.json.call.outputs, { tasks: null, crm: null, doc: 'file' });

  await ui.waitEvent((e) => e.event === 'calls' && e.data.some((c: { id: string }) => c.id === id));
  const live = await waitFor(async () => (await ui.api('GET', `/api/calls/${id}`)).json, (d) => d.live?.lines.length >= 1);
  assert.equal(live.call.status, 'in_call');
  assert.equal(live.live.captions, true);
  assert.equal(live.live.lines[0].text, 'Meeting Agent, note the deadline.');
  assert.deepEqual(live.names, ['Meeting Agent']);

  const said = await ui.api('POST', `/api/calls/${id}/say`, { text: 'Noted.' });
  assert.equal(said.json.ok, true);
  // What the bot posted changes the call: the page hears of it.
  await ui.waitEvent((e) => e.event === 'call' && e.data.id === id);
  const patched = await ui.api('PATCH', `/api/calls/${id}`, { act: 'during' });
  assert.equal(patched.json.call.act, 'during');

  // The meeting's chat: the agent is told which call.
  const chat = (await ui.api('POST', '/api/chats', { call_id: id })).json;
  assert.equal(chat.title, 'UI call');
  await ui.api('POST', `/api/chats/${chat.id}/messages`, { text: 'What was said?' });
  await ui.waitEvent((e) => e.event === 'chat' && e.data.type === 'done' && e.data.chat_id === chat.id);
  assert.match(arg(claudeRuns().at(-1)!.args, '--append-system-prompt')!, new RegExp(`call_id ${id}`));
  assert.equal((await ui.api('GET', `/api/calls/${id}`)).json.chat_id, chat.id);

  const cancelled = await ui.api('POST', `/api/calls/${id}/cancel`, {});
  assert.equal(cancelled.json.call.status, 'cancelled');
  assert.equal((await ui.api('POST', `/api/calls/${id}/say`, { text: 'x' })).status, 400);
});

test('ui: settings it may change, and the ones it may not', async () => {
  const ui = await startUi();
  const r = await ui.api('POST', '/api/config', { OMA_LLM_PROVIDER: 'claude-code', OMA_ACT: 'both', OMA_TASKS_TARGET: 'none' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const st = (await ui.api('GET', '/api/state')).json;
  assert.equal(st.model.configured, true);
  assert.equal(st.model.label, 'claude-code');
  assert.equal(st.defaults.act, 'both');
  assert.equal(st.defaults.tasks, null);
  const file = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(file.OMA_LLM_PROVIDER, 'claude-code');
  assert.equal((await ui.api('POST', '/api/config', { HUBSPOT_TOKEN: 'x' })).status, 400);
  assert.equal((await ui.api('POST', '/api/config', { OMA_ACT: 'sometimes' })).status, 400);
  // Back to how it was, for the other tests.
  await ui.api('POST', '/api/config', { OMA_LLM_PROVIDER: '', OMA_ACT: '', OMA_TASKS_TARGET: '' });
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')), {});
});

test('ui: the chat with another command-line agent', async () => {
  const ui = await startUi({ OMA_UI_AGENT: 'command', OMA_UI_AGENT_COMMAND: FAKE_CMD });
  const st = (await ui.api('GET', '/api/state')).json;
  assert.equal(st.agent.kind, 'command');
  const chat = (await ui.api('POST', '/api/chats', {})).json;
  await ui.api('POST', `/api/chats/${chat.id}/messages`, { text: 'first' });
  await ui.waitEvent((e) => e.event === 'chat' && e.data.type === 'done' && e.data.chat_id === chat.id);
  await ui.api('POST', `/api/chats/${chat.id}/messages`, { text: 'second' });
  await waitFor(() => ui.events.filter((e) => e.event === 'chat' && e.data.type === 'done' && e.data.chat_id === chat.id).length, (n) => n >= 2);
  const saved = (await ui.api('GET', `/api/chats/${chat.id}`)).json;
  const answer = JSON.parse(saved.messages[3].parts[0].text);
  assert.equal(answer.lastUser, 'User: second');
  assert.match(answer.head, /open-meeting-agent web UI/);
});

test('local agents as the planning model: Claude Code (with the screens) and a command', async () => {
  process.env.OMA_HOME = path.join(home, 'model');
  process.env.OMA_CLAUDE_BIN = FAKE_CLAUDE;
  process.env.OMA_LLM_PROVIDER = 'claude-code';
  delete process.env.OMA_LLM_MODEL;
  const { config, reloadConfig } = await import('../src/config.js');
  const { chat, llmConfigured, llmLabel } = await import('../src/llm/index.js');
  reloadConfig();
  assert.equal(config.home, path.join(home, 'model')); // OMA_HOME is read once, at import
  assert.equal(llmConfigured(), true);
  assert.equal(llmLabel(), 'claude-code');

  const frame = path.join(home, 'F1.jpg');
  const { execFileSync } = await import('node:child_process');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-frames:v', '1', frame]);
  const turns = [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'the call' }, { type: 'image' as const, label: 'F1', file: frame }] },
    { role: 'assistant' as const, content: '{"tasks":[]}' },
    { role: 'user' as const, content: 'Your plan has no tasks.' },
  ];
  const r = await chat('THE RULES', turns);
  const got = JSON.parse(r.text);
  assert.equal(got.system, 'THE RULES'); // our prompt replaces Claude Code's own
  assert.equal(got.images, 1);
  assert.equal(got.strict, true); // no MCP servers, no tools
  assert.equal(got.persist, false);
  assert.match(got.text, /the call\n<your_previous_answer>\n\{"tasks":\[\]\}\n<\/your_previous_answer>\nYour plan has no tasks\./);
  assert.equal(r.model, 'claude-code:fake-model');

  process.env.OMA_LLM_PROVIDER = 'command';
  process.env.OMA_LLM_COMMAND = FAKE_CMD;
  reloadConfig();
  assert.equal(llmLabel(), `command:${process.execPath}`);
  const r2 = await chat('THE RULES', turns.slice(0, 1));
  const got2 = JSON.parse(r2.text);
  assert.match(got2.head, /^THE RULES\n\nthe call/);
  assert.equal(got2.screen, true); // the screen goes as its file

  process.env.OMA_LLM_COMMAND = 'exit 3';
  reloadConfig();
  await assert.rejects(chat('x', [{ role: 'user', content: 'y' }]), /failed \(exit 3\)/);
});
