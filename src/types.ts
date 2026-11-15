// Shared shapes. A "call" is one meeting the agent took part in (or one
// recording imported from meetily or a file), stored as a folder on disk.

export type CallSource = 'bot' | 'meetily' | 'file';

/** How far the agent goes after the meeting without asking.
 *  suggest: builds the plan and waits for the person.
 *  issues:  also opens the GitHub issues.
 *  prs:     also works the tasks and opens the pull requests. */
export type Autonomy = 'suggest' | 'issues' | 'prs';

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
  issue_url?: string | null;
  pr_url?: string | null;
  notes?: string[];
}

export interface Plan {
  version: 1;
  title: string;
  summary: string;
  questions: string[];
  tasks: PlanTask[];
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
  created_at: string;
  updated_at: string;
  joined_at?: string | null;
  ended_at?: string | null;
  notes: CallNote[];
  /** Why/how the bot left (from the bot's exit.json). */
  exit?: Record<string, unknown> | null;
}
