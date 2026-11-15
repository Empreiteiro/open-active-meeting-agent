// End to end through the bundled MCP server (dist/oma.mjs mcp), the way an
// agent uses it: fake container engine (bot), fake ASR, fake model, fake
// GitHub / ClickUp / HubSpot / Notion / webhook.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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
    for (const t of ['join_meeting', 'end_meeting', 'cancel_meeting', 'import_meetily', 'import_recording', 'get_call_context', 'save_plan', 'build_plan', 'distribute_plan', 'record_output', 'watch_meeting', 'send_meeting_message', 'next_task', 'update_task', 'setup_status']) {
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
    assert.ok(!docker.args.includes('LIVE_CHAT=1')); // act "after": the chat stays closed (it would cover the recorded screen)

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

/** An Anthropic Messages answer carrying `out` as JSON text. */
const anthropicAnswer = (out: unknown, n: number) => ({ id: `m${n}`, type: 'message', role: 'assistant', model: 'fake-model', content: [{ type: 'text', text: JSON.stringify(out) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } });
const commandsOf = (id: string): string[] => {
  const f = path.join(home, 'calls', id, 'bot', 'commands.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : [];
};

test('in the meeting with the connected agent: it follows, sees the mentions and answers; outputs to a webhook and to the agent', async () => {
  const hook = await fakeServer(() => ({ json: { url: 'https://docs.example/minutes-1' } }));
  const script = [
    { after_ms: 1500, type: 'caption', seg: 's1', speaker: 'Ana', text: 'Let us look at the', final: false },
    { after_ms: 1700, type: 'caption', seg: 's1', speaker: 'Ana', text: 'Let us look at the board.', final: true },
    { after_ms: 2000, type: 'caption', seg: 's2', speaker: 'Bruno', text: 'Meeting Agent, what did we decide about the due dates?', final: true },
    { after_ms: 2200, type: 'chat', speaker: 'Ana', text: '@Meeting Agent also check the mobile view' },
  ];
  const s = await connect({ FAKE_BOT_LIVE: JSON.stringify(script), OMA_WEBHOOK_URL: hook.url, OMA_WEBHOOK_SECRET: 'shh' });
  try {
    const joined = await s.call('join_meeting', { url: 'https://meet.google.com/abc-defg-hij', title: 'Live review', act: 'during' });
    assert.equal(joined.isError, false, joined.text);
    assert.match(joined.text, /you are the agent's brain: loop watch_meeting/);
    const id = idOf(joined.text);
    const docker = JSON.parse(readFileSync(path.join(home, 'fake-docker.json'), 'utf8'))[`oma-bot-${id}`] as { args: string[] };
    assert.ok(docker.args.includes('LIVE_CHAT=1')); // the chat panel opens as it gets in

    // The connected agent's loop: watch_meeting until both mentions came in.
    let since = 0;
    let seen = '';
    const until = Date.now() + 30_000;
    while (!(/MENTION .*Bruno: Meeting Agent, what did we decide/.test(seen) && /MENTION .*Ana \(chat\): @Meeting Agent also check/.test(seen))) {
      assert.ok(Date.now() < until, `no mentions; seen:\n${seen}`);
      const r = await s.call('watch_meeting', { call_id: id, since, wait_seconds: 3 });
      assert.equal(r.isError, false, r.text);
      seen += `${r.text}\n`;
      since = Number(r.text.match(/next: (\d+)/)![1]);
    }
    assert.match(seen, /captions on · chat open/);
    assert.match(seen, /Meeting Agent: Hi! I'm Meeting Agent, an AI assistant/); // the greeting, posted by the worker
    assert.match(seen, /#\d+ \[00:0\d\] Ana: Let us look at the board\.\n/);  // only the settled turn
    assert.match(seen, /Answer the mention\(s\) with send_meeting_message/);

    const said = await s.call('send_meeting_message', { call_id: id, text: 'We kept the due date under the title; I will check mobile after the call.' });
    assert.equal(said.text, 'Posted in the meeting chat.');
    // The agent was watching: the worker did not answer "noted" on its own.
    const cmds = commandsOf(id);
    assert.equal(cmds.length, 2, cmds.join(' | '));
    assert.match(cmds[1]!, /^We kept the due date/);
    assert.match((await s.call('call_status', { call_id: id })).text, /acts: during[\s\S]*Live: \d+ line\(s\) · captions on · chat open · tasks asked for in the meeting: after the call/);

    // After the call (act "during"): processed, nothing delivered by itself.
    await s.call('end_meeting', { call_id: id });
    await waitFor(() => s.call('call_status', { call_id: id }), (r) => /Status: needs_plan/.test(r.text));

    // The plan with a CRM update and a document; delivered by hand.
    await s.call('set_call', { call_id: id, outputs: { tasks: 'none', crm: 'agent', doc: 'webhook' } });
    const ctx = await s.call('get_call_context', { call_id: id, max_images: 0 });
    assert.match(ctx.text, /"crm": what the call means for the CRM/);
    const saved = await s.call('save_plan', { call_id: id, plan: {
      title: 'Due dates', summary: 'S', questions: [], tasks: [{ title: 'Check the mobile view', description: 'd' }],
      crm: { company: { name: 'Acme' }, contacts: [{ name: 'Ana' }], summary: 'Reviewed the board.' },
      doc: { title: 'Minutes', markdown: '# Minutes\n- due dates' },
    } });
    assert.match(saved.text, /CRM update: Acme · 1 contact\(s\) \(not delivered yet\)\nDocument: Minutes \(not delivered yet\)/);
    const dist = await s.call('distribute_plan', { call_id: id });
    assert.match(dist.text, /## crm → agent\nPut this in the CRM with your own tools[\s\S]*record_output[\s\S]*"name": "Acme"/);
    assert.match(dist.text, /## doc → webhook\nMinutes → https:\/\/docs\.example\/minutes-1/);
    assert.equal(hook.requests.length, 1);
    const sent = hook.requests[0]!;
    assert.equal((JSON.parse(sent.body) as { event: string; doc: { markdown: string } }).event, 'doc');
    assert.equal(sent.headers['x-oma-signature'], `sha256=${createHmac('sha256', 'shh').update(sent.body).digest('hex')}`);
    await s.call('record_output', { call_id: id, kind: 'crm', url: 'https://crm.example/deals/9' });
    assert.match((await s.call('call_status', { call_id: id })).text, /→ delivered \(agent: https:\/\/crm\.example\/deals\/9\)\nDocument: Minutes → delivered \(webhook: https:\/\/docs\.example\/minutes-1\)/);
    assert.match((await s.call('distribute_plan', { call_id: id, only: 'doc' })).text, /Already delivered/);
    assert.equal(hook.requests.length, 1);
  } finally {
    await s.close();
    await hook.close();
  }
});

test('in the meeting with a model: it answers by itself and creates the task asked for; after the call the plan goes to ClickUp, HubSpot and Notion', async () => {
  const brain = await fakeServer(({ body, n }) => {
    const b = JSON.parse(body) as { system: string };
    const out = /live meeting/.test(b.system)
      ? { reply: 'Sure, creating it now.', note: 'Bruno wants the login page fixed this week.', task: { title: 'Fix the login page', description: 'Asked by Bruno.', priority: 'high' } }
      : {
        title: 'Login and onboarding', summary: 'SSO for Acme.', questions: [],
        tasks: [{ title: 'Add SSO to the login page', description: 'd', acceptance: ['works with Google'], frames: ['F1'], deliverable: 'issue', priority: 'medium', depends_on: [] }],
        crm: { company: { name: 'Acme', domain: 'acme.com' }, contacts: [{ name: 'Ana Souza', email: 'ana@acme.com', role: 'CTO' }], deal: { name: 'Acme rollout', amount: 12000, currency: 'usd', close_date: '2026-12-31' }, summary: 'Acme wants SSO.', next_steps: ['Send the proposal'] },
        doc: { title: 'Minutes', markdown: '# Minutes\n\n## Decisions\n- **SSO** first\n- [ ] Send the proposal' },
      };
    return { json: anthropicAnswer(out, n) };
  });
  const clickup = await fakeServer(({ n }) => ({ json: { id: `cu${n}`, url: `https://app.clickup.com/t/cu${n}` } }));
  const hubspot = await fakeServer(({ path: p, n }) => (p.endsWith('/search') ? { json: { results: [] } }
    : p.startsWith('/account-info') ? { json: { portalId: 42 } } : { status: 201, json: { id: String(100 + n) } }));
  const notion = await fakeServer(() => ({ json: { id: 'pg-1', url: 'https://www.notion.so/pg1' } }));
  const script = [{ after_ms: 1200, type: 'caption', seg: 's1', speaker: 'Bruno', text: 'Meeting Agent, please create a task to fix the login page.', final: true }];
  const s = await connect({
    FAKE_BOT_LIVE: JSON.stringify(script),
    OMA_LLM_PROVIDER: 'anthropic', OMA_LLM_MODEL: 'fake-model', OMA_LLM_BASE_URL: brain.url, OMA_LLM_API_KEY: 'k',
    CLICKUP_API_TOKEN: 'cu-token', OMA_CLICKUP_LIST_ID: 'L1', OMA_CLICKUP_API_URL: clickup.url,
    HUBSPOT_TOKEN: 'hs-token', OMA_HUBSPOT_API_URL: hubspot.url,
    NOTION_TOKEN: 'nt-token', OMA_NOTION_PARENT_PAGE_ID: 'parent-1', OMA_NOTION_API_URL: notion.url,
  });
  try {
    const joined = await s.call('join_meeting', {
      url: 'https://meet.google.com/abc-defg-hij', title: 'Acme onboarding', act: 'both', autonomy: 'issues',
      outputs: { tasks: 'clickup', crm: 'hubspot', doc: 'notion' },
    });
    assert.equal(joined.isError, false, joined.text);
    assert.match(joined.text, /Outputs: tasks → clickup, crm → hubspot, doc → notion/);
    assert.match(joined.text, /answers by itself \(anthropic:fake-model\)/);
    const id = idOf(joined.text);

    // Bruno asks; the agent answers in the chat and creates the task right away.
    const cmds = await waitFor(() => commandsOf(id), (c) => c.some((t) => t.startsWith('✓ ')), 30_000);
    assert.match(cmds[0]!, /^Hi! I'm Meeting Agent/);
    assert.ok(cmds.includes('Sure, creating it now.'), cmds.join(' | '));
    assert.ok(cmds.includes('✓ Fix the login page — https://app.clickup.com/t/cu1'), cmds.join(' | '));
    const live = JSON.parse(clickup.requests[0]!.body) as { name: string; priority: number; markdown_content: string };
    assert.equal(live.name, 'Fix the login page');
    assert.equal(live.priority, 2);
    assert.match(live.markdown_content, /Asked for during the meeting \*\*Acme onboarding\*\* by Bruno/);
    const st = await s.call('call_status', { call_id: id });
    assert.match(st.text, /tasks asked for in the meeting: created right away in clickup/);
    assert.match(st.text, /Created in the meeting:\n- Fix the login page https:\/\/app\.clickup\.com\/t\/cu1/);

    // After the call: plan by the model, then the outputs.
    await s.call('end_meeting', { call_id: id });
    const done = await waitFor(() => s.call('call_status', { call_id: id }), (r) => /Document: Minutes → delivered|Status: failed/.test(r.text), 60_000);
    assert.match(done.text, /Status: planned/);
    assert.match(done.text, /t1 Add SSO to the login page \[todo · issue · medium · ready\] https:\/\/app\.clickup\.com\/t\/cu2/);
    assert.match(done.text, /Notes:\n- During the meeting \(Bruno\): Bruno wants the login page fixed this week\./);
    assert.match(done.text, /CRM update: Acme · 1 contact\(s\) · deal "Acme rollout" → delivered \(hubspot: https:\/\/app\.hubspot\.com\/contacts\/42\/record\/0-3\/\d+\)/);
    assert.match(done.text, /Document: Minutes → delivered \(notion: https:\/\/www\.notion\.so\/pg1\)/);

    // The plan knew what happened in the meeting and was asked for the CRM and the document.
    const planReq = brain.requests.map((r) => JSON.parse(r.body) as { system: string; messages: Array<{ content: Array<{ type: string; text?: string }> }> })
      .find((b) => !/live meeting/.test(b.system))!;
    const planText = planReq.messages[0]!.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    assert.match(planReq.system, /"crm": what the call means for the CRM[\s\S]*"doc": the meeting document/);
    assert.match(planText, /<created_during_meeting>\nTasks already created during the meeting:\n- Fix the login page \(https:\/\/app\.clickup\.com\/t\/cu1\)/);
    assert.match(planText, /During the meeting \(Bruno\): Bruno wants the login page fixed this week\./);

    // ClickUp: the plan's task, with its criteria.
    assert.equal(clickup.requests.length, 2);
    assert.equal(clickup.requests[1]!.path, '/list/L1/task');
    assert.equal(clickup.requests[1]!.headers.authorization, 'cu-token');
    assert.match((JSON.parse(clickup.requests[1]!.body) as { markdown_content: string }).markdown_content, /### Acceptance criteria\n- \[ \] works with Google/);

    // HubSpot: company, contact, deal and the note, associated.
    assert.deepEqual(hubspot.requests.map((r) => `${r.method} ${r.path}`), [
      'POST /crm/v3/objects/companies/search', 'POST /crm/v3/objects/companies',
      'POST /crm/v3/objects/contacts/search', 'POST /crm/v3/objects/contacts',
      'POST /crm/v3/objects/deals', 'POST /crm/v3/objects/notes', 'GET /account-info/v3/details',
    ]);
    assert.equal(hubspot.requests[0]!.headers.authorization, 'Bearer hs-token');
    const typeIds = (i: number) => (JSON.parse(hubspot.requests[i]!.body) as { associations?: Array<{ types: Array<{ associationTypeId: number }> }> })
      .associations?.map((a) => a.types[0]!.associationTypeId) ?? [];
    assert.deepEqual(typeIds(3), [279]);            // contact → company
    assert.deepEqual(typeIds(4), [3, 341]);         // deal → contact, company
    assert.deepEqual(typeIds(5), [202, 190, 214]);  // note → contact, company, deal
    const deal = JSON.parse(hubspot.requests[4]!.body) as { properties: Record<string, string> };
    assert.equal(deal.properties.amount, '12000');
    assert.equal(deal.properties.dealstage, 'appointmentscheduled');

    // Notion: a page under the parent, the markdown as blocks.
    const page = JSON.parse(notion.requests[0]!.body) as { parent: { page_id: string }; children: Array<{ type: string }> };
    assert.equal(notion.requests[0]!.path, '/pages');
    assert.equal(notion.requests[0]!.headers['notion-version'], '2022-06-28');
    assert.equal(page.parent.page_id, 'parent-1');
    assert.deepEqual(page.children.map((c) => c.type), ['heading_1', 'heading_2', 'bulleted_list_item', 'to_do']);
  } finally {
    await s.close();
    await Promise.all([brain.close(), clickup.close(), hubspot.close(), notion.close()]);
  }
});
