// The plan JSON (from a model or from the connected agent) as a valid plan:
// fields trimmed, frames only the call's own, repository only one of the
// call's, dependencies only on earlier tasks.

import type { CrmUpdate, MeetingDoc, Plan, PlanPriority, PlanTask } from '../types.js';
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

const strOrNull = (x: unknown, max: number): string | null => str(x, max) || null;
const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null);

/** 12000, "12,000", "$12.000,50", "1.234.567" → a number (null when there is none). */
export function parseAmount(x: unknown): number | null {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  let t = String(x ?? '').replace(/[^\d.,-]/g, '');
  if (!/\d/.test(t)) return null;
  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // Both: the last one is the decimal separator.
    t = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else {
    const sep = lastComma >= 0 ? ',' : lastDot >= 0 ? '.' : '';
    // One kind, in groups of three digits ("12,000", "1.234.567"): thousands.
    if (sep && new RegExp(`^-?\\d{1,3}(\\${sep}\\d{3})+$`).test(t)) t = t.split(sep).join('');
    else if (sep === ',') t = t.replace(',', '.');
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The CRM part of a plan (null when it carries nothing). */
export function normalizeCrm(x: unknown): CrmUpdate | null {
  const o = obj(x);
  if (!o) return null;
  const co = obj(o.company);
  const deal = obj(o.deal);
  const crm: CrmUpdate = {
    company: co && str(co.name, 200) ? { name: str(co.name, 200), domain: strOrNull(co.domain, 200)?.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase() ?? null } : null,
    contacts: (Array.isArray(o.contacts) ? o.contacts : []).map(obj).filter((c): c is Record<string, unknown> => !!c && !!str(c.name, 200)).slice(0, 10)
      .map((c) => ({ name: str(c.name, 200), email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str(c.email, 200)) ? str(c.email, 200).toLowerCase() : null, role: strOrNull(c.role, 200), phone: strOrNull(c.phone, 60) })),
    deal: deal && str(deal.name, 200) ? {
      name: str(deal.name, 200),
      stage: strOrNull(deal.stage, 100),
      amount: parseAmount(deal.amount),
      currency: strOrNull(deal.currency, 10)?.toUpperCase() ?? null,
      close_date: strOrNull(deal.close_date, 40),
    } : null,
    summary: str(o.summary, 4000),
    next_steps: (Array.isArray(o.next_steps) ? o.next_steps : []).map((s) => str(s, 400)).filter(Boolean).slice(0, 15),
  };
  return crm.company || crm.contacts.length || crm.deal || crm.summary || crm.next_steps.length ? crm : null;
}

/** The document part of a plan. */
export function normalizeDoc(x: unknown): MeetingDoc | null {
  const o = obj(x);
  const markdown = str(o?.markdown, 60_000);
  return markdown ? { title: str(o?.title, 200).replace(/\s+/g, ' '), markdown } : null;
}

/** null = nothing usable (no task, no CRM update, no document). `frames` are the call's frame labels (F1…). */
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
    // Unsaid: code (pr) when the call has repositories, else a follow-up (issue).
    const deliverable = o.deliverable === 'issue' ? 'issue' : o.deliverable === 'pr' ? 'pr' : repos.length ? 'pr' : 'issue';
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
  const crm = normalizeCrm(raw.crm);
  const doc = normalizeDoc(raw.doc);
  if (!tasks.length && !crm && !doc) return null;
  // A dependency on a task that was dropped (no title) goes away.
  const keys = new Set(tasks.map((t) => t.key));
  for (const t of tasks) t.depends_on = [...new Set(t.depends_on.filter((k) => keys.has(k)))];
  return {
    version: 1,
    title: str(raw.title, 200).replace(/\s+/g, ' '),
    summary: str(raw.summary, 2000),
    questions: (Array.isArray(raw.questions) ? raw.questions : []).map((x) => str(x, 400)).filter(Boolean).slice(0, 10),
    tasks,
    ...(crm ? { crm } : {}),
    ...(doc ? { doc } : {}),
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
