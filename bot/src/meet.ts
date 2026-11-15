import type { Page } from 'patchright';
import { MeetingDriver, firstVisible, clickRobust, gotoResilient, dumpControls, admissionDeadline } from './driver.js';
import { log } from './logger.js';
import { config } from './config.js';

/** Login fallback for when Google rejects the storageState (typical on a
 *  first automated session / Workspace accounts that ask for
 *  re-confirmation). Does NOT work with 2FA.
 *
 *  3 possible screens in the Google flow:
 *   1. /v3/signin/identifier      → email input + Next
 *   2. /v3/signin/confirmidentifier → shows the email + a "Continue" button
 *                                      (no input — passive flow)
 *   3. /v3/signin/challenge/pwd   → password input + Next
 */
async function handleGoogleSignin(page: Page): Promise<boolean> {
  if (!config.googleEmail || !config.googlePassword) {
    log.warn('landed on /signin but BOT_GOOGLE_EMAIL/PASSWORD are not set');
    return false;
  }
  log.info({ url: page.url() }, 'landed on /signin — trying automatic login');

  // Step 1: email input (if this is the identifier flow).
  const emailInput = await firstVisible(page, [
    'input[type="email"]',
    'input[name="identifier"]',
  ], 4_000);
  if (emailInput) {
    await page.locator(emailInput).fill(config.googleEmail);
    await page.keyboard.press('Enter');
    log.info('email filled in');
    await page.waitForTimeout(2000);
  } else if (page.url().includes('confirmidentifier')) {
    // Passive flow: the screen shows "Continue as notetaker@..." instead
    // of an input. Look for the confirm button.
    const continueBtn = await firstVisible(page, [
      'button:has-text("Continue")',
      'button:has-text("Continuar")',
      'button:has-text("Next")',
      'button:has-text("Próximo")',
      // Last resort: the form's primary button is usually the only <button>
      'div[role="button"]:has-text("Continue")',
      'div[role="button"]:has-text("Continuar")',
    ], 4_000);
    if (continueBtn) {
      await page.locator(continueBtn).first().click();
      log.info({ continueBtn }, 'clicked Continue (confirmidentifier)');
      await page.waitForTimeout(2000);
    } else {
      log.warn('confirmidentifier with no identifiable Continue button');
    }
  }

  // Step 2: password input + Enter
  const pwdInput = await firstVisible(page, [
    'input[type="password"]',
    'input[name="Passwd"]',
  ], 12_000);
  if (!pwdInput) {
    log.warn({ url: page.url() }, 'password field did not appear — may be 2FA, a captcha, or already past it');
    return !page.url().includes('accounts.google.com');
  }
  await page.locator(pwdInput).fill(config.googlePassword);
  await page.keyboard.press('Enter');
  log.info('password filled in; waiting for Google to decide');

  // Wait to leave accounts.google.com (should redirect to continue=)
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    await page.waitForTimeout(1000);
    const url = page.url();
    if (!url.includes('accounts.google.com')) {
      log.info({ url }, 'login OK — left accounts.google.com');
      return true;
    }
    // Detect 2FA / captcha / device-confirm to fail clearly
    const blocker = await page.evaluate(() => {
      const t = (document.body.textContent || '').toLowerCase();
      if (t.includes('2-step') || t.includes('verificação em duas etapas')) return '2fa';
      if (t.includes('verify it') || t.includes('confirme') && t.includes('dispositivo')) return 'device-confirm';
      if (t.includes('captcha') || t.includes('robô')) return 'captcha';
      if (t.includes("couldn't sign you in") || t.includes('não foi possível')) return 'rejected';
      return null;
    }).catch(() => null);
    if (blocker) {
      log.error({ blocker, url }, 'login blocked by Google');
      return false;
    }
  }
  log.warn({ url: page.url() }, 'timed out waiting for login to complete');
  return false;
}

export { handleGoogleSignin };

