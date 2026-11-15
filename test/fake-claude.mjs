#!/usr/bin/env node
// A stand-in for Claude Code's CLI in the tests: `claude -p` with stream-json
// in and out, like the real one.
//   - as the model (--tools ""): answers with JSON describing what it got;
//   - as the UI's chat: streams its answer; a message with "write" asks for
//     permission to use Write (control_request can_use_tool) and waits;
//     --resume shows in the answer.
//   env FAKE_CLAUDE_LOG  a file: one JSON line per run with its arguments

import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
if (has('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);

const session = val('--resume') ?? `sess-${Math.random().toString(16).slice(2, 10)}`;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const pending = new Map();
let started = false;
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.type === 'control_response') {
      const r = pending.get(m.response.request_id);
      pending.delete(m.response.request_id);
      r?.(m.response.response);
    } else if (m.type === 'user' && !started) {
      started = true;
      turn(m.message.content);
    }
  }
});
process.stdin.on('end', () => process.exit(0));

function say(text) {
  if (has('--include-partial-messages')) {
    for (const piece of text.match(/[\s\S]{1,6}/g) ?? []) out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

async function turn(content) {
  out({ type: 'system', subtype: 'init', session_id: session, model: val('--model') ?? 'fake-model', mcp_servers: [], tools: [] });
  const text = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

  if (val('--tools') === '') { // used as a model
    const images = Array.isArray(content) ? content.filter((b) => b.type === 'image' && b.source?.data).length : 0;
    const reply = JSON.stringify({ system: val('--system-prompt') ?? null, images, text, strict: has('--strict-mcp-config'), persist: !has('--no-session-persistence') });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: session, usage: { input_tokens: 5, output_tokens: 7 } });
    return;
  }

  if (/write/i.test(text)) {
    say('Writing it. ');
    const id = 'toolu_1';
    const input = { file_path: '/tmp/notes.txt', content: 'hi' };
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Write', input }] } });
    const decision = await new Promise((resolve) => {
      pending.set('req-1', resolve);
      out({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Write', input, tool_use_id: id } });
    });
    const ok = decision.behavior === 'allow';
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: ok ? 'written' : decision.message, is_error: !ok }] } });
    say(ok ? 'Done.' : 'Refused.');
  } else {
    say(`${has('--resume') ? `resumed ${session}: ` : ''}You said: ${text}`);
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: '(final)', session_id: session });
}
