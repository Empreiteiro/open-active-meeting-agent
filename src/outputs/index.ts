// What the agent delivers after the call, and where:
//   tasks → the team's task platform (GitHub issues, Linear, Jira, ClickUp)
//   crm   → the CRM (HubSpot)
//   doc   → the meeting document (a markdown file, Notion)
// Any of them can go to a webhook (Zapier, Make, n8n…) or to the connected
// agent ("agent"), which puts it in place with its own tools (MCP connectors
// for HubSpot, Notion, Google Docs, Asana, Salesforce…) and records the link.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config, CRM_TARGETS, DOC_TARGETS, TASKS_TARGETS } from '../config.js';
import { createIssue, distributePlan } from '../github.js';
import { callPaths, getFrames, logCall, mustGetCall, savePlan } from '../store.js';
import { mustGetPlan } from '../tasks.js';
import type { ActMode, Call, Delivery, OutputKind, Outputs, Plan, PlanPriority } from '../types.js';
import { deliverHubspot } from './crm.js';
import { createNotionPage } from './notion.js';
import { createTaskIn, taskMarkdown, type NativeTasksTarget } from './tasks.js';
import { postWebhook } from './webhook.js';

export const OUTPUT_KINDS: readonly OutputKind[] = ['tasks', 'crm', 'doc'];
const TARGETS: Record<OutputKind, readonly string[]> = { tasks: TASKS_TARGETS, crm: CRM_TARGETS, doc: DOC_TARGETS };

/** The call's outputs (calls made before outputs existed: tasks to GitHub). */
export function outputsOf(call: Call): Outputs {
  return call.outputs ?? { tasks: 'github', crm: null, doc: null };
}

export function actOf(call: Call): ActMode {
  return call.act ?? 'after';
}

/** A call with a live side: the bot in a meeting, or a huddle in the web UI. */
export const isLiveSource = (call: Call): boolean => call.source === 'bot' || call.source === 'huddle';
/** The agent answers in the meeting. */
export const actsDuring = (call: Call): boolean => isLiveSource(call) && actOf(call) !== 'after';
/** The agent delivers after the call (act "during" only keeps the plan). */
export const actsAfter = (call: Call): boolean => !(isLiveSource(call) && actOf(call) === 'during');

/** Outputs from a request: a known target, "none" (nothing), or unchanged. */
export function parseOutputs(input: Partial<Record<OutputKind, string | null | undefined>> | undefined, base: Outputs): Outputs {
  const out: Outputs = { ...base };
  for (const k of OUTPUT_KINDS) {
    const v = input?.[k];
    if (v === undefined) continue;
    if (v === null || v === '' || v === 'none' || v === 'off') { out[k] = null; continue; }
    if (!TARGETS[k].includes(v)) throw new Error(`${k} cannot go to "${v}" (one of: ${TARGETS[k].join(', ')}, none).`);
    (out as unknown as Record<string, string>)[k] = v;
  }
  return out;
}

export const defaultOutputs = (): Outputs => ({ tasks: config.tasksTarget, crm: config.crmTarget, doc: config.docTarget });

export function outputsLine(o: Outputs): string {
  const parts = OUTPUT_KINDS.filter((k) => o[k]).map((k) => `${k} → ${o[k]}`);
  return parts.length ? parts.join(', ') : 'nothing (plan only)';
}

export interface OutputResult { kind: OutputKind; target: string; ok: boolean; lines: string[]; url?: string | null }

/** Deliver the plan to the call's outputs (or `only` one of them). Idempotent:
 *  what was already delivered is not sent again. */
