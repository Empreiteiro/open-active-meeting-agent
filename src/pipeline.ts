// The life of a call:
//   join (bot) ─┐  (act during/both: answers in the meeting while it lasts — live.ts)
//   huddle ─────┤  (a meeting in the web UI: the page records, the UI server plays the bot)
//   meetily ────┼─→ processing (transcript + screen frames) → needs_plan → planned → outputs
//   file ───────┘                       (tasks platform, CRM, document — outputs/) → tasks
// Long work runs in a detached worker process (`oma worker <id>`), so it keeps
// going when the MCP server or the CLI that started it exits.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySpeakers, parseTimeline } from './asr/align.js';
import { transcribe } from './asr/index.js';
import { config } from './config.js';
import { liveStep } from './live.js';
import { llmConfigured } from './llm/index.js';
import { extractFrames, probe } from './media/ffmpeg.js';
import { actsAfter, actsDuring, defaultOutputs, deliverOutputs, isLiveSource, outputsOf, parseOutputs } from './outputs/index.js';
import { buildPlan, PlanEmptyError } from './plan/build.js';
import {
  botOutputs, botStatus, containerRunning, detectProvider, killBot, requestLeave, startBot,
} from './sources/bot.js';
import { huddleAlive, huddleHasRecording, huddleRecording, initHuddle } from './sources/huddle.js';
import { readMeetilyMeeting } from './sources/meetily.js';
import { findScreenRecording } from './sources/screen.js';
import {
  callPaths, createCall, getPlan, getTranscript, logCall, mustGetCall, saveFrames, saveTranscript, tryLock, unlock, updateCall,
} from './store.js';
import type { ActMode, Autonomy, Call, OutputKind } from './types.js';

// ── Worker process ─────────────────────────────────────────────────────────

function cliEntry(): { args: string[]; cwd: string } {
  const self = fileURLToPath(import.meta.url);
  if (process.env.OMA_CLI_PATH) return { args: [process.env.OMA_CLI_PATH], cwd: path.dirname(process.env.OMA_CLI_PATH) };
  // Bundled: this file is the CLI itself (dist/oma.mjs).
  if (self.endsWith('.mjs') || self.endsWith('.js')) return { args: [self], cwd: path.dirname(self) };
  // From the sources (tsx): src/cli.ts next to this file.
  const root = path.resolve(path.dirname(self), '..');
  return { args: ['--import', 'tsx', path.join(path.dirname(self), 'cli.ts')], cwd: root };
}

/** Start `oma worker <id>` detached from this process. */
export function spawnWorker(callId: string): void {
  const { args, cwd } = cliEntry();
  const out = openSync(path.join(callPaths(callId).dir, 'worker.log'), 'a');
  const p = spawn(process.execPath, ['--no-warnings', ...args, 'worker', callId], {
    cwd, detached: true, stdio: ['ignore', out, out], env: { ...process.env },
  });
  p.unref();
}

// ── Starting a call ────────────────────────────────────────────────────────

export interface CallOptions {
  title?: string;
  agentName?: string;
  autonomy?: Autonomy;
  /** When the agent acts (bot calls): after the call, during it, or both. */
  act?: ActMode;
  /** Where the outputs go: a target per kind, or "none". */
  outputs?: Partial<Record<OutputKind, string | null>>;
  repos?: string[];
  workdir?: string | null;
  language?: string;
}

const base = (o: CallOptions) => ({
  autonomy: o.autonomy ?? config.autonomy,
  act: o.act ?? config.act,
  outputs: parseOutputs(o.outputs, defaultOutputs()),
  repos: (o.repos ?? []).map((r) => r.trim()).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)),
  workdir: o.workdir ?? null,
  agent_name: o.agentName ?? config.agentName,
  language: o.language ?? config.language,
});

export async function joinMeeting(url: string, o: CallOptions = {}): Promise<Call> {
  const provider = detectProvider(url);
  if (!provider) throw new Error('Only Google Meet (https://meet.google.com/…) and Microsoft Teams links are supported.');
  const call = createCall({
    ...base(o), title: o.title ?? `Meeting ${new Date().toLocaleString()}`, source: 'bot', status: 'joining',
    meeting_url: url, provider,
  });
  try {
    const container = await startBot(call.id, { url, provider, displayName: call.agent_name, live: actsDuring(call) });
    updateCall(call.id, { container });
  } catch (e) {
    updateCall(call.id, { status: 'failed', error: (e as Error).message });
    throw e;
  }
  spawnWorker(call.id);
  return mustGetCall(call.id);
}

