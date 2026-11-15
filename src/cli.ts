// oma — the command line. `oma mcp` is the MCP server; the rest does the same
// from a terminal.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { config } from './config.js';
import { liveTranscriptText, sayInMeeting } from './live.js';
import { doctor, runMcpServer } from './mcp/server.js';
import { deliverOutputs, recordOutput, resultsText } from './outputs/index.js';
import {
  agentPrompt, cancelMeeting, endMeeting, importMeetily, importRecording, joinMeeting, runAgentHook, runWorker,
} from './pipeline.js';
import { buildPlan, callBlocks, PlanEmptyError, saveHostPlan } from './plan/build.js';
import { buildBotImage } from './sources/bot.js';
import { listMeetilyMeetings } from './sources/meetily.js';
import { screenStatus, startScreenCapture, stopScreenCapture } from './sources/screen.js';
import { getPlan, latestCall, listCalls, mustGetCall, updateCall } from './store.js';
import { mustGetPlan, nextTask, taskBrief, updateTask } from './tasks.js';
import type { ActMode, Autonomy, OutputKind, TaskState } from './types.js';
import { callLine, callSummary, planDetail, planText } from './views.js';

const HELP = `oma — open-meeting-agent

  oma mcp                         run the MCP server (stdio) for Claude Code, Cursor, Codex…
  oma doctor                      check what is set up
  oma bot build                   build the bot's container image (once)

  oma join <url> [--title T] [--name N] [--autonomy suggest|issues|prs] [--repo owner/repo]…
           [--act after|during|both] [--tasks T] [--crm T] [--doc T]
                                  --act: when the agent acts (during = answers in the meeting)
                                  --tasks github|linear|jira|clickup|webhook|agent|none
                                  --crm hubspot|webhook|agent|none   --doc file|notion|webhook|agent|none
  oma live [call]                 what is being said in the meeting (captions and chat)
  oma say <call> <text>           post in the meeting chat as the agent
  oma end [call]                  the agent leaves; the call is processed
  oma cancel [call]               the agent leaves; nothing is kept
  oma meetily [meeting-id]        list meetily meetings, or import one (--tasks/--crm/--doc too)
  oma import <file> [--title T]   import an audio/video recording (--tasks/--crm/--doc too)
  oma screen start|stop|status    record this screen (for meetily meetings)

  oma list                        calls on this machine
  oma status [call]
  oma context [call]              the call as text (what the agent reads to plan)
  oma plan [call]                 show the plan
  oma plan build [call]           build the plan with the configured model
  oma plan save <call> <file>     save a plan written elsewhere (JSON)
  oma note <call> <text> [--replan]
  oma deliver [call] [--only tasks|crm|doc] [--repo owner/repo]
                                  deliver the plan: tasks platform, CRM, document
  oma delivered <call> <crm|doc> [url]   record where you put an output yourself
  oma issues [call]               the same as deliver --only tasks
  oma next [call]                 take the next task
  oma task <call> <key> <state> [--pr URL] [--note TEXT]
  oma prompt [call]               the prompt that hands the call to a coding agent
  oma agent [call]                run OMA_AGENT_COMMAND for the call

[call] defaults to the latest call. Data: ${config.home}`;

const resolve = (id?: string) => {
  if (id) return mustGetCall(id);
  const c = latestCall();
  if (!c) throw new Error('No calls yet.');
  return c;
};

