// The MCP server: what any agent (Claude Code, Claude Desktop, Cursor, Codex,
// VS Code, Windsurf…) uses to send the agent into a meeting and to act on it
// afterwards. stdio transport; everything stays on this machine.

import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config, CRM_TARGETS, DOC_TARGETS, TASKS_TARGETS } from '../config.js';
import { liveLineText, sayInMeeting, watchMeeting } from '../live.js';
import { llmConfigured, llmLabel } from '../llm/index.js';
import { spread } from '../media/ffmpeg.js';
import {
  agentPrompt, cancelMeeting, endMeeting, importMeetily, importRecording, joinMeeting, runAgentHook, spawnWorker,
} from '../pipeline.js';
import { actOf, deliverOutputs, outputsOf, parseOutputs, recordOutput, resultsText } from '../outputs/index.js';
import { tasksSetupProblem } from '../outputs/tasks.js';
import { buildPlan, callBlocks, PlanEmptyError, planWants, saveHostPlan } from '../plan/build.js';
import { planRules } from '../plan/prompt.js';
import { botImageReady, buildBotImage, containerEngine } from '../sources/bot.js';
import { listMeetilyMeetings } from '../sources/meetily.js';
import { screenStatus, startScreenCapture, stopScreenCapture } from '../sources/screen.js';
import { getFrames, getPlan, latestCall, listCalls, logCall, mustGetCall, updateCall } from '../store.js';
import { mustGetPlan, nextTask, taskBrief, updateTask } from '../tasks.js';
import type { ActMode, Autonomy, Frame, OutputKind } from '../types.js';
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
const ACT = z.enum(['after', 'during', 'both']);
const REPOS = z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).optional();
const OUTPUT_KIND = z.enum(['tasks', 'crm', 'doc']);
const targets = (xs: readonly string[]) => z.enum([...xs, 'none'] as unknown as [string, ...string[]]);
const OUTPUTS = z.object({
  tasks: targets(TASKS_TARGETS).optional().describe('Where the tasks go: github (issues), linear, jira, clickup, webhook, agent (you, with your own tools), none'),
  crm: targets(CRM_TARGETS).optional().describe('The CRM update (company, contacts, deal, note): hubspot, webhook, agent, none'),
  doc: targets(DOC_TARGETS).optional().describe('The meeting document: file (markdown), notion, webhook, agent, none'),
}).optional().describe('What is delivered after the call and where (default from OMA_TASKS_TARGET / OMA_CRM_TARGET / OMA_DOC_TARGET)');

