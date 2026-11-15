#!/usr/bin/env node
// Set keys in ~/.open-meeting-agent/config.json (or $OMA_HOME/config.json),
// keeping the others: node scripts/set-config.mjs KEY=value [KEY=value…]
// An empty value removes the key. Used by the Makefile.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = process.env.OMA_HOME || path.join(os.homedir(), '.open-meeting-agent');
const file = path.join(home, 'config.json');
const pairs = process.argv.slice(2);
if (!pairs.length || pairs.some((p) => !/^[A-Z][A-Z0-9_]*=/.test(p))) {
  console.error('usage: node scripts/set-config.mjs KEY=value [KEY=value…]');
  process.exit(2);
}
const cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
for (const p of pairs) {
  const i = p.indexOf('=');
  const key = p.slice(0, i);
  const value = p.slice(i + 1);
  if (value) cfg[key] = value;
  else delete cfg[key];
  console.log(value ? `${key} set` : `${key} removed`);
}
mkdirSync(home, { recursive: true });
writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
