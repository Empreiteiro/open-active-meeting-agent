// After the meeting: the connected agent works the plan task by task. A task
// is ready when every task it depends on is done (or skipped). The brief is
// everything an agent that wasn't in the call needs.

import { fmtTime } from './plan/prompt.js';
import { getFrames, getPlan, logCall, mustGetCall, savePlan } from './store.js';
import type { Autonomy, Call, Frame, Plan, PlanTask, TaskState } from './types.js';

const settled = (t: PlanTask | undefined) => !t || !t.include || t.state === 'done' || t.state === 'skipped';

export function mustGetPlan(callId: string): Plan {
  const plan = getPlan(callId);
  if (!plan) throw new Error('This call has no plan yet. Build it first (build_plan, or get_call_context + save_plan).');
  return plan;
}

export function readyTasks(plan: Plan): PlanTask[] {
  const byKey = new Map(plan.tasks.map((t) => [t.key, t]));
  return plan.tasks.filter((t) => t.include && t.state === 'todo' && t.depends_on.every((k) => settled(byKey.get(k))));
}

export type NextTask =
  | { kind: 'task'; task: PlanTask; resumed: boolean }
  | { kind: 'waiting'; blocked: PlanTask[] }
  | { kind: 'finished' };

/** The task in progress (resume it), else the next ready one (now in progress). */
export function nextTask(callId: string): NextTask {
  const plan = mustGetPlan(callId);
  const doing = plan.tasks.find((t) => t.include && t.state === 'in_progress');
  if (doing) return { kind: 'task', task: doing, resumed: true };
  const ready = readyTasks(plan)[0];
  if (ready) {
    ready.state = 'in_progress';
    savePlan(callId, plan);
    logCall(callId, `task ${ready.key} in progress`);
    return { kind: 'task', task: ready, resumed: false };
  }
  const open = plan.tasks.filter((t) => t.include && (t.state === 'todo' || t.state === 'blocked'));
  return open.length ? { kind: 'waiting', blocked: open } : { kind: 'finished' };
}

export function updateTask(callId: string, key: string, patch: { state?: TaskState; pr_url?: string; issue_url?: string; note?: string; include?: boolean }): PlanTask {
  const plan = mustGetPlan(callId);
  const task = plan.tasks.find((t) => t.key === key);
  if (!task) throw new Error(`No task ${key} in this plan (${plan.tasks.map((t) => t.key).join(', ')}).`);
  if (patch.state) task.state = patch.state;
  if (patch.pr_url) task.pr_url = patch.pr_url;
  if (patch.issue_url) task.issue_url = patch.issue_url;
  if (patch.include != null) task.include = patch.include;
  if (patch.note) task.notes = [...(task.notes ?? []), patch.note.slice(0, 4000)];
  savePlan(callId, plan);
  logCall(callId, `task ${key}: ${[patch.state, patch.pr_url, patch.issue_url, patch.note && 'note'].filter(Boolean).join(', ')}`);
  return task;
}

export function progress(plan: Plan): { done: number; total: number; byState: Record<string, number> } {
  const inc = plan.tasks.filter((t) => t.include);
  const byState: Record<string, number> = {};
  for (const t of inc) byState[t.state] = (byState[t.state] ?? 0) + 1;
  return { done: inc.filter((t) => t.state === 'done').length, total: inc.length, byState };
}

export function autonomyRule(a: Autonomy, task: PlanTask): string {
  if (task.deliverable === 'issue') {
    return 'This task asks for a decision, an investigation or a design, not code: write it up (in the issue when there is one, else to the person) and call update_task with state "done" and a note.';
  }
  if (a === 'prs') {
    return 'Autonomy "prs": implement it, run the project\'s own checks, and open the pull request without asking (its body closes the issue when there is one, explains how each criterion is met and how to test). Then call update_task with state "done" and pr_url.';
  }
  return 'Implement it and show the person the change; open the pull request only after they confirm. Then call update_task with state "done" and pr_url (or "blocked" with a note saying what is missing).';
}

/** Markdown brief of one task, for the agent that will do it. */
export function taskBrief(call: Call, plan: Plan, task: PlanTask): { text: string; frames: Frame[] } {
  const all = getFrames(call.id);
  const frames = task.frames.map((l) => all.find((f) => f.label === l)).filter((f): f is Frame => !!f);
  const others = plan.tasks.filter((t) => t.key !== task.key && t.include)
    .map((t) => `- ${t.key} [${t.state}] ${t.title}${task.depends_on.includes(t.key) ? ' (this task depends on it)' : ''}`);
  const text = [
    `# ${task.key} · ${task.title}`,
    `Meeting: **${plan.title || call.title}** (call ${call.id})${call.workdir ? ` — work folder: ${call.workdir}` : ''}`,
    plan.summary ? `> ${plan.summary}` : '',
    `## What to do\n${task.description || '(no description)'}`,
    task.acceptance.length ? `## Acceptance criteria\n${task.acceptance.map((a) => `- [ ] ${a}`).join('\n')}` : '',
    `## Deliverable\n${task.deliverable === 'pr' ? `A pull request${task.repo ? ` in ${task.repo}` : ' (no repository set: work in the current folder or ask which one)'}` : 'An issue / written answer (no code)'}${task.issue_url ? ` — issue: ${task.issue_url}` : ''}`,
    frames.length ? `## Screens from the call\n${frames.map((f) => `- ${f.label} at ${fmtTime(f.t)}: ${f.file}`).join('\n')}` : '',
    others.length ? `## The rest of the plan\n${others.join('\n')}` : '',
    plan.questions.length ? `## Open questions from the call\n${plan.questions.map((q) => `- ${q}`).join('\n')}` : '',
    `## How\n${autonomyRule(call.autonomy, task)}`,
  ].filter(Boolean).join('\n\n');
  return { text, frames };
}

export { mustGetCall };