/** A huddle in the web UI: you share your screen and talk there; the agent
 *  listens and answers (act both unless asked otherwise). The page records. */
export function startHuddle(o: CallOptions & { speaker?: string; spokenLanguage?: string | null } = {}): Call {
  const call = createCall({
    ...base(o), act: o.act ?? 'both', title: o.title ?? `Huddle ${new Date().toLocaleString()}`, source: 'huddle', status: 'in_call',
    joined_at: new Date().toISOString(), spoken_language: o.spokenLanguage ?? null,
  });
  initHuddle(call.id, o.speaker?.trim().slice(0, 60) || 'Me', config.asr !== 'none');
  spawnWorker(call.id);
  return call;
}

export async function importRecording(file: string, o: CallOptions = {}): Promise<Call> {
  const abs = path.resolve(file);
  if (!existsSync(abs)) throw new Error(`file not found: ${abs}`);
  await probe(abs); // fails early on something ffmpeg can't read
  const call = createCall({ ...base(o), act: 'after', title: o.title ?? path.basename(abs), source: 'file', status: 'processing' });
  const media = callPaths(call.id).media;
  mkdirSync(media, { recursive: true });
  copyFileSync(abs, path.join(media, `input${path.extname(abs) || '.bin'}`));
  spawnWorker(call.id);
  return call;
}

export async function importMeetily(meetingId: string, o: CallOptions = {}): Promise<Call> {
  const m = await readMeetilyMeeting(meetingId);
  const call = createCall({
    ...base(o), act: 'after', title: o.title ?? m.meeting.title ?? 'meetily meeting', source: 'meetily', status: 'processing', meetily_id: meetingId,
  });
  if (m.segments.length) saveTranscript(call.id, m.segments);
  if (m.notes?.trim()) updateCall(call.id, { notes: [{ at: new Date().toISOString(), text: `Notes taken during the meeting:\n${m.notes.trim()}` }] });
  const media = callPaths(call.id).media;
  mkdirSync(media, { recursive: true });
  if (m.audio) copyFileSync(m.audio, path.join(media, `input${path.extname(m.audio)}`));
  // The screen, when it was recorded here at the same time (screen_capture).
  const last = m.segments.at(-1)?.end ?? 0;
  const startIso = m.meeting.created_at;
  const endIso = Number.isFinite(Date.parse(startIso)) ? new Date(Date.parse(startIso) + Math.max(last, 60) * 1000).toISOString() : null;
  const screen = Number.isFinite(Date.parse(startIso)) ? findScreenRecording(startIso, endIso) : null;
  if (screen) {
    copyFileSync(screen.file, path.join(media, 'screen.mp4'));
    writeOffset(call.id, screen.offset);
  }
  spawnWorker(call.id);
  return mustGetCall(call.id);
}

function writeOffset(callId: string, offset: number) {
  updateCall(callId, { exit: { ...(mustGetCall(callId).exit ?? {}), screen_offset: offset } });
}

// ── Ending a call ──────────────────────────────────────────────────────────

export async function endMeeting(callId: string): Promise<Call> {
  const call = mustGetCall(callId);
  if (!isLiveSource(call)) throw new Error('Only a meeting the agent is in (the bot, or a huddle) can be ended.');
  if (!['joining', 'in_call'].includes(call.status)) throw new Error(`The call is ${call.status}, not in the meeting.`);
  requestLeave(callId);
  logCall(callId, 'leave requested');
  // The worker may have died with the machine: make sure one is watching.
  spawnWorker(callId);
  return mustGetCall(callId);
}

export async function cancelMeeting(callId: string): Promise<Call> {
  const call = mustGetCall(callId);
  if (call.source === 'huddle') {
    // The page is told to stop (and its uploads refused) once the call is cancelled.
    const done = updateCall(callId, { status: 'cancelled', ended_at: new Date().toISOString() });
    rmSync(callPaths(callId).bot, { recursive: true, force: true });
    return done;
  }
  if (call.source === 'bot') {
    requestLeave(callId, true);
    await killBot(callId);
    rmSync(callPaths(callId).bot, { recursive: true, force: true });
  }
  return updateCall(callId, { status: 'cancelled', ended_at: new Date().toISOString() });
}

