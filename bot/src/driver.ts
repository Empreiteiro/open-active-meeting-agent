import type { Page } from 'patchright';
import { config } from './config.js';

/**
 * Native caption selectors, declared per provider. The
 * SpeakerTracker uses them to install a MutationObserver and capture
 * who-spoke-when straight from the captions DOM — no blind polling.
 *   region:  captions container (tries each one, in order)
 *   line:    each speech block/line inside the container
 *   speaker: inside a line, the element holding the speaker's NAME
 */
export interface CaptionConfig {
  region: string[];
  line: string[];
  speaker: string[];
}

/**
 * Common contract between Google Meet and Teams. All the selector
 * fragility is isolated in the implementations (meet.ts / teams.ts) —
 * when the provider's UI changes, that is where you edit, nowhere else.
 */
export interface MeetingDriver {
  readonly provider: 'google_meet' | 'microsoft_teams';

  /** Native caption selectors (for the SpeakerTracker). */
  readonly captionConfig: CaptionConfig;

  /** Navigates, turns mic/cam off and joins. Resolves once it IS in the call. */
  join(page: Page, displayName: string): Promise<void>;

  /** Name of the participant speaking now, or null if undetermined. */
  getActiveSpeaker(page: Page): Promise<string | null>;

  /** Turns native captions on (best-effort). When ON, the DOM exposes
   *  a block with {speaker name} + text — the tracker's source of truth. */
  enableCaptions(page: Page): Promise<boolean>;

  /** Turns INCOMING video off (best-effort, optional). An audio notetaker
   *  doesn't need to see the tiles; decoding them saturates the VM's CPU and
   *  chops the audio. Turning it off frees CPU for PulseAudio/ffmpeg. Returns true if it did. */
  disableIncomingVideo?(page: Page): Promise<boolean>;

  /** Number of participants (bot included). Used to detect being "alone". */
  participantCount(page: Page): Promise<number>;

  /** True if the meeting has ended / the bot was removed. */
  hasEnded(page: Page): Promise<boolean>;

  /** Leaves the call cleanly (best-effort). */
  leave(page: Page): Promise<void>;
}

/** Tries several selectors in order; returns the first one that shows up. */
export async function firstVisible(
  page: Page,
  selectors: string[],
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 250 }).catch(() => false)) return sel;
      } catch {
        /* try the next one */
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

/**
 * Deadline for confirming entry into the call (lobby admission): `waitMs` counted
 * from the meeting's scheduled START or from now — whichever is later. The orchestrator
 * dispatches the bot minutes before the start time (DISPATCH_LEAD_SECONDS) and, without an
 * invited account, it lands on "ask to join" in a still-empty room: counting
 * the timeout from the click would make the bot give up before the host arrives to admit it.
 * Without SCHEDULED_START (or if it has passed) this is the old behavior: now+waitMs.
 */
export function admissionDeadline(waitMs: number): number {
  return Math.max(Date.now(), config.scheduledStartMs ?? 0) + waitMs;
}

/**
 * Resilient click. Teams/Meet throw up modals (FluentUI ui-dialog__overlay,
 * consent, "use o app?") that intercept the pointer even when the button is
 * visible. Strategy: normal click → dismiss overlays (Esc + common
 * buttons) and retry → finally click via the DOM (skips hit-testing).
 */
export async function clickRobust(page: Page, selector: string): Promise<void> {
  const el = page.locator(selector).first();
  try {
    await el.click({ timeout: 8000 });
    return;
  } catch {
    /* an overlay intercepted it — on to plan B */
  }
  // Dismiss common modals (pt/en), without killing the pre-join itself.
  await page.keyboard.press('Escape').catch(() => {});
  for (const t of [
    'Entendi', 'OK', 'Got it', 'Aceitar todos', 'Accept all', 'Permitir',
    'Continuar', 'Continue', 'Ignorar', 'Dismiss', 'Fechar', 'Close',
  ]) {
    const b = page.locator(`button:has-text("${t}")`).first();
    if (await b.isVisible({ timeout: 200 }).catch(() => false)) {
      await b.click({ timeout: 1500 }).catch(() => {});
    }
  }
  try {
    await el.click({ timeout: 5000 });
    return;
  } catch {
    /* still intercepted — plan C: click via the DOM */
  }
  // Fire the click directly on the element (bypasses overlay/pointer-events).
  const ok = await el
    .evaluate((node) => {
      (node as HTMLElement).click();
      return true;
    })
    .catch(() => false);
  if (!ok) throw new Error(`clickRobust: could not click ${selector}`);
}

/**
 * (Short) list of the visible controls on the page. Used when join
 * detection fails, to fix selectors WITH evidence instead of guessing.
 */
export async function dumpControls(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const out: string[] = [];
      const els = Array.from(
        document.querySelectorAll('button,[role="button"],[data-tid]'),
      ).slice(0, 40);
      for (const e of els) {
        const he = e as HTMLElement;
        if (he.offsetParent === null) continue; // invisible
        const tid = he.getAttribute('data-tid');
        const al = he.getAttribute('aria-label');
        const tx = (he.textContent || '').trim().slice(0, 24);
        const tag = `${tid ? `tid=${tid}` : ''}${al ? ` al="${al}"` : ''}${tx ? ` "${tx}"` : ''}`.trim();
        if (tag) out.push(tag);
      }
      return out.slice(0, 25).join(' | ') || '(no visible controls)';
    });
  } catch (e) {
    return `(dumpControls failed: ${(e as Error).message})`;
  }
}

