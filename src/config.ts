// Settings come from the environment, optionally from ~/.open-meeting-agent/config.json
// (same keys as the environment variables). The environment wins.

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Autonomy } from './types.js';

const HOME = process.env.OMA_HOME || path.join(os.homedir(), '.open-meeting-agent');

function fileConfig(): Record<string, string> {
  const p = path.join(HOME, 'config.json');
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}

const FILE = fileConfig();
const get = (name: string): string | undefined => {
  const v = process.env[name] ?? FILE[name];
  return v && v.trim() ? v.trim() : undefined;
};
const num = (name: string, fallback: number): number => {
  const n = Number(get(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** meetily keeps its SQLite under the Tauri app-data dir (identifier com.meetily.ai). */
function defaultMeetilyDb(): string {
  const id = 'com.meetily.ai';
  const file = 'meeting_minutes.sqlite';
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', id, file);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), id, file);
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), id, file);
}

export type AsrProvider = 'whisper-cpp' | 'openai' | 'none';
export type LlmProvider = 'anthropic' | 'openai';

function asrProvider(): AsrProvider {
  const v = get('OMA_ASR');
  if (v === 'whisper-cpp' || v === 'openai' || v === 'none') return v;
  if (get('OMA_WHISPER_MODEL')) return 'whisper-cpp';
  if (get('OMA_ASR_API_KEY') || get('OPENAI_API_KEY')) return 'openai';
  return 'none';
}

function llmProvider(): LlmProvider | null {
  const v = get('OMA_LLM_PROVIDER');
  return v === 'anthropic' || v === 'openai' ? v : null;
}

const autonomy = get('OMA_AUTONOMY');

export const config = {
  home: HOME,
  callsDir: path.join(HOME, 'calls'),
  /** Language the plan, issues and agent messages are written in. */
  language: get('OMA_LANGUAGE') ?? 'en',
  agentName: get('OMA_AGENT_NAME') ?? 'Meeting Agent',
  autonomy: (autonomy === 'issues' || autonomy === 'prs' ? autonomy : 'suggest') as Autonomy,

  // ── The bot (a container that joins the meeting) ──────────────────────────
  containerEngine: get('OMA_CONTAINER_ENGINE') ?? null,
  botImage: get('OMA_BOT_IMAGE') ?? 'open-meeting-agent-bot:latest',
  botAuthGoogle: get('OMA_BOT_AUTH_GOOGLE') ?? null,
  botAuthTeams: get('OMA_BOT_AUTH_TEAMS') ?? null,
  botLocale: get('OMA_BOT_LOCALE') ?? 'en-US',
  botTimezone: get('OMA_BOT_TIMEZONE') ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  maxMeetingMinutes: num('OMA_MAX_MEETING_MINUTES', 120),

  // ── Media ─────────────────────────────────────────────────────────────────
  ffmpeg: get('OMA_FFMPEG') ?? 'ffmpeg',
  ffprobe: get('OMA_FFPROBE') ?? 'ffprobe',
  maxFrames: num('OMA_MAX_FRAMES', 40),

  // ── Transcription ─────────────────────────────────────────────────────────
  asr: asrProvider(),
  whisperBin: get('OMA_WHISPER_BIN') ?? 'whisper-cli',
  whisperModel: get('OMA_WHISPER_MODEL') ?? null,
  asrBaseUrl: (get('OMA_ASR_BASE_URL') ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
  asrApiKey: get('OMA_ASR_API_KEY') ?? get('OPENAI_API_KEY') ?? null,
  asrModel: get('OMA_ASR_MODEL') ?? 'whisper-1',
  /** Spoken language hint (en, pt…); unset = detected from the audio. */
  asrLanguage: get('OMA_ASR_LANGUAGE') ?? null,

  // ── Planning model (optional: without it the connected agent builds the plan)
  llm: llmProvider(),
  llmModel: get('OMA_LLM_MODEL') ?? null,
  llmBaseUrl: get('OMA_LLM_BASE_URL') ?? null,
  llmApiKey: get('OMA_LLM_API_KEY') ?? null,
  anthropicApiKey: get('ANTHROPIC_API_KEY') ?? null,
  openaiApiKey: get('OPENAI_API_KEY') ?? null,
  llmTimeoutMs: num('OMA_LLM_TIMEOUT_SECONDS', 600) * 1000,

  // ── After the meeting ─────────────────────────────────────────────────────
  /** Command run when a call is ready to plan (template: {call_id} {prompt} {workdir}). */
  agentCommand: get('OMA_AGENT_COMMAND') ?? null,
  githubToken: get('GITHUB_TOKEN') ?? get('GH_TOKEN') ?? null,
  /** GitHub Enterprise: https://<host>/api/v3 */
  githubApiUrl: (get('OMA_GITHUB_API_URL') ?? 'https://api.github.com').replace(/\/$/, ''),

  meetilyDb: get('OMA_MEETILY_DB') ?? defaultMeetilyDb(),
} as const;

export type Config = typeof config;