// ⚠️ FRAGILE SELECTORS: Google changes the Meet UI without notice. Keep
// multiple fallbacks and test periodically. Everything Meet-specific lives here.
const SEL = {
  nameInput: [
    'input[aria-label="Seu nome"]',
    'input[aria-label="Your name"]',
    'input[placeholder="Seu nome"]',
  ],
  micOff: [
    '[aria-label*="Desativar microfone" i]',
    '[aria-label*="Turn off microphone" i]',
    '[data-is-muted="false"][aria-label*="microfone" i]',
  ],
  camOff: [
    '[aria-label*="Desativar câmera" i]',
    '[aria-label*="Turn off camera" i]',
  ],
  joinBtn: [
    // Signed-in, invited account: "Participar agora" / "Join now"
    'button:has-text("Participar agora")',
    'button:has-text("Join now")',
    // No explicit invite, or anonymous: "Pedir para participar"
    'button:has-text("Pedir para participar")',
    'button:has-text("Pedir para entrar")',
    'button:has-text("Solicitar para participar")',
    'button:has-text("Ask to join")',
    'button:has-text("Request to join")',
    // Generic aria-label fallback (covers future variations)
    'button[aria-label*="Participar agora" i]',
    'button[aria-label*="Pedir para participar" i]',
    'button[aria-label*="Join now" i]',
    'button[aria-label*="Ask to join" i]',
    // Last resort: span inside the button (Material UI sometimes wraps it)
    'button:has(span:has-text("Participar"))',
    'button:has(span:has-text("Join"))',
  ],
  // "You're already in this meeting" screen (the bot's account is still in the call —
  // a ghost session from a previous instance / duplicate dispatch). Meet
  // swaps "Participar agora" for "Switch here"/"Alternar aqui". Taking over the
  // session on THIS device (clicking it) recovers instead of failing the join.
  switchHere: [
    'button:has-text("Switch here")',
    'button:has-text("Alternar aqui")',
    'button:has-text("Mudar para cá")',
    '[role="button"][aria-label*="Switch here" i]',
    '[aria-label*="Alternar aqui" i]',
  ],
  inCall: [
    '[aria-label*="Sair da chamada" i]',
    '[aria-label*="Leave call" i]',
    'button[aria-label*="chamada" i]',
  ],
  peopleBtn: [
    'button[aria-label*="Mostrar todos" i]',
    'button[aria-label*="participantes" i]',
    'button[aria-label*="people" i]',
  ],
  ended: [
    'text=/A chamada terminou/i',
    'text=/You left the meeting/i',
    'text=/removido da reunião/i',
    'button:has-text("Voltar à tela inicial")',
    'button:has-text("Return to home screen")',
  ],
};

