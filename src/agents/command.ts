// Any other local agent or model, as a command: the prompt goes in on stdin and
// the answer comes out on stdout (`codex exec -`, `gemini`, `ollama run llama3`…).
// Used by the model provider "command" and the UI's chat with OMA_UI_AGENT=command.

import { spawn } from 'node:child_process';

export interface CommandRun { result: Promise<string>; stop(): void }

export function runCommand(command: string, prompt: string, o: { cwd: string; timeoutMs?: number; onText?: (s: string) => void }): CommandRun {
  const p = spawn(command, { cwd: o.cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let stopped = false;
  const result = new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = o.timeoutMs ? setTimeout(() => { p.kill('SIGTERM'); reject(new Error(`\`${command}\` took more than ${Math.round(o.timeoutMs! / 1000)} s`)); }, o.timeoutMs) : null;
    p.stdout.on('data', (d: Buffer) => { const s = d.toString('utf8'); out += s; o.onText?.(s); });
    p.stderr.on('data', (d: Buffer) => { err = (err + d.toString('utf8')).slice(-4000); });
    p.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (stopped) reject(new Error('stopped'));
      else if (code === 0) resolve(out);
      else reject(new Error(`\`${command}\` failed (exit ${code})${err.trim() ? `: ${err.trim().split('\n').slice(-3).join(' ')}` : ''}`));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(prompt);
  });
  return { result, stop: () => { stopped = true; p.kill('SIGTERM'); } };
}
