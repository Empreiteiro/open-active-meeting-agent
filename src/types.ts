// Shared shapes. A "call" is one meeting the agent took part in (or one
// recording imported from meetily or a file), stored as a folder on disk.

/** bot: joined a Meet / Teams call. huddle: a meeting in the web UI itself (you share your screen there). */
export type CallSource = 'bot' | 'huddle' | 'meetily' | 'file';

/** How far the agent goes after the meeting without asking.
 *  suggest: builds the plan and waits for the person.
 *  issues:  also delivers it: the tasks to the tasks platform (GitHub issues,
 *           Linear, Jira, ClickUp…), the CRM update, the meeting document.
 *  prs:     also works the code tasks and opens the pull requests. */
export type Autonomy = 'suggest' | 'issues' | 'prs';

/** When the agent acts.
 *  after:  quiet in the meeting; works once it is over (the default).
 *  during: answers and acts in the meeting when someone addresses it; after
 *          the call it only keeps the transcript and the plan (nothing is delivered).
 *  both:   in the meeting and after it. */
export type ActMode = 'after' | 'during' | 'both';

/** What the agent delivers after the call, and where. "agent" hands it to the
 *  connected agent (Claude Code, Cursor…), which puts it in place with its own
 *  tools (MCP connectors for HubSpot, Notion, Google Docs, Asana…). */
export type TasksTarget = 'github' | 'linear' | 'jira' | 'clickup' | 'webhook' | 'agent';
export type CrmTarget = 'hubspot' | 'webhook' | 'agent';
export type DocTarget = 'file' | 'notion' | 'webhook' | 'agent';
export interface Outputs {
  tasks: TasksTarget | null;
  crm: CrmTarget | null;
  doc: DocTarget | null;
}
export type OutputKind = keyof Outputs;

export type CallStatus =
  | 'joining'      // the bot is on its way into the meeting
  | 'in_call'      // the bot is in the meeting, recording
  | 'processing'   // transcribing and extracting the screen frames
  | 'needs_plan'   // transcript + frames ready; a plan has to be built
  | 'planned'      // the plan exists (tasks may be in progress)
  | 'failed'
  | 'cancelled';

export interface Segment {
  start: number;   // seconds from the start of the recording
  end: number;
  speaker: string;
  text: string;
}

export interface Frame {
  label: string;   // F1, F2…
  t: number;       // seconds from the start of the recording
  file: string;    // absolute path of the JPEG
}

export type PlanPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskState = 'todo' | 'in_progress' | 'blocked' | 'done' | 'skipped';

export interface PlanTask {
  key: string;
  title: string;
  description: string;
  acceptance: string[];
  frames: string[];          // frame labels (F#)
  repo: string | null;       // owner/repo
  deliverable: 'pr' | 'issue';
  priority: PlanPriority | null;
  depends_on: string[];      // task keys
  include: boolean;
  state: TaskState;
  /** The task's link in the tasks platform (a GitHub issue, Linear, Jira, ClickUp…). */
  issue_url?: string | null;
  pr_url?: string | null;
  notes?: string[];
}

/** What the call means for the CRM. Only what was said: null when unknown. */
export interface CrmUpdate {
  company: { name: string; domain: string | null } | null;
  contacts: Array<{ name: string; email: string | null; role: string | null; phone: string | null }>;
  deal: { name: string; stage: string | null; amount: number | null; currency: string | null; close_date: string | null } | null;
  /** The note logged on the records: what the call was about and what was agreed. */
  summary: string;
  next_steps: string[];
}

/** The meeting document (minutes, a brief, a proposal… per OMA_DOC_TEMPLATE). */
export interface MeetingDoc {
  title: string;
  markdown: string;
}

/** Where an output was delivered. */
export interface Delivery {
  target: string;
  at: string;
  url: string | null;
  detail?: string | null;
}

export interface Plan {
  version: 1;
  title: string;
  summary: string;
  questions: string[];
  tasks: PlanTask[];
  crm?: CrmUpdate | null;
  doc?: MeetingDoc | null;
  /** Where each output went (tasks: only for webhook / agent, the others keep a link per task). */
  deliveries?: Partial<Record<OutputKind, Delivery>>;
  built_by: string;          // 'host' (the connected agent) or 'provider:model'
  built_at: string;
}

export interface CallNote {
  at: string;
  text: string;
}

export interface Call {
  id: string;
  title: string;
  source: CallSource;
  status: CallStatus;
  error?: string | null;
  autonomy: Autonomy;
  /** When the agent acts (calls made before this setting existed: after). */
  act?: ActMode;
  /** What is delivered after the call and where (missing: tasks to GitHub). */
  outputs?: Outputs;
  /** Tasks created in the meeting when someone asked for them. */
  live_tasks?: Array<{ title: string; url: string | null; at: string }>;
  /** Repositories the tasks may target (owner/repo). */
  repos: string[];
  /** Folder the coding agent works in (the host's cwd when the call started). */
  workdir: string | null;
  agent_name: string;
  meeting_url?: string | null;
  provider?: 'google_meet' | 'microsoft_teams' | null;
  container?: string | null;
  meetily_id?: string | null;
  language: string;
  /** The language spoken, when known (a huddle: the browser's): a hint for the transcription. */
  spoken_language?: string | null;
  created_at: string;
  updated_at: string;
  joined_at?: string | null;
  ended_at?: string | null;
  notes: CallNote[];
  /** Why/how the bot left (from the bot's exit.json). */
  exit?: Record<string, unknown> | null;
}
