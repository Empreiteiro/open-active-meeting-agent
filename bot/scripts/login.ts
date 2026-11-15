// Interactive login that saves a Playwright storageState for the bot's own
// account. Runs on your machine with a visible browser: log in, press Enter in
// the terminal, and the JSON is written.
//
//   npx tsx scripts/login.ts --provider google --out ~/.open-meeting-agent/auth/google.json
//
// Then point OMA_BOT_AUTH_GOOGLE (or OMA_BOT_AUTH_TEAMS) at that file: the
// runner mounts it read-only and the bot joins signed in (no lobby, no name).

import { chromium } from 'patchright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline';

interface Args { provider: 'google' | 'teams'; out: string; }

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = a.indexOf(`--${name}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const provider = (get('provider') ?? 'google') as Args['provider'];
  if (provider !== 'google' && provider !== 'teams') {
    throw new Error(`--provider must be 'google' or 'teams' (got '${provider}')`);
  }
  const out = get('out');
  if (!out) throw new Error('--out <path> is required (e.g. --out ~/.open-meeting-agent/auth/google.json)');
  return { provider, out: resolve(out) };
}

const URLS: Record<Args['provider'], string> = {
  google: 'https://accounts.google.com/',
  teams: 'https://teams.microsoft.com/',
};

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a); }));
}

async function main(): Promise<void> {
  const { provider, out } = parseArgs();
  mkdirSync(dirname(out), { recursive: true });

  console.log(`\n→ Opening Chromium to sign in to ${provider.toUpperCase()}`);
  console.log(`   output: ${out}\n`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: process.env.BOT_LOCALE ?? 'en-US',
  });
  const page = await context.newPage();
  await page.goto(URLS[provider]);

  console.log('───────────────────────────────────────────────────────────');
  console.log('SIGN IN in the window with the agent\'s account:');
  console.log('  • e-mail/password; solve 2FA if asked');
  console.log('  • wait for the home page (Gmail inbox or Teams home)');
  console.log('  • then press ENTER here to save the storageState');
  console.log('───────────────────────────────────────────────────────────');

  await ask('Press ENTER when you are signed in... ');

  await context.storageState({ path: out });
  console.log(`\n✓ storageState saved to ${out}`);
  console.log('  Point open-meeting-agent at it:');
  console.log(`    OMA_BOT_AUTH_${provider.toUpperCase()}=${out}\n`);

  await browser.close();
}

main().catch((e) => {
  console.error('✗ failed:', e.message);
  process.exit(1);
});