export async function deliverOutputs(callId: string, opts: { only?: OutputKind; repo?: string | null } = {}): Promise<OutputResult[]> {
  const call = mustGetCall(callId);
  const outs = outputsOf(call);
  const results: OutputResult[] = [];
  for (const kind of OUTPUT_KINDS) {
    if (opts.only && opts.only !== kind) continue;
    const target = outs[kind];
    if (!target) {
      if (opts.only) results.push({ kind, target: 'none', ok: false, lines: [`no ${kind} output is set for this call (set_call outputs.${kind})`] });
      continue;
    }
    try {
      const r = kind === 'tasks' ? await deliverTasks(callId, target, opts.repo ?? null)
        : kind === 'crm' ? await deliverCrm(callId, target)
          : await deliverDoc(callId, target);
      results.push(r);
    } catch (e) {
      results.push({ kind, target, ok: false, lines: [(e as Error).message.slice(0, 400)] });
    }
    const last = results.at(-1)!;
    logCall(callId, `${kind} → ${target}: ${last.ok ? 'ok' : 'failed'} ${last.lines[0] ?? ''}`.trim());
  }
  return results;
}

export function resultsText(results: OutputResult[]): string {
  return results.map((r) => `## ${r.kind} → ${r.target}${r.ok ? '' : ' (not delivered)'}\n${r.lines.join('\n')}`).join('\n\n') || 'Nothing to deliver.';
}

function recordDelivery(callId: string, plan: Plan, kind: OutputKind, d: Delivery): void {
  plan.deliveries = { ...(plan.deliveries ?? {}), [kind]: d };
  savePlan(callId, plan);
}

/** The connected agent records where it put an output (target "agent"). */
export function recordOutput(callId: string, kind: OutputKind, url: string | null, note?: string): Delivery {
  const plan = mustGetPlan(callId);
  const d: Delivery = { target: 'agent', at: new Date().toISOString(), url, detail: note ?? null };
  recordDelivery(callId, plan, kind, d);
  logCall(callId, `${kind} delivered by the connected agent${url ? `: ${url}` : ''}`);
  return d;
}

// ── Tasks ───────────────────────────────────────────────────────────────────

async function deliverTasks(callId: string, target: string, repo: string | null): Promise<OutputResult> {
  const call = mustGetCall(callId);
  const plan = mustGetPlan(callId);
  const pending = plan.tasks.filter((t) => t.include && !t.issue_url);
  if (target === 'github') {
    const res = await distributePlan(callId, { repo });
    return { kind: 'tasks', target, ok: res.some((r) => r.issue), lines: res.map((r) => `- ${r.key}: ${r.issue ?? `skipped (${r.skipped})`}`) };
  }
  if (target === 'agent') {
    if (!pending.length) return { kind: 'tasks', target, ok: true, lines: ['Every task already has its link.'] };
    const frames = getFrames(callId);
    const links = new Map(plan.tasks.filter((t) => t.issue_url).map((t) => [t.key, t.issue_url!]));
    return {
      kind: 'tasks', target, ok: true,
      lines: [
        'Create these tasks in the team\'s task platform with your own tools (its MCP connector), in this order, then record each link with update_task { key, issue_url }:',
        ...pending.map((t) => `\n### ${t.key} · ${t.title}${t.priority ? ` (${t.priority})` : ''}\n${taskMarkdown(t, { meeting: plan.title || call.title, links, frames })}`),
      ],
    };
  }
  if (target === 'webhook') {
    if (plan.deliveries?.tasks) return { kind: 'tasks', target, ok: true, lines: [`Already sent ${plan.deliveries.tasks.at}.`] };
    const frames = getFrames(callId);
    const links = new Map<string, string>();
    const res = await postWebhook('tasks', {
      call: callInfo(call), plan: { title: plan.title, summary: plan.summary },
      tasks: pending.map((t) => ({ key: t.key, title: t.title, priority: t.priority, depends_on: t.depends_on, repo: t.repo, deliverable: t.deliverable, acceptance: t.acceptance, markdown: taskMarkdown(t, { meeting: plan.title || call.title, links, frames }) })),
    });
    // The receiver may answer with the items it created: {items: [{key, url}]}.
    const items = Array.isArray(res.items) ? res.items as Array<{ key?: string; url?: string }> : [];
    for (const it of items) {
      const t = plan.tasks.find((x) => x.key === it.key);
      if (t && typeof it.url === 'string') t.issue_url = it.url;
    }
    recordDelivery(callId, plan, 'tasks', { target, at: new Date().toISOString(), url: null, detail: `${pending.length} task(s)` });
    return { kind: 'tasks', target, ok: true, lines: [`Sent ${pending.length} task(s) to the webhook.`, ...items.filter((i) => i.url).map((i) => `- ${i.key}: ${i.url}`)] };
  }
  // Linear / Jira / ClickUp: one item per task, dependencies linked by URL.
  const frames = getFrames(callId);
  const links = new Map(plan.tasks.filter((t) => t.issue_url).map((t) => [t.key, t.issue_url!]));
  const lines: string[] = [];
  let created = 0;
  for (const t of plan.tasks) {
    if (!t.include) { lines.push(`- ${t.key}: left out`); continue; }
    if (t.issue_url) { lines.push(`- ${t.key}: ${t.issue_url}`); continue; }
    try {
      const item = await createTaskIn(target as NativeTasksTarget, { title: t.title, priority: t.priority, markdown: taskMarkdown(t, { meeting: plan.title || call.title, links, frames }) });
      t.issue_url = item.url;
      links.set(t.key, item.url);
      savePlan(callId, plan); // saved per item: a failure halfway keeps the ones already created
      created++;
      lines.push(`- ${t.key}: ${item.url}`);
    } catch (e) {
      lines.push(`- ${t.key}: skipped (${(e as Error).message.slice(0, 300)})`);
    }
  }
  return { kind: 'tasks', target, ok: created > 0 || pending.length === 0, lines };
}

