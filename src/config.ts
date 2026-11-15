// Settings come from the environment, optionally from ~/.open-meeting-agent/config.json
// (same keys as the environment variables). The environment wins.

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ActMode, Autonomy, CrmTarget, DocTarget, TasksTarget } from './types.js';

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

let FILE = fileConfig();
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
/** anthropic / openai: an API. claude-code: Claude Code on this machine (`claude -p`,
 *  its own sign-in, no API key). command: any other command that reads the
 *  prompt on stdin and answers on stdout (OMA_LLM_COMMAND: codex exec, gemini…). */
export type LlmProvider = 'anthropic' | 'openai' | 'claude-code' | 'command';
export const LLM_PROVIDERS: readonly LlmProvider[] = ['anthropic', 'openai', 'claude-code', 'command'];

function asrProvider(): AsrProvider {
  const v = get('OMA_ASR');
  if (v === 'whisper-cpp' || v === 'openai' || v === 'none') return v;
  if (get('OMA_WHISPER_MODEL')) return 'whisper-cpp';
  if (get('OMA_ASR_API_KEY') || get('OPENAI_API_KEY')) return 'openai';
  return 'none';
}

function llmProvider(): LlmProvider | null {
  const v = get('OMA_LLM_PROVIDER') as LlmProvider | undefined;
  return v && LLM_PROVIDERS.includes(v) ? v : null;
}

export const TASKS_TARGETS: readonly TasksTarget[] = ['github', 'linear', 'jira', 'clickup', 'webhook', 'agent'];
export const CRM_TARGETS: readonly CrmTarget[] = ['hubspot', 'webhook', 'agent'];
export const DOC_TARGETS: readonly DocTarget[] = ['file', 'notion', 'webhook', 'agent'];
/** A target from the settings: one of `allowed`, "none"/"off" = nothing, unset = `fallback`. */
function target<T extends string>(name: string, allowed: readonly T[], fallback: T | null): T | null {
  const v = get(name)?.toLowerCase();
  if (!v) return fallback;
  if (v === 'none' || v === 'off') return null;
  return allowed.includes(v as T) ? v as T : fallback;
}

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

