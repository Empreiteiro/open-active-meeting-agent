// The MCP server: what any agent (Claude Code, Claude Desktop, Cursor, Codex,
// VS Code, Windsurf…) uses to send the agent into a meeting and to act on it
// afterwards. stdio transport; everything stays on this machine.

import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config } from '../config.js';
import { distributePlan } from '../github.js';
import { llmConfigured } from '../llm/index.js';
import { spread } from '../media/ffmpeg.js';
import {
  agentPrompt, cancelMeeting, endMeeting, importMeetily, importRecording, joinMeeting, runAgentHook, spawnWorker,
} from '../pipeline.js';
import { buildPlan, callBlocks, PlanEmptyError, saveHostPlan } from '../plan/build.js';
import { planRules } from '../plan/prompt.js';
import { botImageReady, buildBotImage, containerEngine } from '../sources/bot.js';
import { listMeetilyMeetings } from '../sources/meetily.js';
import { screenStatus, startScreenCapture, stopScreenCapture } from '../sources/screen.js';
import { getFrames, getPlan, latestCall, listCalls, logCall, mustGetCall, updateCall } from '../store.js';
import { mustGetPlan, nextTask, taskBrief, updateTask } from '../tasks.js';
import type { Autonomy, Frame } from '../types.js';
import { callLine, callSummary, frameThumb, planDetail, planText } from '../views.js';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/** call_id is optional everywhere: the latest call. */
function resolveCall(id?: string) {
  if (id) return mustGetCall(id);
  const c = latestCall();
  if (!c) throw new Error('There is no call yet. Start one with join_meeting, import_meetily or import_recording.');
  return c;
}

async function image(f: Frame): Promise<Content> {
  return { type: 'image', data: readFileSync(await frameThumb(f)).toString('base64'), mimeType: 'image/jpeg' };
}

const AUTONOMY = z.enum(['suggest', 'issues', 'prs']);
const REPOS = z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).optional();

const INSTRUCTIONS = `open-meeting-agent sends an agent into a Google Meet / Teams call (or imports a meeting recorded with meetily or a file), watches the shared screen, and turns what was asked into a plan of tasks that you then carry out.

Flow: join_meeting (the bot joins; someone admits it) → the person explains and shares the screen → end_meeting (or the meeting ends) → call_status until "needs_plan" → get_call_context (transcript + screens) → save_plan (or build_plan when a planning model is configured) → distribute_plan (GitHub issues, optional) → next_task / update_task until nothing is left.

Autonomy of a call: suggest = stop after the plan for the person to review; issues = also open the issues; prs = also do the tasks and open the pull requests without asking. call_id is optional: tools default to the latest call.`;