export const meetDriver: MeetingDriver = {
  provider: 'google_meet',

  // Meet captions: the container usually has aria-label "Legendas"/
  // "Captions"; each block uses jsname="dsyhDe" and has the speaker's name
  // in a descendant. Several fallbacks because the markup changes.
  captionConfig: {
    region: [
      '[role="region"][aria-label*="legenda" i]',
      '[role="region"][aria-label*="caption" i]',
      '[role="region"][aria-label*="subtítulo" i]',
      'div[jsname="YSxPC"]',
      'div[jsname="r4nke"]',
    ],
    line: ['[jsname="dsyhDe"]', '[class*="caption" i]', '[class*="Caption"]'],
    speaker: ['[class*="name" i]', '[class*="Name"]', 'span:first-child', 'div:first-child'],
  },

  async join(page: Page, displayName: string): Promise<void> {
    await page.goto('about:blank');
    await gotoResilient(page, process.env.JOIN_URL!);

    // Did Google redirect to signin? (storageState rejected by
    // fingerprint, Workspace asking for re-confirmation, etc.) — try to
    // log in with the email/password from env and go back to Meet.
    await page.waitForTimeout(1500);
    if (page.url().includes('accounts.google.com')) {
      const ok = await handleGoogleSignin(page);
      if (!ok) throw new Error(`Google sign-in failed (saved session refused and the automatic login failed) | url=${page.url()}`);
      // After login, Google should redirect to continue= (Meet);
      // if it didn't, force it.
      if (!page.url().includes('meet.google.com')) {
        await gotoResilient(page, process.env.JOIN_URL!);
      }
    }

    // An anonymous join asks for a name; with a signed-in account the field doesn't appear.
    const nameSel = await firstVisible(page, SEL.nameInput, 8_000);
    if (nameSel) {
      await page.locator(nameSel).fill(displayName);
      log.info('name filled in (anonymous join)');
    }

    // Mic and camera OFF before joining (Meet's shortcuts are more stable
    // than the buttons: Ctrl+D = mic, Ctrl+E = camera).
    await page.keyboard.press('Control+d').catch(() => {});
    await page.keyboard.press('Control+e').catch(() => {});

    let joinSel = await firstVisible(page, SEL.joinBtn, 30_000);
    // No "Participar" button? It may be the "you're already in the meeting" screen
    // (a ghost session of the same account — previous instance / duplicate
    // dispatch). Take over the session via "Switch here" and carry on; otherwise fail
    // with a dump of the visible controls (to fix the selector with real data).
    if (!joinSel) {
      const switchSel = await firstVisible(page, SEL.switchHere, 3_000);
      if (switchSel) {
        log.warn({ switchSel }, 'account was already in the meeting (ghost session) — taking over via "Switch here"');
        await clickRobust(page, switchSel);
        joinSel = await firstVisible(page, SEL.joinBtn, 8_000); // "Participar" may reappear
      }
    }
    if (joinSel) {
      await page.locator(joinSel).first().click();
      log.info({ joinSel }, 'clicked join; waiting for admission/lobby');
    } else if (!(await firstVisible(page, SEL.inCall, 2_000))) {
      const diag = await dumpControls(page);
      throw new Error(
        `Meet join button not found | url=${page.url()} | visible controls: ${diag}`,
      );
    }

    // May land on "Pedindo para entrar" — wait until actually in the call. The
    // deadline counts from the scheduled start (the bot arrives early) or from now.
    const inCall = await firstVisible(page, SEL.inCall, admissionDeadline(config.joinTimeoutMs) - Date.now());
    if (!inCall) {
      const diag = await dumpControls(page);
      throw new Error(`did not get into the call (not admitted from the lobby?) | visible controls: ${diag}`);
    }
    log.info('joined the meeting');
  },

  async getActiveSpeaker(page: Page): Promise<string | null> {
    // Strategy 1 (preferred): read the LAST block of the native captions
    // container. Once the bot calls enableCaptions() at the start,
    // Meet renders each utterance as a `<div jsname="dsyhDe">`
    // with 2 spans (speaker name + text). That is the ground-truth signal
    // — Meet does the diarization itself.
    //
    // Strategy 2 (fallback): the old "tile with a speaking indicator"
    // heuristic. Fragile, but better than nothing if captions
    // are off.
    try {
      const fromCaptions = await page.evaluate(() => {
        const region =
          document.querySelector('[role="region"][aria-label*="legenda" i]') ||
          document.querySelector('[role="region"][aria-label*="caption" i]') ||
          document.querySelector('[role="region"][aria-label*="subtítulo" i]') ||
          document.querySelector('div[jsname="YSxPC"]') ||
          document.querySelector('div[jsname="r4nke"]');
        if (!region) return null;
        const blocks = region.querySelectorAll(
          '[jsname="dsyhDe"], [class*="caption" i], [class*="Caption"]',
        );
        const last = (blocks[blocks.length - 1] as HTMLElement | undefined) ?? region;
        // Look for a short descendant that looks like a name (no trailing punctuation, no long numbers)
        const candidates = Array.from(last.querySelectorAll('span, div'))
          .map((el) => el.textContent?.trim() ?? '')
          .filter((s) => s.length > 1 && s.length <= 40 && !/[.!?]\s*$/.test(s) && !/^\d+$/.test(s));
        return candidates[0] || null;
      });
      if (fromCaptions) return fromCaptions;

      // Fallback: tile heuristic.
      return await page.evaluate(() => {
        const tiles = Array.from(document.querySelectorAll('[data-participant-id]'));
        for (const t of tiles) {
          const speaking =
            t.querySelector('[class*="speaking" i]') ||
            t.querySelector('[aria-label*="falando" i]') ||
            t.querySelector('[aria-label*="speaking" i]') ||
            t.querySelector('[jsname][style*="scale"]');
          if (speaking) {
            const nameEl = t.querySelector('[data-self-name], [class*="name" i]');
            const name = nameEl?.textContent?.trim();
            if (name) return name;
          }
        }
        return null;
      });
    } catch {
      return null;
    }
  },

  async enableCaptions(page: Page): Promise<boolean> {
    // The 'c' key turns captions on in Meet — more stable than clicking the
    // button (which lives in the nested "Mais opções" menu). Confirms
    // by checking whether the container appeared.
    //
    // It used to be 1 attempt right after the join → it fired too early
    // (the call UI hadn't rendered the main panel yet,
    // or focus was on the wrong element). Now: wait for the UI to settle and
    // try 3× with 2.5s in between. Focus the body before each press
    // so the key lands where Meet listens for the shortcut.
    const regionPresent = (): Promise<boolean> =>
      page.evaluate(() => {
        return !!(
          document.querySelector('[role="region"][aria-label*="legenda" i]') ||
          document.querySelector('[role="region"][aria-label*="caption" i]') ||
          document.querySelector('[role="region"][aria-label*="subtítulo" i]') ||
          document.querySelector('div[jsname="YSxPC"]') ||
          document.querySelector('div[jsname="r4nke"]')
        );
      });
    try {
      // 1) Wait for the call UI to settle (controls rendered).
      await page.waitForTimeout(1500);
      // 2) Already on? (e.g. tenant default is ON, no toggle needed)
      if (await regionPresent()) return true;
      // 3) Up to 3 attempts with 2.5s in between — ~9.5s total.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await page.evaluate(() => (document.body as HTMLElement).focus());
        } catch { /* best-effort focus */ }
        await page.keyboard.press('c');
        await page.waitForTimeout(2500);
        if (await regionPresent()) return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  async participantCount(page: Page): Promise<number> {
    // Same logic as Teams: returns the real count. 0 = the selector
    // matched nothing (DOM changed, UI transition). index.ts decides.
    try {
      return await page.evaluate(() => {
        const tiles = document.querySelectorAll('[data-participant-id]');
        return tiles.length;
      });
    } catch {
      return 0;
    }
  },

  async hasEnded(page: Page): Promise<boolean> {
    if (page.isClosed()) return true;
    const sel = await firstVisible(page, SEL.ended, 500);
    return sel !== null;
  },

  async leave(page: Page): Promise<void> {
    const sel = await firstVisible(page, SEL.inCall, 1_500);
    if (sel) await page.locator(sel).first().click().catch(() => {});
  },
};
