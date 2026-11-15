// The planning model, when one is configured. Two wire formats cover most
// APIs: Anthropic's Messages API, and the OpenAI-compatible chat API (OpenAI,
// Ollama, LM Studio, OpenRouter, vLLM…), with plain fetch. Or a local agent:
// Claude Code (`claude -p`, its own sign-in) or any command that reads the
// prompt on stdin (codex exec, gemini…).
//
// Without a configured model nothing here runs: the connected agent (Claude
// Code, Cursor, Codex…) reads the call with get_call_context and saves the plan.

import { mkdirSync, readFileSync } from 'node:fs';
import { runClaude, type ClaudeBlock } from '../agents/claude.js';
import { runCommand } from '../agents/command.js';
import { config } from '../config.js';
import type { PlanBlock } from '../plan/prompt.js';

export interface Turn { role: 'user' | 'assistant'; content: string | PlanBlock[] }
export interface ChatResult { text: string; model: string; inputTokens: number; outputTokens: number }
/** Per call: a short answer in the meeting doesn't need the planning budget. */
export interface ChatOptions { maxTokens?: number; timeoutMs?: number }

export class LlmError extends Error {
  constructor(readonly code: 'llm_not_configured' | 'llm_refused' | 'llm_truncated' | 'llm_failed', message: string) {
    super(message);
  }
}

export function llmConfigured(): boolean {
  if (config.llm === 'claude-code') return true;
  if (config.llm === 'command') return !!config.llmCommand;
  return !!config.llm && !!config.llmModel;
}

export function llmLabel(): string {
  if (config.llm === 'claude-code') return `claude-code${config.llmModel ? `:${config.llmModel}` : ''}`;
  if (config.llm === 'command') return `command:${config.llmCommand?.split(/\s+/)[0] ?? ''}`;
  return `${config.llm}:${config.llmModel}`;
}

const MAX_TOKENS = 16_000;

function imageData(file: string): string {
  return readFileSync(file).toString('base64');
}

export async function chat(system: string, turns: Turn[], opts: ChatOptions = {}): Promise<ChatResult> {
  if (!llmConfigured()) {
    throw new LlmError('llm_not_configured', 'No planning model configured (OMA_LLM_PROVIDER: claude-code, or an API with OMA_LLM_MODEL). Use get_call_context and save_plan to build the plan in the connected agent instead.');
  }
  if (config.llm === 'claude-code') return claudeCode(system, turns, opts);
  if (config.llm === 'command') return command(system, turns, opts);
  return config.llm === 'anthropic' ? anthropic(system, turns, opts) : openaiCompatible(system, turns, opts);
}

/** Earlier turns (a retry after an answer) folded into one message: the local
 *  agents take one prompt. */
function oneMessage(turns: Turn[]): PlanBlock[] {
  const out: PlanBlock[] = [];
  for (const t of turns) {
    const blocks: PlanBlock[] = typeof t.content === 'string' ? [{ type: 'text', text: t.content }] : t.content;
    if (t.role === 'assistant') {
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      out.push({ type: 'text', text: `<your_previous_answer>\n${text}\n</your_previous_answer>` });
    } else out.push(...blocks);
  }
  return out;
}

async function claudeCode(system: string, turns: Turn[], opts: ChatOptions): Promise<ChatResult> {
  mkdirSync(config.home, { recursive: true });
  const content: ClaudeBlock[] = oneMessage(turns).map((b) => (b.type === 'text'
    ? { type: 'text', text: b.text }
    : { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData(b.file) } }));
  try {
    const r = await runClaude({
      content, cwd: config.home, systemPrompt: system, tools: [], strictMcp: true, persist: false,
      model: config.llmModel, timeoutMs: opts.timeoutMs ?? config.llmTimeoutMs,
    }).result;
    if (r.isError) throw new LlmError('llm_failed', `Claude Code: ${r.text.slice(0, 400) || 'failed'}`);
    return { text: r.text.trim(), model: `claude-code:${r.model ?? 'default'}`, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  } catch (e) {
    throw e instanceof LlmError ? e : new LlmError('llm_failed', (e as Error).message);
  }
}

