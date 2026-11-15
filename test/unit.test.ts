import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { applySpeakers, parseTimeline } from '../src/asr/align.js';
import { changedInstants, extractFrames, spread } from '../src/media/ffmpeg.js';
import { normalizePlan, parseJsonObject } from '../src/plan/normalize.js';
import { buildPlanBlocks, fmtTime } from '../src/plan/prompt.js';
import { readMeetilyMeeting, listMeetilyMeetings } from '../src/sources/meetily.js';
import { detectProvider } from '../src/sources/bot.js';
import { makeMeetingVideo, tempDir } from './helpers.js';

test('normalizePlan: frames, repository, dependencies, empty plan', () => {
  const plan = normalizePlan({
    title: '  Due dates  ',
    summary: 'S',
    questions: ['Q?', ''],
    tasks: [
      { title: 'Show the due date', description: 'd', acceptance: ['a', 'b'], frames: ['f2', 'F9'], repo: null, deliverable: 'pr', priority: 'high', depends_on: [] },
      { title: '', description: 'dropped' },
      { title: 'Filter by date', frames: ['F1'], repo: 'app', deliverable: 'pr', priority: 'nope', depends_on: [1, 3, 't1', 0] },
      { title: 'Decide the colors', deliverable: 'issue', depends_on: [2] },
    ],
  }, ['F1', 'F2'], ['acme/app'], 'host');
  assert.ok(plan);
  assert.equal(plan.title, 'Due dates');
  assert.deepEqual(plan.questions, ['Q?']);
  assert.equal(plan.tasks.length, 3);
  const [a, b, c] = plan.tasks;
  assert.deepEqual(a!.frames, ['F2']);                // unknown F9 dropped, case fixed
  assert.equal(a!.repo, 'acme/app');                 // the only repository for a code task
  assert.equal(b!.key, 't3');                         // keys follow the model's numbering
  assert.equal(b!.repo, 'acme/app');                 // "app" matched by name
  assert.equal(b!.priority, null);
  assert.deepEqual(b!.depends_on, ['t1']);            // only earlier tasks, deduped
  assert.equal(c!.deliverable, 'issue');
  assert.equal(c!.repo, null);
  assert.deepEqual(c!.depends_on, []);                // t2 was dropped (no title)
  assert.equal(a!.state, 'todo');
  assert.equal(normalizePlan({ tasks: [] }, [], [], 'host'), null);
});

test('parseJsonObject: bare, fenced, with prose around', () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonObject('Here:\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseJsonObject('Plan follows {"a":3} done'), { a: 3 });
  assert.equal(parseJsonObject('no json'), null);
});

test('buildPlanBlocks: frames between the lines of their moment, notes at the end', () => {
  const blocks = buildPlanBlocks({
    title: 'T',
    repos: ['acme/app'],
    segments: [
      { start: 1, end: 2, speaker: 'Ana', text: 'first' },
      { start: 5, end: 6, speaker: 'Ana', text: 'second' },
    ],
    frames: [{ label: 'F1', t: 3, file: '/x/F1.jpg' }],
    notes: [{ text: 'also the mobile view' }],
  });
  const kinds = blocks.map((b) => (b.type === 'image' ? `img:${b.label}` : b.text.split('\n')[0]));
  assert.match(kinds[1]!, /^\[00:01\] Ana: first/);
  assert.match(kinds[2]!, /^\[F1 · 00:03\]/);
  assert.equal(kinds[3], 'img:F1');
  assert.match(kinds[4]!, /^\[00:05\] Ana: second/);
  assert.match((blocks.at(-1) as { text: string }).text, /notes_after_call[\s\S]*also the mobile view/);
  assert.equal(fmtTime(3725), '01:02:05');
});