const INSTRUCTIONS = `open-meeting-agent sends an agent into a Google Meet / Teams call (or imports a meeting recorded with meetily or a file), watches the shared screen, and turns what was asked into a plan — tasks, and when asked a CRM update and a meeting document — that is delivered where the team works and that you then carry out.

Flow: join_meeting (the bot joins; someone admits it) → the person explains and shares the screen → end_meeting (or the meeting ends) → call_status until "needs_plan" → get_call_context (transcript + screens) → save_plan (or build_plan when a planning model is configured) → distribute_plan (the outputs: tasks to GitHub/Linear/Jira/ClickUp, CRM, document) → next_task / update_task until nothing is left.

When the agent acts (act): after = quiet in the meeting, works after it (default); during = answers in the meeting when someone addresses it (by name, in speech or in the chat) and only keeps the plan afterwards; both = in the meeting and after. In the meeting, with no planning model configured, you are its brain: loop watch_meeting and answer the mentions with send_meeting_message.

Autonomy of a call: suggest = stop after the plan for the person to review; issues = also deliver the outputs; prs = also do the code tasks and open the pull requests without asking. call_id is optional: tools default to the latest call.`;

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
      act: ACT.optional().describe('When the agent acts: after the call (default, OMA_ACT), during it (answers in the meeting when addressed), or both'),
      outputs: OUTPUTS,
      repos: REPOS.describe('GitHub repositories the tasks may target (owner/repo)'),
      workdir: z.string().optional().describe('Folder the coding agent works in afterwards (default: the server\'s cwd)'),
    },
  }, guard(async (a) => {
    const call = await joinMeeting(a.url, {
      title: a.title, agentName: a.agent_name, autonomy: a.autonomy as Autonomy | undefined, act: a.act as ActMode | undefined,
      outputs: a.outputs, repos: a.repos, workdir: a.workdir ?? process.cwd(),
    });
    const live = actOf(call) === 'after' ? ''
      : llmConfigured()
        ? `\nIn the meeting the agent answers by itself (${llmLabel()}) when someone says "${call.agent_name}, …" or mentions it in the chat.`
        : `\nIn the meeting you are the agent's brain: loop watch_meeting (call_id ${call.id}) and answer each mention with send_meeting_message; when nobody watches, it answers "noted" and keeps the request for after the call.`;
    return text(`${callSummary(call)}\n\nThe agent is on its way. If the meeting has a lobby, admit "${call.agent_name}". When the person is done, call end_meeting (call_id ${call.id}).${live}`);
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
      outputs: OUTPUTS,
      repos: REPOS,
      workdir: z.string().optional(),
    },
  }, guard(async (a) => {
    if (!a.meeting_id) {
      const list = await listMeetilyMeetings(20);
      if (!list.length) return text(`No meetings in meetily (${config.meetilyDb}).`);
      return text(`meetily meetings (newest first):\n${list.map((m) => `- ${m.id} · ${m.title} · ${m.created_at} · ${m.segments} segment(s)`).join('\n')}\n\nImport one with import_meetily { meeting_id }.`);
    }
    const call = await importMeetily(a.meeting_id, { title: a.title, autonomy: a.autonomy as Autonomy | undefined, outputs: a.outputs, repos: a.repos, workdir: a.workdir ?? process.cwd() });
    return text(callSummary(call));
  }));

  tool('import_recording', {
    title: 'Import a recording',
    description: 'Imports an audio or video file of a meeting (a screen recording works best: the plan uses the screens). It is transcribed and its frames extracted in the background.',
    inputSchema: {
      path: z.string(),
      title: z.string().max(200).optional(),
      autonomy: AUTONOMY.optional(),
      outputs: OUTPUTS,
      repos: REPOS,
      workdir: z.string().optional(),
    },
  }, guard(async (a) => text(callSummary(await importRecording(a.path, {
    title: a.title, autonomy: a.autonomy as Autonomy | undefined, outputs: a.outputs, repos: a.repos, workdir: a.workdir ?? process.cwd(),
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

  // ── In the meeting ──────────────────────────────────────────────────────
  tool('watch_meeting', {
    title: 'Follow the meeting live',
    description: 'What is being said in the meeting right now (caption turns and chat, with who said it) after the line `since`. Waits up to wait_seconds for something new, so call it in a loop while the call is in_call: answer each line flagged as a mention of the agent (send_meeting_message, and your own tools when they ask for something), then call again with since = the returned "next". Needs act during/both to be answered; works for reading on any bot call.',
    inputSchema: {
      call_id: z.string().optional(),
      since: z.number().int().min(0).optional().describe('The "next" of the previous call (0 = from the start)'),
      wait_seconds: z.number().int().min(0).max(50).optional().describe('How long to wait for something new (default 25)'),
    },
  }, guard(async (a) => {
    const c = resolveCall(a.call_id);
    if (c.source !== 'bot') return fail('Only a call the bot joined can be followed live.');
    const r = await watchMeeting(c.id, a.since ?? 0, a.wait_seconds ?? 25);
    const next = r.view.lines.at(-1)?.seq ?? (a.since ?? 0);
    const mention = new Set(r.mentions.map((m) => m.seq));
    const out = [
      `Call ${r.call.id}: ${r.call.status} · act: ${actOf(r.call)} · captions ${r.view.captions === null ? 'not reported yet' : r.view.captions ? 'on' : 'unavailable'} · chat ${r.view.chat ? 'open' : r.view.chat === false ? 'unavailable' : 'not reported yet'}`,
      ...r.lines.map((l) => `${mention.has(l.seq) ? '→ MENTION ' : ''}#${l.seq} ${liveLineText(r.call, l)}`),
      ...r.view.speaking.map((s) => `(speaking) ${liveLineText(r.call, { kind: 'speech', ...s })} …`),
      r.view.failed.length ? `Messages that could not be posted: ${r.view.failed.map((f) => f.error).join('; ')}` : '',
      `next: ${next}`,
      ['joining', 'in_call'].includes(r.call.status)
        ? llmConfigured() && actOf(r.call) !== 'after'
          ? 'The planning model answers the mentions by itself here: don\'t answer them too. watch_meeting again with since = next to keep following.'
          : (r.mentions.length ? 'Answer the mention(s) with send_meeting_message, then watch_meeting again with since = next.' : 'Nothing for you yet: watch_meeting again with since = next.')
        : 'The meeting is over for the agent: stop watching; continue with call_status / the plan.',
    ].filter(Boolean);
    return text(out.join('\n'));
  }));

  tool('send_meeting_message', {
    title: 'Say something in the meeting',
    description: 'Posts a message in the meeting chat as the agent (short: one to three sentences). Use it to answer whoever addressed the agent, confirm what you will do, or share a link you just created.',
    inputSchema: { call_id: z.string().optional(), text: z.string().min(1).max(2000) },
  }, guard(async (a) => {
    const c = resolveCall(a.call_id);
    const r = await sayInMeeting(c.id, a.text, 10_000);
    return r.ok === false ? fail(`Could not post in the meeting chat: ${r.error}`)
      : text(r.ok ? 'Posted in the meeting chat.' : 'Queued: the agent posts it in a moment.');
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
    buf += `\n---\nNow write the plan for this call. ${planRules(call.language, planWants(call))}\n\nSave it with save_plan { call_id: "${call.id}", plan: { … } }.`;
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
      plan: z.union([z.string(), z.record(z.unknown())]).describe('{title, summary, questions[], tasks[{title, description, acceptance[], frames[], repo, deliverable, priority, depends_on[]}], crm?, doc?} — crm/doc when get_call_context asks for them'),
    },
  }, guard(async (a) => {
    const call = resolveCall(a.call_id);
    const plan = saveHostPlan(call.id, a.plan);
    const next = call.autonomy === 'suggest'
      ? 'Show the plan to the person: they review it before anything else.'
      : call.autonomy === 'issues' ? 'Next: distribute_plan.' : 'Next: distribute_plan, then next_task.';
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
    description: 'Link repositories, change the autonomy, when the agent acts (act — also while it is in the meeting), where the outputs go, the work folder or the title.',
    inputSchema: {
      call_id: z.string().optional(), title: z.string().max(200).optional(), autonomy: AUTONOMY.optional(), act: ACT.optional(), outputs: OUTPUTS,
      repos: REPOS, workdir: z.string().optional(),
    },
  }, guard(async (a) => {
    const call = resolveCall(a.call_id);
    const patch: Record<string, unknown> = {};
    if (a.title) patch.title = a.title;
    if (a.autonomy) patch.autonomy = a.autonomy;
    if (a.act) patch.act = a.act;
    if (a.outputs) patch.outputs = parseOutputs(a.outputs, outputsOf(call));
    if (a.repos) patch.repos = a.repos;
    if (a.workdir) patch.workdir = a.workdir;
    return text(callSummary(updateCall(call.id, patch)));
  }));

  tool('distribute_plan', {
    title: 'Deliver the plan',
    description: 'Delivers the plan to the call\'s outputs: the tasks to the task platform (GitHub issues, Linear, Jira, ClickUp — one item each, criteria as a checklist, dependencies linked), the CRM update (HubSpot), the meeting document (markdown file, Notion), or a webhook. Outputs set to "agent" come back to you with what to create: do it with your own tools, then record the links (update_task issue_url for tasks, record_output for the CRM / document). What was already delivered is not sent again.',
    inputSchema: {
      call_id: z.string().optional(),
      only: OUTPUT_KIND.optional().describe('Deliver only this output'),
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional().describe('GitHub: the repository for tasks that have none'),
    },
  }, guard(async (a) => {
    const res = await deliverOutputs(resolveCall(a.call_id).id, { only: a.only as OutputKind | undefined, repo: a.repo });
    return text(resultsText(res));
  }));

  tool('record_output', {
    title: 'Record where an output went',
    description: 'After putting an output in place with your own tools (target "agent"): records its link so it shows in the call and is not delivered again. For tasks, record each one with update_task issue_url instead.',
    inputSchema: { call_id: z.string().optional(), kind: z.enum(['crm', 'doc', 'tasks']), url: z.string().optional(), note: z.string().max(1000).optional() },
  }, guard(async (a) => {
    const d = recordOutput(resolveCall(a.call_id).id, a.kind, a.url ?? null, a.note);
    return text(`${a.kind} recorded${d.url ? `: ${d.url}` : ''}.`);
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
  lines.push(`${llmConfigured() ? '✓' : '·'} planning model: ${llmConfigured() ? `${llmLabel()}${config.llm === 'claude-code' ? ' (Claude Code on this machine)' : ''}` : 'none — the connected agent builds the plan (get_call_context + save_plan); OMA_LLM_PROVIDER=claude-code uses Claude Code here'}`);
  const gh = !!config.githubToken || await run('gh', ['auth', 'status'], 'gh', 10_000).then(() => true).catch(() => false);
  lines.push(`${gh ? '✓' : '·'} GitHub: ${config.githubToken ? 'GITHUB_TOKEN' : gh ? 'gh CLI' : 'not set (only needed for GitHub issues)'}`);
  lines.push(`  acts: ${config.act}${config.act !== 'after' ? ` (in the meeting: ${llmConfigured() ? 'the planning model answers' : 'the connected agent answers via watch_meeting'})` : ''}`);
  const out = (kind: string, target: string | null, problem: string) => lines.push(`${target ? (problem ? '✗' : '✓') : '·'} ${kind} → ${target ?? 'none'}${problem ? ` — ${problem}` : ''}`);
  const t = config.tasksTarget;
  out('tasks', t, t === 'linear' || t === 'jira' || t === 'clickup' ? tasksSetupProblem(t) : t === 'webhook' && !config.webhookUrl ? 'OMA_WEBHOOK_URL not set' : '');
  out('crm', config.crmTarget, config.crmTarget === 'hubspot' && !config.hubspotToken ? 'HUBSPOT_TOKEN not set' : config.crmTarget === 'webhook' && !config.webhookUrl ? 'OMA_WEBHOOK_URL not set' : '');
  out('doc', config.docTarget, config.docTarget === 'notion' && !(config.notionToken && (config.notionParentPage || config.notionDatabase)) ? 'NOTION_TOKEN and OMA_NOTION_PARENT_PAGE_ID (or OMA_NOTION_DATABASE_ID) needed' : config.docTarget === 'webhook' && !config.webhookUrl ? 'OMA_WEBHOOK_URL not set' : '');
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