// ── CRM ─────────────────────────────────────────────────────────────────────

async function deliverCrm(callId: string, target: string): Promise<OutputResult> {
  const call = mustGetCall(callId);
  const plan = mustGetPlan(callId);
  const done = plan.deliveries?.crm;
  if (done) return { kind: 'crm', target, ok: true, lines: [`Already delivered ${done.at}${done.url ? `: ${done.url}` : ''}.`], url: done.url };
  const crm = plan.crm;
  if (!crm) return { kind: 'crm', target, ok: false, lines: ['The plan has no CRM update (plan again with the CRM output set, or add "crm" to the plan).'] };
  if (target === 'agent') {
    return {
      kind: 'crm', target, ok: true,
      lines: [
        'Put this in the CRM with your own tools (its MCP connector): find or create the company and the contacts, the deal when there is one, and log the note on them. Then call record_output { kind: "crm", url }.',
        '```json', JSON.stringify(crm, null, 2), '```',
      ],
    };
  }
  if (target === 'webhook') {
    const res = await postWebhook('crm', { call: callInfo(call), crm });
    const url = typeof res.url === 'string' ? res.url : null;
    recordDelivery(callId, plan, 'crm', { target, at: new Date().toISOString(), url });
    return { kind: 'crm', target, ok: true, lines: [`Sent to the webhook${url ? `: ${url}` : '.'}`], url };
  }
  const r = await deliverHubspot(crm, { title: plan.title || call.title });
  recordDelivery(callId, plan, 'crm', { target, at: new Date().toISOString(), url: r.url, detail: r.detail });
  return { kind: 'crm', target, ok: true, lines: [`HubSpot: ${r.detail}${r.url ? `\n${r.url}` : ''}`], url: r.url };
}

// ── Document ────────────────────────────────────────────────────────────────