test('speakers from the bot timeline: the turn with the most overlap', () => {
  const turns = parseTimeline(JSON.stringify({ transcriptEntries: [
    { participant: { displayName: 'Ana' }, startTime: '0.000s', endTime: '4.000s' },
    { participant: { displayName: 'Bruno' }, startTime: '4.000s', endTime: '9.000s' },
  ] }));
  const out = applySpeakers([
    { start: 1, end: 3, speaker: 'Unknown', text: 'a' },
    { start: 3.5, end: 8, speaker: 'Unknown', text: 'b' },
    { start: 20, end: 21, speaker: 'Unknown', text: 'c' },
  ], turns);
  assert.deepEqual(out.map((s) => s.speaker), ['Ana', 'Bruno', 'Unknown']);
  assert.deepEqual(parseTimeline('not json'), []);
});

test('meeting links', () => {
  assert.equal(detectProvider('https://meet.google.com/abc-defg-hij'), 'google_meet');
  assert.equal(detectProvider('https://teams.microsoft.com/l/meetup-join/x'), 'microsoft_teams');
  assert.equal(detectProvider('https://teams.live.com/meet/123'), 'microsoft_teams');
  assert.equal(detectProvider('http://meet.google.com/abc'), null);
  assert.equal(detectProvider('https://evil.com/meet.google.com'), null);
});

test('frames: the moments the screen changed, spread and extracted', async () => {
  const dir = tempDir();
  const video = makeMeetingVideo(path.join(dir, 'call.mp4'));
  const found = await changedInstants(video);
  assert.ok(found.times.length >= 3, `expected ≥ 3 changes, got ${found.times.join(',')}`);
  assert.equal(found.width, 640);
  const frames = await extractFrames(video, path.join(dir, 'frames'), { max: 3, offset: 10 });
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((f) => f.label), ['F1', 'F2', 'F3']);
  assert.ok(frames.every((f) => existsSync(f.file)));
  assert.equal(frames[0]!.t, 10);                     // shifted by the offset
  assert.deepEqual(spread([1, 2, 3, 4, 5, 6, 7, 8, 9], 3), [1, 5, 9]);
});

test('meetily: timed transcript, speakers, notes and audio from its SQLite', async () => {
  const dir = tempDir();
  const db = path.join(dir, 'meeting_minutes.sqlite');
  const folder = path.join(dir, 'Standup_2026');
  mkdirSync(folder);
  writeFileSync(path.join(folder, 'audio.mp4'), 'fake');
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(db);
  // meetily's schema (initial migration + the later columns used here)
  d.exec(`CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, folder_path TEXT);
    CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, transcript TEXT NOT NULL, timestamp TEXT NOT NULL, summary TEXT, action_items TEXT, key_points TEXT, audio_start_time REAL, audio_end_time REAL, duration REAL, speaker TEXT);
    CREATE TABLE meeting_notes (meeting_id TEXT PRIMARY KEY NOT NULL, notes_markdown TEXT, notes_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  d.prepare('INSERT INTO meetings VALUES (?, ?, ?, ?, ?)').run('m1', 'Standup', '2026-11-15T10:00:00Z', '2026-11-15T10:20:00Z', folder);
  const ins = d.prepare('INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration, speaker) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run('t2', 'm1', 'Sure, I will look.', '2026-11-15T10:00:09Z', 8.5, 10, 1.5, 'system');
  ins.run('t1', 'm1', 'Can you add a filter?', '2026-11-15T10:00:03Z', 2, 4.5, 2.5, 'mic');
  d.prepare('INSERT INTO meeting_notes VALUES (?, ?, ?, ?, ?)').run('m1', '- filter by date', null, 'x', 'x');
  d.close();

  const list = await listMeetilyMeetings(10, db);
  assert.equal(list[0]!.segments, 2);
  const m = await readMeetilyMeeting('m1', db);
  assert.deepEqual(m.segments.map((s) => [s.start, s.speaker, s.text]), [
    [2, 'Me', 'Can you add a filter?'],
    [8.5, 'Others', 'Sure, I will look.'],
  ]);
  assert.equal(m.notes, '- filter by date');
  assert.equal(m.audio, path.join(folder, 'audio.mp4'));
  await assert.rejects(readMeetilyMeeting('nope', db), /not found/);
});