async function main(argv: string[]): Promise<void> {
  const { values: o, positionals: p } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      title: { type: 'string' },
      name: { type: 'string' },
      autonomy: { type: 'string' },
      act: { type: 'string' },
      tasks: { type: 'string' },
      crm: { type: 'string' },
      doc: { type: 'string' },
      only: { type: 'string' },
      repo: { type: 'string', multiple: true },
      pr: { type: 'string' },
      note: { type: 'string' },
      replan: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...rest] = p;
  const opts = {
    title: o.title, agentName: o.name, repos: o.repo, workdir: process.cwd(),
    autonomy: (['suggest', 'issues', 'prs'].includes(o.autonomy ?? '') ? o.autonomy : undefined) as Autonomy | undefined,
    act: (['after', 'during', 'both'].includes(o.act ?? '') ? o.act : undefined) as ActMode | undefined,
    outputs: { tasks: o.tasks, crm: o.crm, doc: o.doc },
  };
  const out = (s: string): void => { process.stdout.write(`${s}\n`); };

  switch (cmd) {
    case 'mcp': return runMcpServer();
    case 'worker': return runWorker(rest[0]!);
    case 'doctor': return out(await doctor());
    case 'bot':
      if (rest[0] !== 'build') throw new Error('usage: oma bot build');
      await buildBotImage((l) => out(l));
      return out(`✓ built ${config.botImage}`);
    case 'join': {
      if (!rest[0]) throw new Error('usage: oma join <meeting url>');
      const c = await joinMeeting(rest[0], opts);
      return out(`${callSummary(c)}\n\nAdmit "${c.agent_name}" if the meeting has a lobby. \`oma end ${c.id}\` when you are done.`);
    }
    case 'live': return out(liveTranscriptText(resolve(rest[0]).id));
    case 'say': {
      const t = rest.slice(1).join(' ');
      if (!rest[0] || !t) throw new Error('usage: oma say <call> <text>');
      const r = await sayInMeeting(resolve(rest[0]).id, t, 10_000);
      if (r.ok === false) throw new Error(`could not post: ${r.error}`);
      return out(r.ok ? 'posted' : 'queued');
    }
    case 'end': return out(callSummary(await endMeeting(resolve(rest[0]).id)));
    case 'cancel': return out(callSummary(await cancelMeeting(resolve(rest[0]).id)));
    case 'meetily': {
      if (!rest[0]) {
        const list = await listMeetilyMeetings(20);
        return out(list.length ? list.map((m) => `${m.id} · ${m.title} · ${m.created_at} · ${m.segments} segment(s)`).join('\n') : `No meetings in ${config.meetilyDb}`);
      }
      return out(callSummary(await importMeetily(rest[0], opts)));
    }
    case 'import':
      if (!rest[0]) throw new Error('usage: oma import <file>');
      return out(callSummary(await importRecording(rest[0], opts)));
    case 'screen': {
      if (rest[0] === 'start') { const r = startScreenCapture(); return out(`recording the screen → ${r.file}`); }
      if (rest[0] === 'stop') { const r = await stopScreenCapture(); return out(r ? `saved ${r.file}` : 'not recording'); }
      const r = screenStatus();
      return out(r ? `recording since ${r.started_at} → ${r.file}` : 'not recording');
    }
    case 'list': {
      const calls = listCalls();
      return out(calls.length ? calls.map(callLine).join('\n') : 'No calls yet.');
    }
    case 'status': return out(callSummary(resolve(rest[0])));
    case 'context': {
      const { blocks } = callBlocks(resolve(rest[0]).id);
      return out(blocks.map((b) => (b.type === 'text' ? b.text : `[image ${b.label}: ${b.file}]`)).join('\n'));
    }
    case 'plan': {
      if (rest[0] === 'save') {
        if (!rest[1] || !rest[2]) throw new Error('usage: oma plan save <call> <file.json>');
        return out(planText(saveHostPlan(rest[1], readFileSync(rest[2], 'utf8'))));
      }
      if (rest[0] === 'build') return out(planText(await buildPlan(resolve(rest[1]).id)));
      const plan = mustGetPlan(resolve(rest[0]).id);
      return out(`${planText(plan)}\n\n${planDetail(plan)}`);
    }
    case 'note': {
      const c = resolve(rest[0]);
      const t = rest.slice(1).join(' ');
      if (!t) throw new Error('usage: oma note <call> <text>');
      updateCall(c.id, { notes: [...c.notes, { at: new Date().toISOString(), text: t }] });
      return out(o.replan ? planText(await buildPlan(c.id)) : 'note saved');
    }
    case 'deliver':
    case 'issues': {
      const only = (cmd === 'issues' ? 'tasks' : ['tasks', 'crm', 'doc'].includes(o.only ?? '') ? o.only : undefined) as OutputKind | undefined;
      return out(resultsText(await deliverOutputs(resolve(rest[0]).id, { only, repo: o.repo?.[0] })));
    }
    case 'delivered': {
      const [id, kind, url] = rest;
      if (!id || !['crm', 'doc', 'tasks'].includes(kind ?? '')) throw new Error('usage: oma delivered <call> <crm|doc> [url]');
      recordOutput(resolve(id).id, kind as OutputKind, url ?? null);
      return out(`${kind} recorded`);
    }
    case 'next': {
      const c = resolve(rest[0]);
      const n = nextTask(c.id);
      if (n.kind === 'finished') return out('All tasks are done.');
      if (n.kind === 'waiting') return out(`Waiting on ${n.blocked.map((t) => `${t.key} [${t.state}]`).join(', ')}`);
      return out(taskBrief(c, getPlan(c.id)!, n.task).text);
    }
    case 'task': {
      const [id, key, state] = rest;
      if (!id || !key) throw new Error('usage: oma task <call> <key> <state> [--pr URL] [--note TEXT]');
      const t = updateTask(id, key, { state: state as TaskState | undefined, pr_url: o.pr, note: o.note });
      return out(`${t.key} → ${t.state}`);
    }
    case 'prompt': {
      const c = resolve(rest[0]);
      return out(agentPrompt(c, !!getPlan(c.id)));
    }
    case 'agent': return out(runAgentHook(resolve(rest[0]).id) ? 'started (agent.log in the call folder)' : 'OMA_AGENT_COMMAND is not set');
    default:
      return out(HELP);
  }
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof PlanEmptyError) {
    process.stderr.write(`No task came out of the call.\n${e.summary}\n${e.questions.map((q) => `- ${q}`).join('\n')}\nAnswer with \`oma note <call> "<answer>" --replan\`.\n`);
  } else {
    process.stderr.write(`oma: ${(e as Error).message}\n`);
  }
  process.exit(1);
});
