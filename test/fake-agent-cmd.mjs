#!/usr/bin/env node
// A stand-in for any command-line agent (codex exec -, gemini…): reads the
// prompt on stdin and answers with JSON describing it.

let s = '';
process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => {
  const lastUser = s.split('\n').filter((l) => l.startsWith('User: ')).at(-1) ?? null;
  process.stdout.write(JSON.stringify({ length: s.length, head: s.slice(0, 120), screen: /\[screen F1: .+F1\.jpg\]/.test(s), lastUser }));
});