function build() {
  const autonomy = get('OMA_AUTONOMY');
  const act = get('OMA_ACT');
  return {
    home: HOME,
    callsDir: path.join(HOME, 'calls'),
    /** Language the plan, issues and agent messages are written in. */
    language: get('OMA_LANGUAGE') ?? 'en',
    agentName: get('OMA_AGENT_NAME') ?? 'Meeting Agent',
    autonomy: (autonomy === 'issues' || autonomy === 'prs' ? autonomy : 'suggest') as Autonomy,
    /** When the agent acts: after the call, during it, or both. */
    act: (act === 'during' || act === 'both' ? act : 'after') as ActMode,

    // ── In the meeting (act: during / both) ───────────────────────────────────
    /** Other names people use to call the agent in the meeting (comma-separated), besides its display name. */
    liveNames: (get('OMA_LIVE_NAMES') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    /** What the agent posts in the chat when it gets in ("off": nothing; unset: a short hello). */
    liveGreeting: get('OMA_LIVE_GREETING') ?? null,

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

    // ── Where the outputs go (defaults for new calls) ─────────────────────────
    tasksTarget: target('OMA_TASKS_TARGET', TASKS_TARGETS, 'github'),
    crmTarget: target('OMA_CRM_TARGET', CRM_TARGETS, null),
    docTarget: target('OMA_DOC_TARGET', DOC_TARGETS, null),

    linearApiKey: get('LINEAR_API_KEY') ?? null,
    /** Team id, key (ENG) or name. */
    linearTeam: get('OMA_LINEAR_TEAM') ?? null,
    linearApiUrl: get('OMA_LINEAR_API_URL') ?? 'https://api.linear.app/graphql',

    jiraBaseUrl: (get('JIRA_BASE_URL') ?? '').replace(/\/$/, '') || null,
    jiraEmail: get('JIRA_EMAIL') ?? null,
    jiraApiToken: get('JIRA_API_TOKEN') ?? null,
    jiraProject: get('OMA_JIRA_PROJECT') ?? null,
    jiraIssueType: get('OMA_JIRA_ISSUE_TYPE') ?? 'Task',

    clickupToken: get('CLICKUP_API_TOKEN') ?? null,
    clickupListId: get('OMA_CLICKUP_LIST_ID') ?? null,
    clickupApiUrl: (get('OMA_CLICKUP_API_URL') ?? 'https://api.clickup.com/api/v2').replace(/\/$/, ''),

    hubspotToken: get('HUBSPOT_TOKEN') ?? null,
    hubspotApiUrl: (get('OMA_HUBSPOT_API_URL') ?? 'https://api.hubapi.com').replace(/\/$/, ''),
    /** Deal stage id for new deals (stages are per pipeline; unset: HubSpot's default). */
    hubspotDealStage: get('OMA_HUBSPOT_DEAL_STAGE') ?? null,
    hubspotPipeline: get('OMA_HUBSPOT_PIPELINE') ?? null,

    notionToken: get('NOTION_TOKEN') ?? null,
    /** Where documents go in Notion: a page (children) or a database (rows). */
    notionParentPage: get('OMA_NOTION_PARENT_PAGE_ID') ?? null,
    notionDatabase: get('OMA_NOTION_DATABASE_ID') ?? null,
    notionTitleProperty: get('OMA_NOTION_TITLE_PROPERTY') ?? 'Name',
    notionApiUrl: (get('OMA_NOTION_API_URL') ?? 'https://api.notion.com/v1').replace(/\/$/, ''),

    /** Folder for documents (target "file"); unset: the call's own folder. */
    docDir: get('OMA_DOC_DIR') ?? null,
    /** A markdown file whose structure the meeting document follows. */
    docTemplate: get('OMA_DOC_TEMPLATE') ?? null,

    webhookUrl: get('OMA_WEBHOOK_URL') ?? null,
    /** Signs each webhook body: x-oma-signature: sha256=<hex HMAC>. */
    webhookSecret: get('OMA_WEBHOOK_SECRET') ?? null,

    meetilyDb: get('OMA_MEETILY_DB') ?? defaultMeetilyDb(),

    // ── Local agents ──────────────────────────────────────────────────────────
    /** Claude Code's command (provider claude-code, and the UI's chat). */
    claudeBin: get('OMA_CLAUDE_BIN') ?? 'claude',
    /** Provider "command": run with the prompt on stdin, the answer on stdout. */
    llmCommand: get('OMA_LLM_COMMAND') ?? null,

    // ── The web UI (oma ui) ───────────────────────────────────────────────────
    uiPort: num('OMA_UI_PORT', 4141),
    /** Who answers in the UI's chat: Claude Code, or any command (OMA_UI_AGENT_COMMAND). */
    uiAgent: (get('OMA_UI_AGENT') === 'command' ? 'command' : 'claude') as 'claude' | 'command',
    uiAgentCommand: get('OMA_UI_AGENT_COMMAND') ?? null,
    /** Claude Code's model for the UI's chat (unset: its own default). */
    uiModel: get('OMA_UI_MODEL') ?? null,
    /** Tools the UI's chat may use without asking, besides the meeting tools (Claude Code rules: "Bash(git status:*)", "Edit"). */
    uiAllowedTools: list(get('OMA_UI_ALLOWED_TOOLS')),
    /** The folder new chats work in (unset: your home folder). */
    uiWorkdir: get('OMA_UI_WORKDIR') ?? null,
  };
}

export const config = build();
export type Config = typeof config;

/** Read config.json and the environment again (the UI changes settings while it runs). */
export function reloadConfig(): void {
  FILE = fileConfig();
  Object.assign(config, build());
}
