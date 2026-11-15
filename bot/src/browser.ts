import { chromium, type Browser, type BrowserContext } from 'patchright';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { log } from './logger.js';

// The storageState type newContext accepts: a file path (string) or the
// {cookies, origins} object. Derived from patchright's own options.
type StorageState = NonNullable<Parameters<Browser['newContext']>[0]>['storageState'];

/**
 * Starts Chromium inside Xvfb with its audio going to the PulseAudio sink.
 *
 * - headless:false + DISPLAY=:99 → Chromium runs in Xvfb and PLAYS audio
 *   (pure headless has no audio pipeline).
 * - --use-fake-ui-for-media-stream → accepts the camera/mic prompt by itself
 *   (we join fully muted, but the prompt still shows up).
 * - storageState opcional → entra autenticado como a conta dedicada do bot.
 */
export async function launchBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({
    headless: false,
    // CRITICAL for partial saves: by default Playwright installs its own
    // SIGINT/SIGTERM/SIGHUP handlers that CLOSE the browser and call
    // process.exit(130) right away. That killed our signal handler in the
    // middle of uploading the partial recording (Fly sends SIGINT when it stops
    // the Machine / cuts the trial). With these off, index.ts handles the
    // signal (finishes the recording + does the handback before exiting).
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      '--window-size=1280,720',
    ],
  });

  const storageState = await maybeLoadAuthState();

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: config.locale,
    timezoneId: config.timezone,
    permissions: ['microphone', 'camera'],
    storageState: storageState ?? undefined,
  });

  return { browser, context };
}

/**
 * storageState (Playwright) of a logged-in account for the bot (BOT_AUTH_PATH,
 * mounted read-only by the runner). Generate it once with
 *   npx tsx scripts/login.ts --provider google --out ~/.open-meeting-agent/auth/google.json
 * Without it the bot joins as a guest and someone in the meeting admits it.
 */
async function maybeLoadAuthState(): Promise<StorageState | undefined> {
  if (config.authPath) {
    if (existsSync(config.authPath)) {
      log.info({ path: config.authPath }, 'auth state loaded');
      return config.authPath;
    }
    log.error({ path: config.authPath }, 'BOT_AUTH_PATH does not exist — joining as a guest');
  }
  return undefined;
}
