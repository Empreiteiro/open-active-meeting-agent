// End to end through the bundled MCP server (dist/oma.mjs mcp), the way an
// agent uses it: fake container engine (bot), fake ASR, fake model, fake GitHub.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ASR_SEGMENTS, fakeServer, makeMeetingVideo, ROOT, tempDir, waitFor, type FakeServer } from './helpers.js';

const BUNDLE = path.join(ROOT, 'dist', 'oma.mjs');
let home: string;
let video: string;
let asr: FakeServer;
let github: FakeServer;
let llm: FakeServer;
let issueNo = 0;

type Tool = { text: string; images: number; isError: boolean };

async function connect(extraEnv: Record<string, string> = {}): Promise<{ call: (name: string, args?: Record<string, unknown>) => Promise<Tool>; close: () => Promise<void>; client: Client }> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    OMA_HOME: home,
    OMA_ASR: 'openai',
    OMA_ASR_BASE_URL: asr.url,
    OMA_ASR_API_KEY: 'test',
    GITHUB_TOKEN: 'test-token',
    OMA_GITHUB_API_URL: github.url,
    OMA_CONTAINER_ENGINE: path.join(ROOT, 'test', 'fake-docker.mjs'),
    FAKE_DOCKER_STATE: path.join(home, 'fake-docker.json'),
    FAKE_BOT_VIDEO: video,
    OMA_MEETILY_DB: path.join(home, 'meetily.sqlite'),
    ...extraEnv,
  };
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', BUNDLE, 'mcp'], env, stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Tool> => {
    const r = await client.callTool({ name, arguments: args }) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    return {
      text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
      images: r.content.filter((c) => c.type === 'image').length,
      isError: !!r.isError,
    };
  };
  return { call, client, close: () => client.close() };
}

const idOf = (text: string) => text.match(/Call (\d{8}-\d{4}-[0-9a-f]{6})/)![1]!;