async function command(system: string, turns: Turn[], opts: ChatOptions): Promise<ChatResult> {
  mkdirSync(config.home, { recursive: true });
  // Text only: a screen goes as its file, for agents that can open files.
  const body = oneMessage(turns).map((b) => (b.type === 'text' ? b.text : `[screen ${b.label}: ${b.file}]`)).join('\n\n');
  try {
    const text = await runCommand(config.llmCommand!, `${system}\n\n${body}`, { cwd: config.home, timeoutMs: opts.timeoutMs ?? config.llmTimeoutMs }).result;
    return { text: text.trim(), model: llmLabel(), inputTokens: 0, outputTokens: 0 };
  } catch (e) {
    throw new LlmError('llm_failed', (e as Error).message);
  }
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  let r: Response;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new LlmError('llm_failed', `${url}: ${(e as Error).message}`);
  }
  const text = await r.text();
  if (!r.ok) throw new LlmError('llm_failed', `${url}: HTTP ${r.status} ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new LlmError('llm_failed', `${url}: invalid JSON answer`);
  }
}

async function anthropic(system: string, turns: Turn[], opts: ChatOptions): Promise<ChatResult> {
  const key = config.llmApiKey ?? config.anthropicApiKey;
  if (!key) throw new LlmError('llm_not_configured', 'Anthropic needs OMA_LLM_API_KEY or ANTHROPIC_API_KEY.');
  const base = (config.llmBaseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const messages = turns.map((t) => ({
    role: t.role,
    content: typeof t.content === 'string'
      ? t.content
      : t.content.map((b) => b.type === 'text'
        ? { type: 'text', text: b.text }
        : { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData(b.file) } }),
  }));
  const res = await post(`${base}/v1/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, {
    model: config.llmModel, max_tokens: opts.maxTokens ?? MAX_TOKENS, system, messages,
  }, opts.timeoutMs ?? config.llmTimeoutMs);
  const stop = res.stop_reason as string | undefined;
  if (stop === 'refusal') throw new LlmError('llm_refused', 'The model refused to plan this call.');
  if (stop === 'max_tokens') throw new LlmError('llm_truncated', 'The plan went over the output limit.');
  const blocks = Array.isArray(res.content) ? res.content as Array<{ type: string; text?: string }> : [];
  const usage = (res.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim(),
    model: String(res.model ?? config.llmModel),
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
}

async function openaiCompatible(system: string, turns: Turn[], opts: ChatOptions): Promise<ChatResult> {
  const base = (config.llmBaseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const key = config.llmApiKey ?? (base.includes('api.openai.com') ? config.openaiApiKey : null);
  const messages = [
    { role: 'system', content: system },
    ...turns.map((t) => ({
      role: t.role,
      content: typeof t.content === 'string'
        ? t.content
        : t.content.map((b) => b.type === 'text'
          ? { type: 'text', text: b.text }
          : { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageData(b.file)}` } }),
    })),
  ];
  const res = await post(`${base}/chat/completions`, key ? { authorization: `Bearer ${key}` } : {}, {
    model: config.llmModel, max_tokens: opts.maxTokens ?? MAX_TOKENS, messages,
  }, opts.timeoutMs ?? config.llmTimeoutMs);
  const choice = (Array.isArray(res.choices) ? res.choices[0] : null) as { message?: { content?: unknown; refusal?: string }; finish_reason?: string } | null;
  if (choice?.message?.refusal) throw new LlmError('llm_refused', choice.message.refusal);
  if (choice?.finish_reason === 'length') throw new LlmError('llm_truncated', 'The plan went over the output limit.');
  const content = choice?.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? '').join('\n') : '';
  const usage = (res.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
  return {
    text: text.trim(),
    model: String(res.model ?? config.llmModel),
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  };
}