// ── The worker ─────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Follow the bot until it leaves, then process. Idempotent; one per call (lock). */
export async function runWorker(callId: string): Promise<void> {
  if (!tryLock(callId)) return;
  try {
    let call = mustGetCall(callId);
    if (call.status === 'cancelled') return;
    if (isLiveSource(call) && ['joining', 'in_call'].includes(call.status)) {
      call = await followBot(callId);
      if (call.status !== 'processing') return;
    }
    // Only the worker that processed the call plans it and starts the agent:
    // a worker started again later must not run the agent twice.
    if (call.status === 'processing' || (call.status === 'failed' && !getTranscript(callId))) {
      await processCall(callId);
      await afterProcessing(callId);
    }
  } catch (e) {
    updateCall(callId, { status: 'failed', error: (e as Error).message.slice(0, 500) });
  } finally {
    unlock(callId);
  }
}

async function followBot(callId: string): Promise<Call> {
  let gone = 0;
  let lastCheck = 0;
  for (;;) {
    const call = mustGetCall(callId);
    if (call.status === 'cancelled') return call;
    const st = botStatus(callId);
    if (st?.state === 'in_call' && call.status !== 'in_call') updateCall(callId, { status: 'in_call', joined_at: new Date().toISOString() });
    // In the meeting (act during/both): answer when someone addresses the agent.
    const live = actsDuring(call);
    if (live) await liveStep(callId).catch((e) => logCall(callId, `live: ${(e as Error).message}`));
    await sleep(live ? 1_000 : 3_000);
    if (Date.now() - lastCheck < 3_000) continue;
    lastCheck = Date.now();
    if (st?.state === 'failed') {
      return updateCall(callId, { status: 'failed', error: `The bot failed${st.step && st.step !== 'bot' ? ` (${st.step})` : ''}: ${st.error ?? 'unknown error'}`, ended_at: new Date().toISOString() });
    }
    if (st?.state === 'done') {
      const out = botOutputs(callId);
      return updateCall(callId, { status: 'processing', ended_at: new Date().toISOString(), exit: out.exit });
    }
    // The container (a huddle: its page) is gone without saying "done" (killed, crashed): use what it left.
    const huddle = call.source === 'huddle';
    if (!(huddle ? huddleAlive(callId) : await containerRunning(callId))) {
      if (++gone >= 3) {
        const out = botOutputs(callId);
        if (huddle ? huddleHasRecording(callId) : out.audio || out.video) return updateCall(callId, { status: 'processing', ended_at: new Date().toISOString(), exit: out.exit });
        return updateCall(callId, {
          status: 'failed', ended_at: new Date().toISOString(),
          error: huddle ? 'The huddle stopped without a recording.' : 'The bot stopped without a recording (see `docker logs` or worker.log).',
        });
      }
    } else gone = 0;
  }
}

/** Transcript + frames. A meetily import already has its transcript. */
export async function processCall(callId: string): Promise<Call> {
  const call = updateCall(callId, { status: 'processing', error: null });
  const p = callPaths(callId);
  let audio: string | null = null;
  let video: string | null = null;
  let timeline: string | null = null;
  let offset = 0;
  if (call.source === 'bot') {
    const out = botOutputs(callId);
    audio = out.audio;
    video = out.video;
    timeline = out.timeline;
  } else if (call.source === 'huddle') {
    const h = await huddleRecording(callId, call.agent_name);
    audio = h.media;
    video = h.hasVideo ? h.media : null;
    timeline = h.timeline;
  } else {
    const anyInput = findInput(p.media);
    if (anyInput) {
      const info = await probe(anyInput);
      audio = info.hasAudio ? anyInput : null;
      video = info.hasVideo ? anyInput : null;
    }
    const screen = path.join(p.media, 'screen.mp4');
    if (existsSync(screen)) {
      video = screen;
      offset = Number((call.exit as { screen_offset?: number } | null)?.screen_offset ?? 0);
    }
  }
  if (!getTranscript(callId)) {
    const media = audio ?? video;
    if (!media) throw new Error('No recording to transcribe.');
    logCall(callId, `transcribing with ${config.asr}`);
    let segs = await transcribe(media, p.dir, config.asrLanguage ?? call.spoken_language ?? null);
    segs = applySpeakers(segs, parseTimeline(timeline ? readFileSync(timeline, 'utf8') : null));
    saveTranscript(callId, segs);
    logCall(callId, `transcript: ${segs.length} segment(s)`);
  }
  if (video) {
    try {
      const frames = await extractFrames(video, p.framesDir, { offset });
      saveFrames(callId, frames);
      logCall(callId, `frames: ${frames.length}`);
    } catch (e) {
      logCall(callId, `frames failed: ${(e as Error).message}`);
    }
  }
  return updateCall(callId, { status: 'needs_plan' });
}

