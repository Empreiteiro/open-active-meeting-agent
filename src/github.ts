// GitHub issues for the plan's tasks: with GITHUB_TOKEN, or through the gh CLI
// already logged in on the machine.

import { spawn } from 'node:child_process';
import { config } from './config.js';
import { fmtTime } from './plan/prompt.js';
import { getFrames, logCall, mustGetCall, savePlan } from './store.js';
import { mustGetPlan } from './tasks.js';
import type { PlanTask } from './types.js';

function gh(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => reject(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'gh CLI not found: install it and run `gh auth login`, or set GITHUB_TOKEN' : e.message)));
    p.on('close', (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `gh exit ${c}`))));
    p.stdin.end(input ?? '');
  });
}

export async function createIssue(repo: string, title: string, body: string): Promise<{ url: string; number: number }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`invalid repository: ${repo}`);
  if (config.githubToken) {
    const r = await fetch(`${config.githubApiUrl}/repos/${repo}/issues`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.githubToken}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'open-meeting-agent' },
      body: JSON.stringify({ title, body }),
    });
    const j = (await r.json().catch(() => ({}))) as { html_url?: string; number?: number; message?: string };
    if (!r.ok || !j.html_url) throw new Error(`GitHub ${r.status}: ${j.message ?? 'issue not created'}`);
    return { url: j.html_url, number: j.number ?? 0 };
  }
  const url = await gh(['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-'], body);
  const m = url.match(/\/issues\/(\d+)/);
  return { url: url.split('\n').pop() ?? url, number: m ? Number(m[1]) : 0 };
}

function issueBody(task: PlanTask, ctx: { title: string; numbers: Map<string, number>; frames: string[] }): string {
  const deps = task.depends_on.map((k) => ctx.numbers.get(k)).filter(Boolean).map((n) => `#${n}`);
  return [
    task.description,
    task.acceptance.length ? `### Acceptance criteria\n${task.acceptance.map((a) => `- [ ] ${a}`).join('\n')}` : '',
    deps.length ? `Depends on ${deps.join(', ')}` : '',
    ctx.frames.length ? `### Screens from the call\n${ctx.frames.join('\n')}\n\n_The screenshots stay on the machine that recorded the call._` : '',
    `---\n_Planned from the meeting **${ctx.title}** by open-meeting-agent._`,
  ].filter(Boolean).join('\n\n');
}

/** One issue per included task that has a repository and no issue yet. */
export async function distributePlan(callId: string, opts: { repo?: string | null } = {}): Promise<Array<{ key: string; issue?: string; skipped?: string }>> {
  const call = mustGetCall(callId);
  const plan = mustGetPlan(callId);
  const frames = getFrames(callId);
  const numbers = new Map<string, number>();
  const out: Array<{ key: string; issue?: string; skipped?: string }> = [];
  for (const t of plan.tasks) {
    if (!t.include) { out.push({ key: t.key, skipped: 'left out' }); continue; }
    if (t.issue_url) {
      const m = t.issue_url.match(/\/issues\/(\d+)/);
      if (m) numbers.set(t.key, Number(m[1]));
      out.push({ key: t.key, issue: t.issue_url });
      continue;
    }
    const repo = t.repo ?? opts.repo ?? (call.repos.length === 1 ? call.repos[0]! : null);
    if (!repo) { out.push({ key: t.key, skipped: 'no repository' }); continue; }
    try {
      const shots = t.frames.map((l) => frames.find((f) => f.label === l)).filter(Boolean)
        .map((f) => `- ${f!.label} (${fmtTime(f!.t)})`);
      const issue = await createIssue(repo, t.title, issueBody(t, { title: plan.title || call.title, numbers, frames: shots }));
      t.issue_url = issue.url;
      t.repo = repo;
      numbers.set(t.key, issue.number);
      savePlan(callId, plan); // saved per issue: a failure halfway keeps the ones already created
      logCall(callId, `issue for ${t.key}: ${issue.url}`);
      out.push({ key: t.key, issue: issue.url });
    } catch (e) {
      out.push({ key: t.key, skipped: (e as Error).message.slice(0, 300) });
    }
  }
  return out;
}