export function createServer(): McpServer {
  const server = new McpServer({ name: 'open-meeting-agent', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const tool = server.registerTool.bind(server);

  const guard = <A>(fn: (a: A) => Promise<{ content: Content[]; isError?: boolean }>) => async (a: A) => {
    try {
      return await fn(a);
    } catch (e) {
      if (e instanceof PlanEmptyError) {
        return fail(`No task came out of the call.${e.summary ? `\nWhat was understood: ${e.summary}` : ''}${e.questions.length ? `\nQuestions for the person:\n${e.questions.map((q) => `- ${q}`).join('\n')}` : ''}\nAsk the person, save their answer with add_note (replan: true), or build the plan yourself with get_call_context + save_plan.`);
      }
      return fail((e as Error).message);
    }
  };

  // ── Into the meeting ────────────────────────────────────────────────────
  tool('join_meeting', {
    title: 'Send the agent into a meeting',
    description: 'Starts the bot: a browser that joins the Google Meet / Microsoft Teams link as the agent, records the call and the shared screen, and reads who is speaking. Someone in the meeting may need to admit it from the lobby. Returns the call id.',
    inputSchema: {
      url: z.string().url().describe('The meeting link (https://meet.google.com/… or a Teams link)'),
      title: z.string().max(200).optional(),
      agent_name: z.string().max(80).optional().describe('Name shown in the meeting'),
      autonomy: AUTONOMY.optional().describe('How far to go after the meeting without asking (default from OMA_AUTONOMY, else suggest)'),
      repos: REPOS.describe('GitHub repositories the tasks may target (owner/repo)'),
      workdir: z.string().optional().describe('Folder the coding agent works in afterwards (default: the server\'s cwd)'),
    },
  }, guard(async (a) => {
    const call = await joinMeeting(a.url, {
      title: a.title, agentName: a.agent_name, autonomy: a.autonomy as Autonomy | undefined, repos: a.repos, workdir: a.workdir ?? process.cwd(),
    });
    return text(`${callSummary(call)}\n\nThe agent is on its way. If the meeting has a lobby, admit "${call.agent_name}". When the person is done, call end_meeting (call_id ${call.id}).`);
  }));

  tool('end_meeting', {
    title: 'End the meeting for the agent',
    description: 'The agent leaves the meeting and the recording is processed (transcript + screen frames). Poll call_status until it says needs_plan.',
    inputSchema: { call_id: z.string().optional() },
  }, guard(async (a) => text(callSummary(await endMeeting(resolveCall(a.call_id).id)))));

  tool('cancel_meeting', {
    title: 'Cancel the meeting',
    description: 'The agent leaves and nothing it recorded is kept or processed.',
    inputSchema: { call_id: z.string().optional() },
  }, guard(async (a) => text(callSummary(await cancelMeeting(resolveCall(a.call_id).id)))));

  // ── Other sources ───────────────────────────────────────────────────────
  tool('import_meetily', {
    title: 'Import a meeting recorded with meetily',
    description: 'Without meeting_id: lists the latest meetings in the local meetily app. With it: imports that meeting (its transcript, notes and audio; the screen too when screen_capture was recording at the time) as a call.',
    inputSchema: {
      meeting_id: z.string().optional(),
      title: z.string().max(200).optional(),
      autonomy: AUTONOMY.optional(),
      repos: REPOS,
      workdir: z.string().optional(),
    },
  }, guard(async (a) => {
    if (!a.meeting_id) {
      const list = await listMeetilyMeetings(20);
      if (!list.length) return text(`No meetings in meetily (${config.meetilyDb}).`);
      return text(`meetily meetings (newest first):\n${list.map((m) => `- ${m.id} · ${m.title} · ${m.created_at} · ${m.segments} segment(s)`).join('\n')}\n\nImport one with import_meetily { meeting_id }.`);
    }
    const call = await importMeetily(a.meeting_id, { title: a.title, autonomy: a.autonomy as Autonomy | undefined, repos: a.repos, workdir: a.workdir ?? process.cwd() });
    return text(callSummary(call));
  }));

  tool('import_recording', {
    title: 'Import a recording',
    description: 'Imports an audio or video file of a meeting (a screen recording works best: the plan uses the screens). It is transcribed and its frames extracted in the background.',
    inputSchema: {
      path: z.string(),
      title: z.string().max(200).optional(),
      autonomy: AUTONOMY.optional(),
      repos: REPOS,
      workdir: z.string().optional(),
    },
  }, guard(async (a) => text(callSummary(await importRecording(a.path, {
    title: a.title, autonomy: a.autonomy as Autonomy | undefined, repos: a.repos, workdir: a.workdir ?? process.cwd(),
  })))));

  tool('screen_capture', {
    title: 'Record this screen',
    description: 'For meetings recorded here (meetily) rather than by the bot: records the local screen (1 frame/s) so the plan can see what was shown. start before the meeting, stop after; import_meetily picks it up by time.',
    inputSchema: { action: z.enum(['start', 'stop', 'status']) },
  }, guard(async (a) => {
    if (a.action === 'start') { const r = startScreenCapture(); return text(`Recording the screen to ${r.file} (since ${r.started_at}).`); }
    if (a.action === 'stop') { const r = await stopScreenCapture(); return text(r ? `Screen recording saved: ${r.file}` : 'No screen recording was running.'); }
    const r = screenStatus();
    return text(r ? `Recording the screen since ${r.started_at}: ${r.file}` : 'Not recording the screen.');
  }));

  // ── Reading a call ──────────────────────────────────────────────────────
  tool('list_calls', {
    title: 'List calls',
    description: 'The calls on this machine, newest first.',
    inputSchema: { limit: z.number().int().min(1).max(100).optional() },
  }, guard(async (a) => {
    const calls = listCalls().slice(0, a.limit ?? 20);
    return text(calls.length ? calls.map(callLine).join('\n') : 'No calls yet.');
  }));

  tool('call_status', {
    title: 'Call status',
    description: 'Where the call is (joining, in_call, processing, needs_plan, planned, failed), the bot\'s state, the transcript and the plan with each task\'s state.',
    inputSchema: { call_id: z.string().optional() },
  }, guard(async (a) => text(callSummary(resolveCall(a.call_id)))));

  tool('get_call_context', {
    title: 'Read the call',
    description: 'The call as one timeline: the transcript with the shared-screen frames placed where they appeared (images), the person\'s notes, and the rules + JSON format for the plan. Read it, then write the plan and save it with save_plan.',
    inputSchema: {
      call_id: z.string().optional(),
      max_images: z.number().int().min(0).max(40).optional().describe('Frames sent as images (default 8, spread over the call); the others can be fetched with get_frames'),
    },
  }, guard(async (a) => {
    const call = resolveCall(a.call_id);
    const { blocks } = callBlocks(call.id);
    const frames = getFrames(call.id);
    const withImage = new Set(spread(frames, a.max_images ?? 8).map((f) => f.label));
    const content: Content[] = [];
    let buf = '';
    for (const b of blocks) {
      if (b.type === 'text') { buf += `${b.text}\n`; continue; }
      const f = frames.find((x) => x.label === b.label);
      if (f && withImage.has(f.label)) {
        if (buf) content.push({ type: 'text', text: buf });
        buf = '';
        content.push(await image(f));
      } else buf += `(${b.label}: not attached — get_frames { labels: ["${b.label}"] })\n`;
    }
    buf += `\n---\nNow write the plan for this call. ${planRules(call.language)}\n\nSave it with save_plan { call_id: "${call.id}", plan: { … } }.`;
    content.push({ type: 'text', text: buf });
    return { content };
  }));

  tool('get_frames', {
    title: 'See frames of the call',
    description: 'Screens of the call as images, by label (F1, F2…).',
    inputSchema: { call_id: z.string().optional(), labels: z.array(z.string()).min(1).max(10) },
  }, guard(async (a) => {
    const call = resolveCall(a.call_id);
    const frames = getFrames(call.id);
    const content: Content[] = [];
    for (const l of a.labels) {
      const f = frames.find((x) => x.label.toUpperCase() === l.toUpperCase());
      if (!f) { content.push({ type: 'text', text: `${l}: no such frame` }); continue; }
      content.push({ type: 'text', text: `${f.label} at ${Math.round(f.t)}s:` }, await image(f));
    }
    return { content };
  }));

  // ── The plan ────────────────────────────────────────────────────────────
  tool('save_plan', {
    title: 'Save the plan',
    description: 'Saves the plan you wrote from get_call_context (validated the same way as a model\'s). Replaces the previous plan.',
    inputSchema: {
      call_id: z.string().optional(),
      plan: z.union([z.string(), z.record(z.unknown())]).describe('{title, summary, questions[], tasks[{title, description, acceptance[], frames[], repo, deliverable, priority, depends_on[]}]}'),
    },
  }, guard(async (a) => {
    const call = resolveCall(a.call_id);
    const plan = saveHostPlan(call.id, a.plan);
    const next = call.autonomy === 'suggest'
      ? 'Show the plan to the person: they review it before anything else.'
      : call.autonomy === 'issues' ? 'Next: distribute_plan.' : 'Next: distribute_plan (if the call has a repository), then next_task.';
    return text(`${planText(plan)}\n\n${next}`);
  }));

  tool('build_plan', {
    title: 'Build the plan with the configured model',
    description: 'Builds the plan with the planning model configured in open-meeting-agent (OMA_LLM_PROVIDER/OMA_LLM_MODEL). Without one, use get_call_context + save_plan.',
    inputSchema: { call_id: z.string().optional() },
  }, guard(async (a) => {
    if (!llmConfigured()) return fail('No planning model is configured here. Read the call with get_call_context and save the plan with save_plan.');
    return text(planText(await buildPlan(resolveCall(a.call_id).id)));
  }));

  tool('get_plan', {
    title: 'Get the plan',
    description: 'The whole plan: every task with its description, criteria, state and links.',
    inputSchema: { call_id: z.string().optional() },
  }, guard(async (a) => {
    const plan = mustGetPlan(resolveCall(a.call_id).id);
    return text(`${planText(plan)}\n\n${planDetail(plan)}`);
  }));

  tool('add_note', {
    title: 'Add a note to the call',
    description: 'What the person explains after the call (an answer to a question, a correction). Notes go into the plan; replan: true rebuilds it with the configured model.',
    inputSchema: { call_id: z.string().optional(), text: z.string().min(1).max(4000), replan: z.boolean().optional() },
  }, guard(async (a) => {
    const call = resolveCall(a.call_id);
    updateCall(call.id, { notes: [...call.notes, { at: new Date().toISOString(), text: a.text }] });
    logCall(call.id, 'note added');
    if (a.replan) {
      if (!llmConfigured()) return text('Note saved. No planning model here: read get_call_context again (it includes the note) and save the new plan with save_plan.');
      return text(`Note saved. ${planText(await buildPlan(call.id))}`);
    }
    return text('Note saved.');
  }));

  tool('set_call', {
    title: 'Change a call',
    description: 'Link repositories, change the autonomy, the work folder or the title (e.g. a call made before the repository was known).',
    inputSchema: {
      call_id: z.string().optional(), title: z.string().max(200).optional(), autonomy: AUTONOMY.optional(), repos: REPOS, workdir: z.string().optional(),
    },
  }, guard(async (a) => {
    const call = resolveCall(a.call_id);
    const patch: Record<string, unknown> = {};
    if (a.title) patch.title = a.title;
    if (a.autonomy) patch.autonomy = a.autonomy;
    if (a.repos) patch.repos = a.repos;
    if (a.workdir) patch.workdir = a.workdir;
    return text(callSummary(updateCall(call.id, patch)));
  }));

  tool('distribute_plan', {
    title: 'Open the GitHub issues',
    description: 'One GitHub issue per task that has a repository (acceptance criteria as a checklist, dependencies linked). Uses GITHUB_TOKEN or the logged-in gh CLI.',
    inputSchema: { call_id: z.string().optional(), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional().describe('For tasks with no repository') },
  }, guard(async (a) => {
    const res = await distributePlan(resolveCall(a.call_id).id, { repo: a.repo });
    return text(res.map((r) => `- ${r.key}: ${r.issue ?? `skipped (${r.skipped})`}`).join('\n'));
  }));

  // ── After the meeting: the work ─────────────────────────────────────────
  tool('next_task', {
    title: 'Take the next task',
    description: 'The task in progress, or the next one whose dependencies are done (it becomes in_progress): the brief, the acceptance criteria and its screens. Do it, then update_task.',
    inputSchema: { call_id: z.string().optional() },
  }, guard(async (a) => {
    const call = resolveCall(a.call_id);
    const n = nextTask(call.id);
    if (n.kind === 'finished') return text('Every task of this plan is done. Tell the person what was delivered (call_status lists the PRs).');
    if (n.kind === 'waiting') return text(`No task is ready: waiting on ${n.blocked.map((t) => `${t.key} [${t.state}]`).join(', ')}.`);
    const { text: brief, frames } = taskBrief(call, getPlan(call.id)!, n.task);
    const content: Content[] = [{ type: 'text', text: `${n.resumed ? '(resuming) ' : ''}${brief}` }];
    for (const f of frames) content.push(await image(f));
    return { content };
  }));

  tool('update_task', {
    title: 'Update a task',
    description: 'Record progress on a task: state (in_progress, blocked, done, skipped), the PR or issue link, a note. Done tasks unlock the ones that depend on them.',
    inputSchema: {
      call_id: z.string().optional(),
      key: z.string().describe('t1, t2…'),
      state: z.enum(['todo', 'in_progress', 'blocked', 'done', 'skipped']).optional(),
      pr_url: z.string().url().optional(),
      issue_url: z.string().url().optional(),
      note: z.string().max(4000).optional(),
      include: z.boolean().optional().describe('false leaves the task out of the plan'),
    },
  }, guard(async (a) => {
    const call = resolveCall(a.call_id);
    const t = updateTask(call.id, a.key, { state: a.state, pr_url: a.pr_url, issue_url: a.issue_url, note: a.note, include: a.include });
    const plan = getPlan(call.id)!;
    return text(`${t.key} → ${t.state}${t.pr_url ? ` (${t.pr_url})` : ''}\n\n${planText(plan)}`);
  }));

  // ── Setup ───────────────────────────────────────────────────────────────
  tool('setup_status', {
    title: 'Check the setup',
    description: 'What is ready on this machine: container engine and bot image, ffmpeg, transcription, planning model, GitHub, meetily.',
    inputSchema: {},
  }, guard(async () => text(await doctor())));

  tool('build_bot', {
    title: 'Build the bot image',
    description: 'Builds the container image the agent joins meetings with (once; takes a few minutes and ~3 GB).',
    inputSchema: {},
  }, guard(async () => {
    const lines: string[] = [];
    await buildBotImage((l) => { lines.push(l); if (lines.length > 30) lines.shift(); });
    return text(`Built ${config.botImage}.\n${lines.slice(-5).join('\n')}`);
  }));

  tool('run_agent', {
    title: 'Start the coding agent on a call',
    description: 'Runs OMA_AGENT_COMMAND for the call now (normally it starts by itself when the call is ready).',
    inputSchema: { call_id: z.string().optional() },
  }, guard(async (a) => {
    const call = resolveCall(a.call_id);
    if (call.status === 'processing') spawnWorker(call.id);
    return text(runAgentHook(call.id) ? 'Started (see agent.log in the call folder).' : 'OMA_AGENT_COMMAND is not set.');
  }));

  server.registerPrompt('work_on_meeting', {
    title: 'Work on a meeting',
    description: 'Plan a call and carry out its tasks.',
    argsSchema: { call_id: z.string().optional() },
  }, (a) => {
    const call = resolveCall(a.call_id);
    return { messages: [{ role: 'user', content: { type: 'text', text: agentPrompt(call, !!getPlan(call.id)) } }] };
  });

  return server;
}

export async function doctor(): Promise<string> {
  const { run } = await import('../media/ffmpeg.js');
  const ok = (b: boolean) => (b ? '✓' : '✗');
  const lines: string[] = [];
  const engine = await containerEngine().catch(() => null);
  lines.push(`${ok(!!engine)} container engine: ${engine ?? 'none running (Docker Desktop / OrbStack / Colima / Podman) — needed to join meetings'}`);
  if (engine) {
    const img = await botImageReady().catch(() => false);
    lines.push(`${ok(img)} bot image ${config.botImage}${img ? '' : ' — build it once: `oma bot build` (or the build_bot tool)'}`);
  }
  const ff = await run(config.ffmpeg, ['-version'], 'ffmpeg', 10_000).then(() => true).catch(() => false);
  lines.push(`${ok(ff)} ffmpeg${ff ? '' : ' — install it (brew install ffmpeg)'}`);
  lines.push(`${ok(config.asr !== 'none')} transcription: ${config.asr === 'whisper-cpp' ? `whisper.cpp (${config.whisperModel})` : config.asr === 'openai' ? `${config.asrBaseUrl} (${config.asrModel})` : 'none — set OMA_WHISPER_MODEL or OMA_ASR_API_KEY (meetily imports don\'t need it)'}`);
  lines.push(`${llmConfigured() ? '✓' : '·'} planning model: ${llmConfigured() ? `${config.llm}:${config.llmModel}` : 'none — the connected agent builds the plan (get_call_context + save_plan)'}`);
  const gh = !!config.githubToken || await run('gh', ['auth', 'status'], 'gh', 10_000).then(() => true).catch(() => false);
  lines.push(`${gh ? '✓' : '·'} GitHub: ${config.githubToken ? 'GITHUB_TOKEN' : gh ? 'gh CLI' : 'not set (only needed for distribute_plan)'}`);
  const meetily = await listMeetilyMeetings(1).then(() => true).catch(() => false);
  lines.push(`${meetily ? '✓' : '·'} meetily: ${meetily ? config.meetilyDb : 'not found (optional)'}`);
  lines.push(`${config.agentCommand ? '✓' : '·'} after the meeting: ${config.agentCommand ? `runs \`${config.agentCommand}\`` : 'OMA_AGENT_COMMAND not set (the agent acts when you ask it)'}`);
  lines.push(`  data: ${config.home}`);
  return lines.join('\n');
}

export async function runMcpServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