/** The imported recording (media/input.<ext>). */
function findInput(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((x) => x.startsWith('input.'));
  return f ? path.join(dir, f) : null;
}

/** After processing: the plan (when a model is configured), the outputs
 *  (autonomy issues/prs: tasks platform, CRM, document), and the coding agent
 *  (OMA_AGENT_COMMAND). A call where the agent only acted during the meeting
 *  keeps its plan and delivers nothing. */
async function afterProcessing(callId: string): Promise<void> {
  let call = mustGetCall(callId);
  if (call.status !== 'needs_plan' && call.status !== 'planned') return;
  if (!getPlan(callId) && llmConfigured()) {
    try {
      await buildPlan(callId);
    } catch (e) {
      const msg = e instanceof PlanEmptyError ? `plan_empty: ${e.questions.join(' | ') || e.summary}` : (e as Error).message;
      logCall(callId, `plan failed: ${msg}`);
      if (!(e instanceof PlanEmptyError)) updateCall(callId, { error: msg.slice(0, 500) });
    }
  }
  call = mustGetCall(callId);
  if (!actsAfter(call)) {
    logCall(callId, 'act "during": the plan is kept, nothing is delivered');
    return;
  }
  if (getPlan(callId) && call.autonomy !== 'suggest') {
    try {
      const res = await deliverOutputs(callId);
      logCall(callId, `outputs: ${res.map((r) => `${r.kind}→${r.target} ${r.ok ? 'ok' : 'failed'}`).join(', ') || 'none'}`);
    } catch (e) {
      logCall(callId, `outputs failed: ${(e as Error).message}`);
    }
  }
  runAgentHook(callId);
}

/** What the coding agent is asked to do when the call is ready. */
export function agentPrompt(call: Call, planned: boolean): string {
  const id = call.id;
  const plan = planned
    ? `The plan is ready (get_plan call_id ${id}).`
    : `First build the plan: read the call with get_call_context (call_id ${id}) and save it with save_plan.`;
  const outs = outputsOf(call);
  const forYou = (Object.keys(outs) as OutputKind[]).filter((k) => outs[k] === 'agent');
  const deliver = forYou.length
    ? `deliver the outputs with distribute_plan (call_id ${id}) — the ${forYou.join(', ')} ${forYou.length > 1 ? 'are' : 'is'} yours to put in place with your own tools, then record_output / update_task with the links`
    : `deliver the outputs with distribute_plan (call_id ${id})`;
  const work = call.autonomy === 'suggest'
    ? 'Stop after the plan: the person reviews it before anything else.'
    : call.autonomy === 'issues'
      ? `Then ${deliver}, and stop.`
      : `Then ${deliver}; then work the code tasks one by one: next_task (call_id ${id}), implement, open the pull request, update_task — until next_task says there is nothing left.`;
  return `The meeting "${call.title}" just ended (open-meeting-agent call ${id}). Use the meeting-agent MCP tools. ${plan} ${work}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function runAgentHook(callId: string): boolean {
  if (!config.agentCommand) return false;
  const call = mustGetCall(callId);
  const prompt = agentPrompt(call, !!getPlan(callId));
  const cmd = config.agentCommand
    .replaceAll('{prompt}', shellQuote(prompt))
    .replaceAll('{call_id}', call.id)
    .replaceAll('{workdir}', shellQuote(call.workdir ?? process.cwd()));
  const out = openSync(path.join(callPaths(callId).dir, 'agent.log'), 'a');
  const p = spawn(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd], {
    cwd: call.workdir && existsSync(call.workdir) ? call.workdir : config.home,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, OMA_CALL_ID: call.id },
  });
  p.unref();
  logCall(callId, `agent started: ${config.agentCommand.split(' ')[0]}`);
  return true;
}