before(async () => {
  home = tempDir('oma-e2e-');
  video = makeMeetingVideo(path.join(home, 'meeting.mp4'));
  chmodSync(path.join(ROOT, 'test', 'fake-docker.mjs'), 0o755);
  asr = await fakeServer(() => ({ json: ASR_SEGMENTS }));
  github = await fakeServer(({ body }) => {
    const b = JSON.parse(body) as { title: string };
    issueNo++;
    return { status: 201, json: { number: issueNo, html_url: `https://github.example/acme/app/issues/${issueNo}`, title: b.title } };
  });
  // The model: an empty plan first (it put everything in questions), then the plan.
  llm = await fakeServer(({ n }) => {
    const plan = n % 2 === 1
      ? { title: 'Due dates', summary: 'S', questions: ['Which date format?'], tasks: [] }
      : { title: 'Due dates', summary: 'Show and filter due dates.', questions: [], tasks: [
        { title: 'Show the due date under long titles', description: 'd', acceptance: ['a', 'b'], frames: ['F1'], repo: 'acme/app', deliverable: 'pr', priority: 'high', depends_on: [] },
        { title: 'Filter the board by due date', description: 'd', acceptance: ['a', 'b'], frames: ['F2'], repo: 'acme/app', deliverable: 'pr', priority: 'medium', depends_on: [1] },
      ] };
    return { json: { id: `m${n}`, type: 'message', role: 'assistant', model: 'fake-model', content: [{ type: 'text', text: JSON.stringify(plan) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } } };
  });
});

after(async () => {
  await Promise.all([asr.close(), github.close(), llm.close()]);
});

test('MCP server lists the tools and the prompt', async () => {
  const s = await connect();
  try {
    const tools = (await s.client.listTools()).tools.map((t) => t.name);
    for (const t of ['join_meeting', 'end_meeting', 'cancel_meeting', 'import_meetily', 'import_recording', 'get_call_context', 'save_plan', 'build_plan', 'distribute_plan', 'next_task', 'update_task', 'setup_status']) {
      assert.ok(tools.includes(t), `missing tool ${t}`);
    }
    const prompts = (await s.client.listPrompts()).prompts.map((p) => p.name);
    assert.deepEqual(prompts, ['work_on_meeting']);
    const setup = await s.call('setup_status');
    assert.match(setup.text, /✓ container engine/);
    assert.match(setup.text, /✓ bot image/);
  } finally {
    await s.close();
  }
});

test('the bot joins, the person ends the call, the agent plans and works the tasks', async () => {
  const s = await connect();
  try {
    const joined = await s.call('join_meeting', { url: 'https://meet.google.com/abc-defg-hij', title: 'Board review', repos: ['acme/app'], autonomy: 'prs', workdir: home });
    assert.equal(joined.isError, false, joined.text);
    const id = idOf(joined.text);
    // The container got the meeting and the agent's settings.
    const docker = JSON.parse(readFileSync(path.join(home, 'fake-docker.json'), 'utf8'))[`oma-bot-${id}`] as { args: string[] };
    assert.ok(docker.args.includes('JOIN_URL=https://meet.google.com/abc-defg-hij'));
    assert.ok(docker.args.includes('PROVIDER=google_meet'));
    assert.ok(docker.args.includes('RECORD_VIDEO=1'));

    await waitFor(() => s.call('call_status', { call_id: id }), (r) => /Status: in_call/.test(r.text));
    const st = await s.call('call_status', { call_id: id });
    assert.match(st.text, /Bot: in_call · 3 participant/);

    await s.call('end_meeting', { call_id: id });
    await waitFor(() => s.call('call_status', { call_id: id }), (r) => /Status: needs_plan/.test(r.text));

    // The transcript carries the names from the bot's timeline.
    const transcript = JSON.parse(readFileSync(path.join(home, 'calls', id, 'transcript.json'), 'utf8')) as Array<{ speaker: string }>;
    assert.deepEqual(transcript.map((x) => x.speaker), ['Ana', 'Ana', 'Bruno']);

    // The connected agent reads the call (frames as images) and writes the plan.
    const ctx = await s.call('get_call_context', { call_id: id, max_images: 2 });
    assert.equal(ctx.isError, false, ctx.text);
    assert.equal(ctx.images, 2);
    assert.match(ctx.text, /\[00:00\] Ana: This is the board/);
    assert.match(ctx.text, /\[F1 · 00:00\] shared screen/);
    assert.match(ctx.text, /not attached — get_frames/);
    assert.match(ctx.text, /Answer ONLY with valid JSON/);

    const saved = await s.call('save_plan', { call_id: id, plan: {
      title: 'Board due dates', summary: 'Due dates on the board.', questions: [],
      tasks: [
        { title: 'Show the due date under long titles', description: 'Card component.', acceptance: ['visible', 'red when overdue'], frames: ['F1'], deliverable: 'pr', depends_on: [] },
        { title: 'Filter the board by due date', description: 'Settings screen.', acceptance: ['filter works', 'kept in the URL'], frames: ['F2', 'F3'], deliverable: 'pr', depends_on: [1] },
      ],
    } });
    assert.equal(saved.isError, false, saved.text);
    assert.match(saved.text, /0\/2 done \(by host\)/);

    // Issues: one per task, the second one depends on the first.
    const dist = await s.call('distribute_plan', { call_id: id });
    assert.match(dist.text, /t1: https:\/\/github\.example\/acme\/app\/issues\/\d+/);
    const bodies = github.requests.map((r) => JSON.parse(r.body) as { title: string; body: string });
    assert.equal(bodies.length, 2);
    assert.equal(github.requests[0]!.path, '/repos/acme/app/issues');
    assert.equal(github.requests[0]!.headers.authorization, 'Bearer test-token');
    assert.match(bodies[0]!.body, /- \[ \] visible/);
    assert.match(bodies[1]!.body, new RegExp(`Depends on #${issueNo - 1}`));

    // The work: t1 first (t2 waits for it), with its screen and the "prs" rule.
    const t1 = await s.call('next_task', { call_id: id });
    assert.match(t1.text, /^# t1 · Show the due date/);
    assert.match(t1.text, /Autonomy "prs"/);
    assert.match(t1.text, /issue: https:\/\/github\.example/);
    assert.equal(t1.images, 1);
    assert.match((await s.call('next_task', { call_id: id })).text, /^\(resuming\) # t1/);
    await s.call('update_task', { call_id: id, key: 't1', state: 'done', pr_url: 'https://github.example/acme/app/pull/7' });
    const t2 = await s.call('next_task', { call_id: id });
    assert.match(t2.text, /^# t2 · Filter the board/);
    assert.equal(t2.images, 2);
    await s.call('update_task', { call_id: id, key: 't2', state: 'done', pr_url: 'https://github.example/acme/app/pull/8' });
    assert.match((await s.call('next_task', { call_id: id })).text, /Every task of this plan is done/);
    assert.match((await s.call('call_status', { call_id: id })).text, /2\/2 done/);
  } finally {
    await s.close();
  }
});

test('cancel: the bot leaves and nothing is kept', async () => {
  const s = await connect();
  try {
    const id = idOf((await s.call('join_meeting', { url: 'https://teams.microsoft.com/l/meetup-join/x' })).text);
    await waitFor(() => s.call('call_status', { call_id: id }), (r) => /Status: in_call/.test(r.text));
    const r = await s.call('cancel_meeting', { call_id: id });
    assert.match(r.text, /Status: cancelled/);
    assert.equal(existsSync(path.join(home, 'calls', id, 'bot')), false);
  } finally {
    await s.close();
  }
});

test('a recording with a planning model: planned by itself, a second turn when it came back empty', async () => {
  const s = await connect({ OMA_LLM_PROVIDER: 'anthropic', OMA_LLM_MODEL: 'fake-model', OMA_LLM_BASE_URL: llm.url, OMA_LLM_API_KEY: 'k' });
  try {
    const r = await s.call('import_recording', { path: video, title: 'Recorded review', repos: ['acme/app'] });
    assert.equal(r.isError, false, r.text);
    const id = idOf(r.text);
    const done = await waitFor(() => s.call('call_status', { call_id: id }), (x) => /Status: (planned|failed)/.test(x.text));
    assert.match(done.text, /Status: planned/);
    assert.match(done.text, /t2 Filter the board by due date \[todo · pr · acme\/app · medium · after t1\]/);
    assert.equal(llm.requests.length, 2);
    const first = JSON.parse(llm.requests[0]!.body) as { messages: Array<{ content: Array<{ type: string }> }>; system: string };
    assert.ok(first.messages[0]!.content.some((b) => b.type === 'image'));
    assert.match(first.system, /every change they asked for in the call is a task/);
    const second = JSON.parse(llm.requests[1]!.body) as { messages: Array<{ role: string; content: unknown }> };
    assert.deepEqual(second.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.match(String(second.messages[2]!.content), /Your plan has no tasks/);
  } finally {
    await s.close();
  }
});

test('meetily: its transcript and notes, and the screen recorded here at the same time', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(home, 'meetily.sqlite'));
  db.exec(`CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, folder_path TEXT);
    CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, transcript TEXT NOT NULL, timestamp TEXT NOT NULL, summary TEXT, action_items TEXT, key_points TEXT, audio_start_time REAL, audio_end_time REAL, duration REAL, speaker TEXT);
    CREATE TABLE meeting_notes (meeting_id TEXT PRIMARY KEY NOT NULL, notes_markdown TEXT, notes_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  const start = new Date(Date.now() - 60_000).toISOString();
  db.prepare('INSERT INTO meetings VALUES (?, ?, ?, ?, ?)').run('mt-1', 'Planning with meetily', start, start, null);
  db.prepare('INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, speaker) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('a', 'mt-1', 'Please add an export button here.', start, 3, 6, 'mic');
  db.prepare('INSERT INTO meeting_notes VALUES (?, ?, ?, ?, ?)').run('mt-1', 'CSV export', null, start, start);
  db.close();
  // A screen recording that started 5 s after the meeting.
  const screenDir = path.join(home, 'screen');
  mkdirSync(screenDir, { recursive: true });
  const rec = path.join(screenDir, 'screen-test.mp4');
  writeFileSync(rec, readFileSync(video));
  writeFileSync(`${rec}.json`, JSON.stringify({ file: rec, started_at: new Date(Date.parse(start) + 5_000).toISOString(), ended_at: new Date(Date.parse(start) + 17_000).toISOString() }));

  const s = await connect();
  try {
    assert.match((await s.call('import_meetily')).text, /mt-1 · Planning with meetily · .* · 1 segment/);
    const id = idOf((await s.call('import_meetily', { meeting_id: 'mt-1' })).text);
    await waitFor(() => s.call('call_status', { call_id: id }), (x) => /Status: needs_plan/.test(x.text));
    const ctx = await s.call('get_call_context', { call_id: id });
    assert.match(ctx.text, /\[00:03\] Me: Please add an export button here\./);
    assert.match(ctx.text, /\[F1 · 00:05\]/);                      // frame on the meeting's timeline
    assert.match(ctx.text, /Notes taken during the meeting:\s*CSV export/);
    assert.ok(ctx.images >= 1);
  } finally {
    await s.close();
  }
});
