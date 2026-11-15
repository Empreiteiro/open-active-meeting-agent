// The plan's tasks in the team's task platform: GitHub issues (github.ts),
// Linear, Jira or ClickUp — one item per task, with its criteria, its
// dependencies linked and the screens it refers to.

import { config } from '../config.js';
import { fmtTime } from '../plan/prompt.js';
import type { Frame, PlanPriority, PlanTask } from '../types.js';
import { requestJson } from './http.js';

export type NativeTasksTarget = 'linear' | 'jira' | 'clickup';
export interface TaskItem { title: string; markdown: string; priority: PlanPriority | null }

/** The task as markdown, for any platform. `links` maps task keys to their items. */
export function taskMarkdown(task: PlanTask, ctx: { meeting: string; links: Map<string, string>; frames: Frame[] }): string {
  const deps = task.depends_on.map((k) => ctx.links.get(k) ?? k);
  const shots = task.frames.map((l) => ctx.frames.find((f) => f.label === l)).filter((f): f is Frame => !!f)
    .map((f) => `- ${f.label} (${fmtTime(f.t)})`);
  return [
    task.description,
    task.acceptance.length ? `### Acceptance criteria\n${task.acceptance.map((a) => `- [ ] ${a}`).join('\n')}` : '',
    deps.length ? `Depends on: ${deps.join(', ')}` : '',
    task.repo ? `Repository: ${task.repo}` : '',
    shots.length ? `### Screens from the call\n${shots.join('\n')}\n\n_The screenshots stay on the machine that recorded the call._` : '',
    `---\n_Planned from the meeting **${ctx.meeting}** by open-meeting-agent._`,
  ].filter(Boolean).join('\n\n');
}

/** What is missing to use a platform ('' when it is ready). */
export function tasksSetupProblem(target: NativeTasksTarget): string {
  if (target === 'linear') return config.linearApiKey ? '' : 'LINEAR_API_KEY is not set';
  if (target === 'jira') {
    const missing = [!config.jiraBaseUrl && 'JIRA_BASE_URL', !config.jiraEmail && 'JIRA_EMAIL', !config.jiraApiToken && 'JIRA_API_TOKEN', !config.jiraProject && 'OMA_JIRA_PROJECT'].filter(Boolean);
    return missing.length ? `${missing.join(', ')} not set` : '';
  }
  const missing = [!config.clickupToken && 'CLICKUP_API_TOKEN', !config.clickupListId && 'OMA_CLICKUP_LIST_ID'].filter(Boolean);
  return missing.length ? `${missing.join(', ')} not set` : '';
}

export async function createTaskIn(target: NativeTasksTarget, item: TaskItem): Promise<{ url: string; id: string }> {
  const problem = tasksSetupProblem(target);
  if (problem) throw new Error(`${target}: ${problem}`);
  if (target === 'linear') return linear(item);
  if (target === 'jira') return jira(item);
  return clickup(item);
}

// ── Linear ──────────────────────────────────────────────────────────────────

const LINEAR_PRIORITY: Record<PlanPriority, number> = { urgent: 1, high: 2, medium: 3, low: 4 };
let linearTeamCache: string | null = null;

async function linearGql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await requestJson<{ data?: T; errors?: Array<{ message?: string }> }>('POST', config.linearApiUrl, {
    label: 'Linear', headers: { authorization: config.linearApiKey! }, body: { query, variables },
  });
  if (r.errors?.length || !r.data) throw new Error(`Linear: ${r.errors?.map((e) => e.message).join('; ') || 'no data'}`);
  return r.data;
}

/** OMA_LINEAR_TEAM as an id, a key (ENG) or a name; the only team when unset. */
async function linearTeamId(): Promise<string> {
  if (linearTeamCache) return linearTeamCache;
  const want = config.linearTeam?.trim();
  if (want && /^[0-9a-f-]{36}$/i.test(want)) return (linearTeamCache = want);
  const { teams } = await linearGql<{ teams: { nodes: Array<{ id: string; key: string; name: string }> } }>('query { teams { nodes { id key name } } }');
  const all = teams.nodes;
  const hit = want
    ? all.find((t) => t.key.toLowerCase() === want.toLowerCase() || t.name.toLowerCase() === want.toLowerCase())
    : all.length === 1 ? all[0] : undefined;
  if (!hit) throw new Error(`Linear: set OMA_LINEAR_TEAM to one of: ${all.map((t) => `${t.key} (${t.name})`).join(', ') || 'no teams'}`);
  return (linearTeamCache = hit.id);
}

async function linear(item: TaskItem): Promise<{ url: string; id: string }> {
  const teamId = await linearTeamId();
  const { issueCreate } = await linearGql<{ issueCreate: { success: boolean; issue?: { id: string; identifier: string; url: string } } }>(
    'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }',
    { input: { teamId, title: item.title, description: item.markdown, priority: item.priority ? LINEAR_PRIORITY[item.priority] : 0 } },
  );
  if (!issueCreate.success || !issueCreate.issue) throw new Error('Linear: issue not created');
  return { url: issueCreate.issue.url, id: issueCreate.issue.identifier };
}

// ── Jira ────────────────────────────────────────────────────────────────────

/** Markdown → Jira wiki markup (REST v2 descriptions), the parts tasks use. */
export function jiraText(md: string): string {
  return md.split('\n').map((l) => l
    .replace(/^#{3,}\s+/, 'h3. ').replace(/^##\s+/, 'h2. ').replace(/^#\s+/, 'h1. ')
    .replace(/^\s*- \[[ xX]\]\s+/, '* ').replace(/^\s*[-*]\s+/, '* ')
    .replace(/^>\s?/, 'bq. ')
    .replace(/^---$/, '----')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/`([^`]+)`/g, '{{$1}}')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '[$1|$2]')).join('\n');
}

async function jira(item: TaskItem): Promise<{ url: string; id: string }> {
  const auth = Buffer.from(`${config.jiraEmail}:${config.jiraApiToken}`).toString('base64');
  const r = await requestJson<{ key?: string; id?: string }>('POST', `${config.jiraBaseUrl}/rest/api/2/issue`, {
    label: 'Jira',
    headers: { authorization: `Basic ${auth}` },
    body: { fields: { project: { key: config.jiraProject }, summary: item.title.slice(0, 250), description: jiraText(item.markdown), issuetype: { name: config.jiraIssueType } } },
  });
  if (!r.key) throw new Error('Jira: issue not created');
  return { url: `${config.jiraBaseUrl}/browse/${r.key}`, id: r.key };
}

// ── ClickUp ─────────────────────────────────────────────────────────────────

const CLICKUP_PRIORITY: Record<PlanPriority, number> = { urgent: 1, high: 2, medium: 3, low: 4 };

async function clickup(item: TaskItem): Promise<{ url: string; id: string }> {
  const r = await requestJson<{ id?: string; url?: string }>('POST', `${config.clickupApiUrl}/list/${encodeURIComponent(config.clickupListId!)}/task`, {
    label: 'ClickUp',
    headers: { authorization: config.clickupToken! },
    // markdown_content wins over description where it is supported.
    body: { name: item.title, markdown_content: item.markdown, description: item.markdown, ...(item.priority ? { priority: CLICKUP_PRIORITY[item.priority] } : {}) },
  });
  if (!r.id) throw new Error('ClickUp: task not created');
  return { url: r.url ?? `https://app.clickup.com/t/${r.id}`, id: r.id };
}
