// Building the plan: with the configured model (build_plan), or from the JSON
// the connected agent wrote after reading the call (save_plan).

import { chat, LlmError, llmLabel, type Turn } from '../llm/index.js';
import { getFrames, getTranscript, logCall, mustGetCall, savePlan, updateCall } from '../store.js';
import type { Plan } from '../types.js';
import { normalizePlan, parseJsonObject, planQuestions } from './normalize.js';
import { buildPlanBlocks, EMPTY_PLAN_NUDGE, systemPrompt } from './prompt.js';

/** A plan with no task: what the model understood and asked, so the person
 *  can answer with a note (add_note) and plan again. */
export class PlanEmptyError extends Error {
  constructor(readonly summary: string, readonly questions: string[]) {
    super('plan_empty');
  }
}

export function callBlocks(callId: string) {
  const call = mustGetCall(callId);
  const segments = getTranscript(callId) ?? [];
  const frames = getFrames(callId);
  if (!segments.length && !frames.length) throw new Error('This call has no transcript or frames yet (still processing?).');
  return { call, blocks: buildPlanBlocks({ title: call.title, repos: call.repos, segments, frames, notes: call.notes }), frames };
}

export async function buildPlan(callId: string): Promise<Plan> {
  const { call, blocks, frames } = callBlocks(callId);
  const system = systemPrompt(call.language);
  const turns: Turn[] = [{ role: 'user', content: [...blocks, { type: 'text', text: 'Now return the plan as JSON.' }] }];
  logCall(callId, `plan: asking ${llmLabel()}`);
  const first = await chat(system, turns);
  let raw = parseJsonObject(first.text);
  if (!raw) throw new LlmError('llm_failed', 'The model did not answer with a JSON plan.');
  const labels = frames.map((f) => f.label);
  let plan = normalizePlan(raw, labels, call.repos, `${llmLabel()}`);
  if (!plan && first.text) {
    // Empty: models tend to put a short request entirely into "questions".
    logCall(callId, 'plan: no tasks — asking again');
    const again = await chat(system, [...turns, { role: 'assistant', content: first.text }, { role: 'user', content: EMPTY_PLAN_NUDGE }]);
    const raw2 = parseJsonObject(again.text);
    if (raw2) {
      raw = raw2;
      plan = normalizePlan(raw2, labels, call.repos, `${llmLabel()}`);
    }
  }
  if (!plan) {
    const q = planQuestions(raw);
    updateCall(callId, { status: 'needs_plan', error: 'plan_empty' });
    throw new PlanEmptyError(q.summary, q.questions);
  }
  if (!plan.title) plan.title = call.title;
  savePlan(callId, plan);
  updateCall(callId, { status: 'planned', error: null });
  logCall(callId, `plan: ${plan.tasks.length} task(s) by ${plan.built_by}`);
  return plan;
}

/** The plan the connected agent wrote. Same validation as the model's. */
export function saveHostPlan(callId: string, input: unknown): Plan {
  const call = mustGetCall(callId);
  const raw = typeof input === 'string' ? parseJsonObject(input) : (input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null);
  if (!raw) throw new Error('The plan must be a JSON object: {title, summary, questions, tasks: [...]}.');
  const plan = normalizePlan(raw, getFrames(callId).map((f) => f.label), call.repos, 'host');
  if (!plan) throw new Error('The plan has no task with a title. Every change asked for in the call is a task; put open points in "questions".');
  if (!plan.title) plan.title = call.title;
  savePlan(callId, plan);
  updateCall(callId, { status: 'planned', error: null });
  logCall(callId, `plan: ${plan.tasks.length} task(s) saved by the connected agent`);
  return plan;
}