/** The meeting document: the one in the plan, or one made from the plan. */
export function meetingDoc(call: Call, plan: Plan): { title: string; markdown: string } {
  if (plan.doc?.markdown) return { title: plan.doc.title || plan.title || call.title, markdown: plan.doc.markdown };
  const date = (call.joined_at ?? call.created_at).slice(0, 10);
  const md = [
    `# ${plan.title || call.title}`,
    `_${date}${call.meeting_url ? ` · ${call.meeting_url}` : ''}_`,
    plan.summary ? `## Summary\n${plan.summary}` : '',
    plan.tasks.some((t) => t.include) ? `## Action items\n${plan.tasks.filter((t) => t.include).map((t) => `- [ ] ${t.title}${t.priority ? ` (${t.priority})` : ''}${t.issue_url ? ` — ${t.issue_url}` : ''}`).join('\n')}` : '',
    plan.crm?.next_steps.length ? `## Next steps\n${plan.crm.next_steps.map((s) => `- ${s}`).join('\n')}` : '',
    plan.questions.length ? `## Open questions\n${plan.questions.map((q) => `- ${q}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  return { title: plan.title || call.title, markdown: md };
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'meeting';

async function deliverDoc(callId: string, target: string): Promise<OutputResult> {
  const call = mustGetCall(callId);
  const plan = mustGetPlan(callId);
  const done = plan.deliveries?.doc;
  if (done) return { kind: 'doc', target, ok: true, lines: [`Already delivered ${done.at}${done.url ? `: ${done.url}` : ''}.`], url: done.url };
  const doc = meetingDoc(call, plan);
  if (target === 'agent') {
    return {
      kind: 'doc', target, ok: true,
      lines: [`Create this document where the team keeps them (Google Docs, Notion, Confluence… with your own tools), then call record_output { kind: "doc", url }.`, `Title: ${doc.title}`, '', doc.markdown],
    };
  }
  let url: string | null;
  if (target === 'webhook') {
    const res = await postWebhook('doc', { call: callInfo(call), doc });
    url = typeof res.url === 'string' ? res.url : null;
  } else if (target === 'notion') {
    url = (await createNotionPage(doc.title, doc.markdown)).url;
  } else {
    const dir = config.docDir ?? callPaths(callId).dir;
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, config.docDir ? `${(call.joined_at ?? call.created_at).slice(0, 10)}-${slug(doc.title)}.md` : 'document.md');
    writeFileSync(file, `${doc.markdown.trim()}\n`);
    url = file;
  }
  recordDelivery(callId, plan, 'doc', { target, at: new Date().toISOString(), url });
  return { kind: 'doc', target, ok: true, lines: [`${doc.title}${url ? ` → ${url}` : ''}`], url };
}

function callInfo(call: Call) {
  return { id: call.id, title: call.title, source: call.source, meeting_url: call.meeting_url ?? null, joined_at: call.joined_at ?? null, ended_at: call.ended_at ?? null };
}

// ── During the meeting ──────────────────────────────────────────────────────

/** Where a task asked for in the meeting can be created right away (null: only after the call). */
export function liveTaskTarget(call: Call): string | null {
  if (call.autonomy === 'suggest') return null;
  const t = outputsOf(call).tasks;
  if (t === 'github') return call.repos.length === 1 ? 'github' : null;
  return t === 'linear' || t === 'jira' || t === 'clickup' || t === 'webhook' ? t : null;
}

/** A task someone asked for in the meeting, created now. */
export async function createTaskNow(call: Call, t: { title: string; description: string; priority: PlanPriority | null; requested_by?: string }): Promise<{ url: string | null; target: string }> {
  const target = liveTaskTarget(call);
  if (!target) throw new Error('tasks are created after the meeting for this call');
  const markdown = [t.description, `---\n_Asked for during the meeting **${call.title}**${t.requested_by ? ` by ${t.requested_by}` : ''}; created by open-meeting-agent._`].filter(Boolean).join('\n\n');
  let url: string | null;
  if (target === 'github') url = (await createIssue(call.repos[0]!, t.title, markdown)).url;
  else if (target === 'webhook') {
    const res = await postWebhook('task', { call: callInfo(call), task: { title: t.title, priority: t.priority, markdown } });
    url = typeof res.url === 'string' ? res.url : null;
  } else url = (await createTaskIn(target as NativeTasksTarget, { title: t.title, priority: t.priority, markdown })).url;
  return { url, target };
}
