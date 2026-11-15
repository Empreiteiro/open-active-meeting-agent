// Text views shared by the MCP tools and the CLI.

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { run } from './media/ffmpeg.js';
import { fmtTime } from './plan/prompt.js';
import { botStatus } from './sources/bot.js';
import { callPaths, getFrames, getPlan, getTranscript } from './store.js';
import { progress, readyTasks } from './tasks.js';
import type { Call, Frame, Plan } from './types.js';

const STATUS_TEXT: Record<Call['status'], string> = {
  joining: 'the agent is joining the meeting (admit it from the lobby if asked)',
  in_call: 'the agent is in the meeting, recording',
  processing: 'transcribing and reading the shared screen',
  needs_plan: 'ready to plan',
  planned: 'planned',
  failed: 'it stopped — see the error',
  cancelled: 'nothing was kept',
};

export function callLine(c: Call): string {
  return `${c.id} · ${c.title} · ${c.status}${c.error ? ` (${c.error})` : ''} · ${c.source}${c.repos.length ? ` · ${c.repos.join(', ')}` : ''}`;
}

export function callSummary(c: Call): string {
  const lines = [
    `Call ${c.id}: ${c.title}`,
    `Status: ${c.status} — ${STATUS_TEXT[c.status]}${c.error ? `\nError: ${c.error}` : ''}`,
    `Source: ${c.source}${c.meeting_url ? ` (${c.meeting_url})` : ''} · autonomy: ${c.autonomy} · repos: ${c.repos.join(', ') || 'none'}${c.workdir ? ` · workdir: ${c.workdir}` : ''}`,
  ];
  if (c.source === 'bot' && (c.status === 'joining' || c.status === 'in_call')) {
    const st = botStatus(c.id);
    if (st) lines.push(`Bot: ${st.state}${st.participants != null ? ` · ${st.participants} participant(s)` : ''}${st.error ? ` · ${st.error}` : ''}`);
  }
  const segs = getTranscript(c.id);
  if (segs) lines.push(`Transcript: ${segs.length} segment(s)${segs.length ? `, ${fmtTime(segs.at(-1)!.end)}` : ''} · frames: ${getFrames(c.id).length}`);
  const plan = getPlan(c.id);
  if (plan) lines.push('', planText(plan));
  if (c.notes.length) lines.push('', `Notes after the call:\n${c.notes.map((n) => `- ${n.text.split('\n')[0]}`).join('\n')}`);
  return lines.join('\n');
}

export function planText(plan: Plan): string {
  const pr = progress(plan);
  const ready = new Set(readyTasks(plan).map((t) => t.key));
  const tasks = plan.tasks.map((t) => {
    const flags = [
      t.include ? t.state : 'left out',
      t.deliverable,
      t.repo,
      t.priority,
      t.depends_on.length ? `after ${t.depends_on.join(', ')}` : '',
      ready.has(t.key) ? 'ready' : '',
    ].filter(Boolean).join(' · ');
    const links = [t.issue_url, t.pr_url].filter(Boolean).join(' ');
    return `- ${t.key} ${t.title} [${flags}]${links ? ` ${links}` : ''}`;
  });
  return [
    `Plan: ${plan.title} — ${pr.done}/${pr.total} done (by ${plan.built_by})`,
    plan.summary,
    tasks.join('\n'),
    plan.questions.length ? `Open questions:\n${plan.questions.map((q) => `- ${q}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

export function planDetail(plan: Plan): string {
  return plan.tasks.map((t) => [
    `## ${t.key} · ${t.title}${t.include ? '' : ' (left out)'}`,
    `state: ${t.state} · deliverable: ${t.deliverable} · repo: ${t.repo ?? 'none'} · priority: ${t.priority ?? '-'}${t.depends_on.length ? ` · depends on: ${t.depends_on.join(', ')}` : ''}${t.frames.length ? ` · frames: ${t.frames.join(', ')}` : ''}`,
    t.description,
    t.acceptance.length ? t.acceptance.map((a) => `- [ ] ${a}`).join('\n') : '',
    [t.issue_url && `issue: ${t.issue_url}`, t.pr_url && `PR: ${t.pr_url}`].filter(Boolean).join(' · '),
  ].filter(Boolean).join('\n')).join('\n\n');
}

/** A smaller copy of a frame for agents (cached next to the original). */
export async function frameThumb(f: Frame, width = 768): Promise<string> {
  const dir = path.join(path.dirname(f.file), `w${width}`);
  const out = path.join(dir, path.basename(f.file));
  if (existsSync(out)) return out;
  mkdirSync(dir, { recursive: true });
  try {
    await run(config.ffmpeg, ['-hide_banner', '-nostats', '-y', '-i', f.file, '-vf', `scale='min(${width},iw)':-2`, '-q:v', '5', out], 'thumb');
    return out;
  } catch {
    return f.file;
  }
}

export function transcriptText(callId: string): string {
  const segs = getTranscript(callId) ?? [];
  const long = (segs.at(-1)?.start ?? 0) >= 3600;
  return segs.map((s) => `[${fmtTime(s.start, long)}] ${s.speaker}: ${s.text}`).join('\n');
}

export { callPaths };
