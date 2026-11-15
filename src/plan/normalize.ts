// The plan JSON (from a model or from the connected agent) as a valid plan:
// fields trimmed, frames only the call's own, repository only one of the
// call's, dependencies only on earlier tasks.

import type { Plan, PlanPriority, PlanTask } from '../types.js';
import { PLAN_TASKS_MAX, TASK_FRAMES_MAX } from './prompt.js';

const PRIORITIES: readonly PlanPriority[] = ['low', 'medium', 'high', 'urgent'];
const str = (x: unknown, max: number): string => (typeof x === 'string' ? x.trim().slice(0, max) : '');

/** The first JSON object in a model answer (bare, or inside a ```json fence). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [t, fence?.[1] ?? ''];
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(t.slice(first, last + 1));
  for (const c of candidates) {
    if (!c.trim()) continue;
    try {
      const v = JSON.parse(c) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {}
  }
  return null;
}

/** null = no usable task. `frames` are the call's frame labels (F1…). */
export function normalizePlan(
  raw: Record<string, unknown>,
  frameLabels: string[],
  repos: string[],
  builtBy: string,
): Plan | null {
  const labels = new Map(frameLabels.map((l) => [l.toUpperCase(), l]));
  const findRepo = (v: unknown): string | null => {
    const s = str(v, 200).toLowerCase();
    if (!s) return null;
    return repos.find((r) => r.toLowerCase() === s)
      ?? repos.find((r) => r.toLowerCase().endsWith(`/${s.split('/').pop()}`))
      ?? null;
  };
  const list = Array.isArray(raw.tasks) ? raw.tasks.slice(0, PLAN_TASKS_MAX) : [];
  const tasks: PlanTask[] = [];
  list.forEach((t, i) => {
    const o = t && typeof t === 'object' ? t as Record<string, unknown> : {};
    const title = str(o.title, 200).replace(/\s+/g, ' ');
    if (!title) return;
    const deliverable = o.deliverable === 'issue' ? 'issue' : 'pr';
    // A code task with no repository named goes to the only one, when there is one.
    const repo = findRepo(o.repo) ?? (deliverable === 'pr' && repos.length === 1 ? repos[0]! : null);
    const frames = (Array.isArray(o.frames) ? o.frames : [])
      .map((x) => labels.get(String(x ?? '').trim().toUpperCase()))
      .filter((x): x is string => !!x);
    tasks.push({
      key: `t${i + 1}`,
      title,
      description: str(o.description, 8000),
      acceptance: (Array.isArray(o.acceptance) ? o.acceptance : []).map((x) => str(x, 400)).filter(Boolean).slice(0, 8),
      frames: [...new Set(frames)].slice(0, TASK_FRAMES_MAX),
      repo,
      deliverable,
      priority: PRIORITIES.includes(o.priority as PlanPriority) ? o.priority as PlanPriority : null,
      depends_on: (Array.isArray(o.depends_on) ? o.depends_on : [])
        .map((x) => (typeof x === 'string' && /^t\d+$/.test(x) ? Number(x.slice(1)) : Number(x)))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= i)
        .map((n) => `t${n}`),
      include: o.include !== false,
      state: 'todo',
    });
  });
  if (!tasks.length) return null;
  // A dependency on a task that was dropped (no title) goes away.
  const keys = new Set(tasks.map((t) => t.key));
  for (const t of tasks) t.depends_on = [...new Set(t.depends_on.filter((k) => keys.has(k)))];
  return {
    version: 1,
    title: str(raw.title, 200).replace(/\s+/g, ' '),
    summary: str(raw.summary, 2000),
    questions: (Array.isArray(raw.questions) ? raw.questions : []).map((x) => str(x, 400)).filter(Boolean).slice(0, 10),
    tasks,
    built_by: builtBy,
    built_at: new Date().toISOString(),
  };
}

export function planQuestions(raw: Record<string, unknown> | null): { summary: string; questions: string[] } {
  return {
    summary: str(raw?.summary, 2000),
    questions: (Array.isArray(raw?.questions) ? raw.questions : []).map((x) => str(x, 400)).filter(Boolean).slice(0, 10),
  };
}