/**
 * Short snapshot of the current screen: URL (without the query — the Teams link carries a
 * password and tenant/user ids), the start of the visible text, and the controls. Goes with
 * markFailed and the handback, which end up in the orchestrator's logs: the bot's logs
 * die with the Fly Machine, and without this there's no telling which screen the bot saw.
 */
export async function pageEvidence(page: Page): Promise<string> {
  if (page.isClosed()) return 'page closed';
  let url = page.url();
  try {
    const u = new URL(url);
    url = `${u.origin}${u.pathname}`;
  } catch {
    /* keep it as is */
  }
  const text = await page
    .evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240))
    .catch(() => '');
  return `url=${url} | text="${text}" | controls: ${await dumpControls(page)}`;
}

/**
 * Evidence from the participants/roster DOM — logged once on join.
 * Without it we'd be guessing the "who's speaking" selector blindly; with
 * a dump from a real call, getActiveSpeaker can be made accurate.
 */
export async function dumpRoster(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const sels = [
        '[data-tid="participant-tile"]', '[data-cid="calling-participant-stream"]',
        '[data-tid*="participant" i]', '[role="listitem"]', '[aria-label*="falando" i]',
        '[aria-label*="speaking" i]', '[class*="speaking" i]', '[class*="voiceLevel" i]',
      ];
      const out: string[] = [];
      for (const s of sels) {
        const els = Array.from(document.querySelectorAll(s)).slice(0, 6);
        for (const e of els) {
          const he = e as HTMLElement;
          if (he.offsetParent === null) continue;
          out.push(
            `${s} :: tid=${he.getAttribute('data-tid') || '-'} al="${(he.getAttribute('aria-label') || '').slice(0, 40)}" cls="${he.className.toString().slice(0, 60)}" tx="${(he.textContent || '').trim().slice(0, 30)}"`,
          );
        }
      }
      return out.slice(0, 20).join(' || ') || '(roster: nothing matched — selectors need review)';
    });
  } catch (e) {
    return `(dumpRoster failed: ${(e as Error).message})`;
  }
}

/**
 * Resilient page.goto. At container startup the network is still
 * "settling" → transient net::ERR_NETWORK_CHANGED / connection reset /
 * timeout errors. Retries a few times with backoff before giving up.
 */
export async function gotoResilient(page: Page, url: string): Promise<void> {
  const transient = /ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|Timeout|ERR_NETWORK_IO_SUSPENDED/i;
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      return;
    } catch (e) {
      last = e;
      const msg = (e as Error).message;
      if (!transient.test(msg)) throw e; // non-transient error: fail right away
      await page.waitForTimeout(2000 * (i + 1));
    }
  }
  throw new Error(`could not open the meeting page after retries: ${(last as Error)?.message}`);
}
