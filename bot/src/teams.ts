import type { Page } from 'patchright';
import { MeetingDriver, ChatConfig, firstVisible, visibleOutside, clickRobust, gotoResilient, dumpControls, admissionDeadline, pageEvidence } from './driver.js';
import { log } from './logger.js';
import { config } from './config.js';

/** Microsoft sign-in when Teams asks for an account (storageState missing/refused).
 *  Mirrors handleGoogleSignin in meet.ts. Does NOT work with 2FA/MFA — which is
 *  the default in Entra ID tenants, so the account must be dedicated, with MFA
 *  waived. Flow: email → Next → password → Sign in → "Stay signed in?".
 *  Federated accounts land on their own IdP (ADFS/Okta) and fail here — by
 *  design: a clear error beats guessing at a third-party screen. */
async function handleMicrosoftSignin(page: Page): Promise<boolean> {
  if (!config.googleEmail || !config.googlePassword) {
    log.warn('landed on Microsoft sign-in but BOT_GOOGLE_EMAIL/PASSWORD are not set');
    return false;
  }
  log.info({ url: page.url() }, 'landed on Microsoft sign-in — trying automatic login');

  const emailInput = await firstVisible(page, [
    'input[type="email"]', 'input[name="loginfmt"]',
  ], 6_000);
  if (emailInput) {
    await page.locator(emailInput).fill(config.googleEmail);
    await page.keyboard.press('Enter');
    log.info('email filled in');
    await page.waitForTimeout(2500);
  }

  // Federated account: Microsoft redirects to the customer's IdP and the
  // password field never shows up with these selectors. Fail explicitly.
  if (/adfs|okta|pingidentity|auth0/i.test(page.url())) {
    log.error({ url: page.url() }, 'federated account (external IdP) — automatic login not supported');
    return false;
  }

  const pwdInput = await firstVisible(page, [
    'input[type="password"]', 'input[name="passwd"]',
  ], 12_000);
  if (!pwdInput) {
    log.warn({ url: page.url() }, 'password field did not appear — could be MFA, a captcha, or already past it');
    return !/login\.microsoftonline\.com/i.test(page.url());
  }
  await page.locator(pwdInput).fill(config.googlePassword);
  await page.keyboard.press('Enter');
  log.info('password filled in; waiting for Microsoft to decide');

  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    await page.waitForTimeout(1000);
    // "Stay signed in?" (KMSI) — accepting keeps the cookie jar useful for the
    // storageState that gets cached, avoiding a new login on the next call.
    const kmsi = await firstVisible(page, [
      '#idSIButton9', 'input[type="submit"][value="Sim"]', 'input[type="submit"][value="Yes"]',
    ], 500);
    if (kmsi) await page.locator(kmsi).first().click().catch(() => {});

    const url = page.url();
    if (!/login\.microsoftonline\.com|login\.live\.com/i.test(url)) {
      log.info({ url }, 'login OK — left Microsoft sign-in');
      return true;
    }
    const blocker = await page.evaluate(() => {
      const t = (document.body.textContent || '').toLowerCase();
      if (t.includes('verify your identity') || t.includes('verifique sua identidade')) return 'mfa';
      if (t.includes('approve sign in') || t.includes('aprovar solicitação')) return 'mfa-push';
      if (t.includes("account or password is incorrect") || t.includes('senha incorreta')) return 'rejected';
      if (t.includes('locked') || t.includes('bloqueada')) return 'locked';
      return null;
    }).catch(() => null);
    if (blocker) {
      log.error({ blocker, url }, 'login blocked by Microsoft');
      return false;
    }
  }
  log.warn({ url: page.url() }, 'timed out waiting for Microsoft login to complete');
  return false;
}

// ⚠️ FRAGILE SELECTORS: the Teams web UI changes often. Teams has fairly
// stable data-tid attributes — we prefer those. All the Teams-specific bits live here.
const SEL = {
  useWeb: [
    'button:has-text("Continuar neste navegador")',
    'button:has-text("Continue on this browser")',
    'a:has-text("Ingressar na Web")',
    'button:has-text("Join on the web instead")',
  ],
  nameInput: [
    '[data-tid="prejoin-display-name-input"]',
    'input[placeholder*="nome" i]',
    'input[placeholder*="name" i]',
  ],
  micToggle: ['[data-tid="toggle-mute"]', 'button[aria-label*="microfone" i]'],
  camToggle: ['[data-tid="toggle-video"]', 'button[aria-label*="câmera" i]'],
  joinBtn: [
    '[data-tid="prejoin-join-button"]',
    'button:has-text("Ingressar agora")',
    'button:has-text("Join now")',
  ],
  inCall: [
    '[data-tid="hangup-button"]',
    '[data-tid="call-roster-button"]',
    'button[aria-label*="Sair" i]',
  ],
  lobby: [
    'text=/deixe você entrar/i',
    // Current pt-BR lobby text ("…deve deixar você entrar em breve" / "permitir a
    // sua entrada"). An unrecognized lobby = the bot "joins" and records silence.
    'text=/deixar você entrar/i',
    'text=/permitir (a )?sua entrada/i',
    'text=/let you in/i',
    'text=/aguardando/i',
    'text=/waiting for the host/i',
    'text=/quando a reunião começar/i',
    'text=/someone will let you in/i',
  ],
  // Screens where Teams does NOT let the guest in (organizer policy, request
  // declined, nobody answered in the lobby). Only checked during the
  // join — once in the call, chat text could match.
  joinRefused: [
    'text=/não (é|foi) possível (participar|ingressar|entrar)/i',
    'text=/não pode (participar|ingressar|entrar)/i',
    'text=/(can.?t|cannot|couldn.?t|unable to) join/i',
    'text=/anonymous users can.?t|usuários anônimos não/i',
    'text=/(negou|recusou) (a sua|sua|o seu|seu) (solicitação|pedido)/i',
    'text=/(denied|declined) your request/i',
    'text=/(acesso|entrada) (foi )?negad[oa]|denied access/i',
    'text=/ninguém (respondeu|admitiu)|no one (responded|let you in)/i',
  ],
  rosterBtn: ['[data-tid="call-roster-button"]', 'button[aria-label*="participantes" i]'],
  ended: [
    'text=/A reunião terminou/i',
    'text=/A chamada terminou/i',
    'text=/Call ended/i',
    'text=/You were removed/i',
    // pt-BR: screen shown when the host REMOVES the bot from the meeting (the case that used to hang the bot).
    'text=/Você foi removido/i',
    'text=/foi removido da reunião/i',
    'text=/Você foi desconectado/i',
    'button:has-text("Ingressar novamente")',
    'button:has-text("Voltar a ingressar")',
    'button:has-text("Reingressar")',
    'button:has-text("Rejoin")',
  ],
};

// The meeting chat (the agent acting in the meeting). Best-effort: anonymous
// guests may have no chat at all, depending on the organizer's policy.
const CHAT: ChatConfig = {
  panel: [
    '[data-tid="message-pane-list-viewport"]',
    '[data-tid="chat-pane-list"]',
    '[data-tid="chat-pane"]',
    '[role="complementary"]',
  ],
  open: [
    '[data-tid="chat-button"]',
    '#chat-button',
    'button[aria-label*="Mostrar conversa" i]',
    'button[aria-label*="Show conversation" i]',
    'button[aria-label="Chat" i]',
  ],
  input: [
    '[data-tid="ckeditor"][contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    '[aria-label*="Digite uma mensagem" i]',
    '[aria-label*="Type a message" i]',
  ],
};

export const teamsDriver: MeetingDriver = {
  provider: 'microsoft_teams',

  // Teams captions: renderer = data-tid="closed-captions-renderer";
  // each line has the author in a data-tid*="author".
  captionConfig: {
    region: [
      '[data-tid="closed-captions-renderer"]',
      '[data-cid="closed-captions-container"]',
      '[class*="closed-captions" i]',
      '[aria-label*="caption" i]',
    ],
    line: ['[data-tid*="caption" i]', '[class*="caption-item" i]', 'li', '[role="text"]'],
    speaker: ['[data-tid*="author" i]', '[class*="author" i]', '[class*="speaker" i]', 'span:first-child'],
  },

  chatConfig: CHAT,

  async join(page: Page, displayName: string): Promise<void> {
    await gotoResilient(page, process.env.JOIN_URL!);

    // Teams tries to open the desktop app; force the web version.
    const useWeb = await firstVisible(page, SEL.useWeb, 12_000);
    if (useWeb) await clickRobust(page, useWeb).catch(() => {});

    // Without storageState (or if it is refused), Teams sends us to Microsoft
    // sign-in. Only try to log in if credentials are set — otherwise go on to
    // the anonymous join, which is the historical behavior.
    if (/login\.microsoftonline\.com|login\.live\.com/i.test(page.url()) && config.googleEmail) {
      const ok = await handleMicrosoftSignin(page);
      if (!ok) throw new Error(`Microsoft sign-in failed (saved session refused and the automatic login failed) | url=${page.url()}`);
      // After login Teams reopens the pre-join; it may ask to "use the web" again.
      const useWebAgain = await firstVisible(page, SEL.useWeb, 8_000);
      if (useWebAgain) await clickRobust(page, useWebAgain).catch(() => {});
    }

    // Anonymous join asks for a name (it does not show up for a signed-in account).
    const nameSel = await firstVisible(page, SEL.nameInput, 15_000);
    if (nameSel) {
      await page.locator(nameSel).fill(displayName);
      log.info('name filled in (anonymous join)');
    }

    // Mic/cam off in the pre-join (only toggles them if they are on).
    for (const group of [SEL.micToggle, SEL.camToggle]) {
      const sel = await firstVisible(page, group, 3_000);
      if (sel) {
        const el = page.locator(sel).first();
        const pressed = await el.getAttribute('aria-pressed').catch(() => null);
        // aria-pressed="true" usually means "on" → click to turn it off
        if (pressed === 'true') await el.click().catch(() => {});
      }
    }

    const joinSel = await firstVisible(page, SEL.joinBtn, 20_000);
    if (!joinSel) throw new Error('the Teams join button was not found');
    // clickRobust: the teams.microsoft.com/meet/ pre-join puts up a
    // ui-dialog__overlay (FluentUI) that intercepts a normal click.
    await clickRobust(page, joinSel);
    log.info('clicked join; waiting for lobby/admission');

    // "Joined" does NOT depend only on finding an exact in-call selector (they
    // change and gave us false negatives: the bot was in the call but the code
    // did not recognize it). But "the join button is gone and it's not the lobby"
    // alone also lies: a refusal screen, a lobby with new text, or the guest
    // "light" experience (light-meetings) passed as "joined", the bot
    // recorded seconds of silence and the meeting ended up as "muted audio"
    // (incident 22dac6fb). So: a positive signal (in-call) joins right away;
    // a refused/ended screen fails right away, with evidence; with neither,
    // wait for CONFIRM_MS of stability before accepting (fail-open — erring
    // the other way still loses the whole meeting).
    const vis = async (sels: string[]): Promise<string | null> => {
      for (const s of sels) {
        if (await page.locator(s).first().isVisible({ timeout: 200 }).catch(() => false)) return s;
      }
      return null;
    };
    const CONFIRM_MS = 10_000;

    // Total admission window, counted from the scheduled start (the bot arrives
    // before the start time) or from now — whichever is later.
    const deadline = admissionDeadline(6 * 60_000);
    let warnedLobby = false;
    let unconfirmedSince: number | null = null;
    for (;;) {
      if (await vis(SEL.inCall)) break; // fast positive path
      const refused = (await vis(SEL.joinRefused)) ?? (await vis(SEL.ended));
      if (refused) {
        throw new Error(`Teams did not let the bot in (screen: ${refused}) | ${await pageEvidence(page)}`);
      }
      const onJoin = await vis(SEL.joinBtn);
      const onLobby = await vis(SEL.lobby);
      if (!onJoin && !onLobby) {
        // Left the pre-join and it's not the lobby: probably joined, but with no
        // positive signal. Confirm the screen holds before starting to record.
        unconfirmedSince ??= Date.now();
        if (Date.now() - unconfirmedSince >= CONFIRM_MS) {
          log.warn({ evidence: await pageEvidence(page) }, 'joined without an in-call signal — proceeding anyway (fail-open)');
          break;
        }
      } else {
        unconfirmedSince = null;
      }
      if (onLobby && !warnedLobby) {
        warnedLobby = true;
        log.warn('in the Teams LOBBY — waiting for admission (admit the bot).');
      }
      if (Date.now() > deadline) {
        const diag = await dumpControls(page);
        throw new Error(
          (warnedLobby
            ? 'nobody admitted the bot from the lobby within 6 min (use a dedicated account via BOT_AUTH_PATH to skip the lobby)'
            : 'could not confirm joining within 6 min') + ` | visible controls: ${diag}`,
        );
      }
      await page.waitForTimeout(2500);
    }
    log.info('joined the meeting (recording will start)');
  },

  async getActiveSpeaker(page: Page): Promise<string | null> {
    try {
      // Strategy 1: native captions (when turned ON via enableCaptions).
      // In Teams the renderer is `[data-tid="closed-captions-renderer"]`
      // and each line has author + text.
      const fromCaptions = await page.evaluate(() => {
        const region =
          document.querySelector('[data-tid="closed-captions-renderer"]') ||
          document.querySelector('[data-cid="closed-captions-container"]') ||
          document.querySelector('[class*="closed-captions" i]') ||
          document.querySelector('[aria-label*="caption" i]');
        if (!region) return null;
        const lines = region.querySelectorAll('[data-tid*="caption" i], [class*="caption-item" i], li, div[role="text"]');
        const last = (lines[lines.length - 1] as HTMLElement | undefined) ?? region;
        // Look for the author's name (usually in data-tid*="author"/class*="author"/an aria-label starting with the name)
        const authorEl =
          last.querySelector('[data-tid*="author" i]') ||
          last.querySelector('[class*="author" i]') ||
          last.querySelector('[class*="speaker" i]');
        const name = authorEl?.textContent?.trim();
        if (name && name.length <= 60) return name;
        // Fallback: first short span/div
        const candidates = Array.from(last.querySelectorAll('span, div'))
          .map((el) => el.textContent?.trim() ?? '')
          .filter((s) => s.length > 1 && s.length <= 40 && !/[.!?]\s*$/.test(s));
        return candidates[0] || null;
      });
      if (fromCaptions) return fromCaptions;

      // Strategy 2: older heuristics (aria-label + tiles).
      return await page.evaluate(() => {
        // 2a) aria-label that already says "<name> está falando / is speaking".
        for (const e of Array.from(document.querySelectorAll('[aria-label]'))) {
          const al = e.getAttribute('aria-label') || '';
          const m = al.match(/^(.+?)[,\s]+(está falando|is speaking|speaking)/i);
          if (m && m[1] && (e as HTMLElement).offsetParent !== null) return m[1].trim();
        }
        // 2b) participant tiles with a voice/speaking indicator.
        const tiles = Array.from(
          document.querySelectorAll(
            '[data-tid="participant-tile"],[data-cid="calling-participant-stream"],[data-tid*="participant" i],[role="listitem"]',
          ),
        );
        for (const t of tiles) {
          const speaking =
            t.querySelector('[data-tid*="voice-level" i]') ||
            t.querySelector('[class*="speaking" i]') ||
            t.querySelector('[class*="voiceLevel" i]') ||
            t.querySelector('[aria-label*="falando" i],[aria-label*="speaking" i]') ||
            (/(falando|speaking)/i.test(t.getAttribute('aria-label') || '') ? t : null);
          if (speaking) {
            const label = t.getAttribute('aria-label') || '';
            const name =
              label.replace(/[,\s]+(está falando|is speaking|speaking|falando).*/i, '').trim() ||
              t.querySelector('[data-tid*="name" i],[class*="displayName" i],[class*="name" i]')
                ?.textContent?.trim();
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
    // Try clicking the captions button (several possible selectors).
    // It used to be 1 attempt right after the join → it fired too early (the
    // button only showed up seconds later) or captions were already ON. Now: wait
    // for the UI to settle, check if it's already ON, and try up to 3× 2.5s apart.
    const selectors = [
      '[data-tid="closed-captions-toggle-button"]',
      '[data-tid="closed-captions-button"]',
      'button[id="closed-captions-button"]',
      'button[name*="caption" i]',
      'button[aria-label*="caption" i]',
      'button[aria-label*="legenda" i]',
    ];
    const regionPresent = (): Promise<boolean> =>
      page.evaluate(() => {
        return !!(
          document.querySelector('[data-tid="closed-captions-renderer"]') ||
          document.querySelector('[data-cid="closed-captions-container"]') ||
          document.querySelector('[class*="closed-captions" i]')
        );
      });
    try {
      // 1) Wait for the call UI to settle (Teams is slower than Meet).
      await page.waitForTimeout(2000);
      // 2) Already on?
      if (await regionPresent()) return true;
      // 3) Up to 3 attempts 2.5s apart — ~9.5s in total.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        for (const sel of selectors) {
          const btn = await page.$(sel);
          if (btn) {
            await btn.click({ timeout: 1500 }).catch(() => {});
            break;
          }
        }
        await page.waitForTimeout(2500);
        if (await regionPresent()) return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  async disableIncomingVideo(page: Page): Promise<boolean> {
    // Turns off INCOMING video: Chromium stops decoding the participants' tiles
    // (the VM's biggest CPU consumer) → frees CPU for PulseAudio/
    // ffmpeg and avoids choppy audio. Best-effort, multi-language (pt-BR/en); the
    // audio is NOT affected (only received video). Looks for the item by aria-label/
    // text — directly and, if not found, inside the "Mais ações" menu.
    const RX = 'turn off incoming video|incoming video|stop incoming|receiv(ed|ing) video|'
      + 'v[ií]deo recebido|v[ií]deo de entrada|desativar v[ií]deo recebido|desligar v[ií]deo recebido';
    const clickMatch = (): Promise<boolean> =>
      page.evaluate((rxSrc) => {
        const rx = new RegExp(rxSrc, 'i');
        const nodes = Array.from(document.querySelectorAll(
          'button,[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[data-tid],li,div[role="button"]',
        ));
        for (const el of nodes) {
          const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
          if (rx.test(label)) { (el as HTMLElement).click(); return true; }
        }
        return false;
      }, RX);
    // Plan C (UI-independent): pause/disable the remote video TRACKS
    // directly in WebRTC/the DOM. Works even in anonymous Teams (slim UI, no menu).
    // Runs a few times because tiles show up over time.
    const killRemoteVideoTracks = (): Promise<number> =>
      page.evaluate(() => {
        let n = 0;
        for (const v of Array.from(document.querySelectorAll('video'))) {
          const ve = v as HTMLVideoElement;
          const s = ve.srcObject as MediaStream | null;
          if (s && typeof s.getVideoTracks === 'function') {
            for (const t of s.getVideoTracks()) { if (t.enabled) { t.enabled = false; n += 1; } }
          }
          try { ve.pause(); } catch { /* ignore */ }
        }
        return n;
      });
    try {
      await page.waitForTimeout(3000); // let the control bar show up
      if (await clickMatch()) { log.info('incoming video turned off (direct)'); return true; }
      // The received-video toggle usually lives in the "Exibição"/"View" menu (or
      // "Mais"/"More"). Open each one and try to find the item.
      for (const sel of ['button[aria-label*="Exibição" i]', 'button[aria-label*="View" i]',
        '[data-tid="more-button"]', '[data-tid="callingButtons-showMoreBtn"]',
        'button[aria-label*="More" i]', 'button[aria-label*="Mais" i]']) {
        const btn = await page.$(sel);
        if (!btn) continue;
        await btn.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(900);
        if (await clickMatch()) { log.info({ via: sel }, 'incoming video turned off (menu)'); return true; }
        await page.keyboard.press('Escape').catch(() => {}); // close it and try the next one
      }

      // WebRTC fallback: disable the remote video tracks. Tiles can take a
      // while to show up, so keep trying for ~30s (until at least one is caught).
      let killed = 0;
      for (let i = 0; i < 12 && killed === 0; i++) { killed += await killRemoteVideoTracks(); if (killed === 0) await page.waitForTimeout(2500); }
      if (killed > 0) { log.info({ killed }, 'incoming video turned off (WebRTC tracks)'); return true; }

      // Found nothing: DUMP the visible controls/menus so we can see the real
      // labels and adjust the selectors (anonymous Teams tends to be slim).
      const controls = await dumpControls(page);
      const menuItems = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"],[role="menuitemcheckbox"]'))
        .map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 40)).filter(Boolean).slice(0, 20).join(' | '));
      log.warn({ controls, menuItems }, 'disableIncomingVideo: no video control found (evidence for tuning)');
      return false;
    } catch {
      return false;
    }
  },

  async participantCount(page: Page): Promise<number> {
    // PRIMARY SOURCE: the toolbar's "Pessoas" button carries the REAL count (badge),
    // e.g. "2 Pessoas". It is reliable; counting video tiles is NOT (when someone
    // turns their camera off the tile disappears and the bot thought it was alone →
    // left early). Fallback: union of tile/avatar selectors. 0 = nothing matched.
    try {
      return await page.evaluate(() => {
        // 1) Pessoas/People/Participantes button → pull the number from its text/badge.
        const btns = Array.from(document.querySelectorAll('button,[role="button"],[data-tid*="people" i],[data-tid*="roster" i]'));
        const peopleBtn = btns.find((e) => /^(pessoas|people|participants?|participantes)$/i.test((e.getAttribute('aria-label') || '').trim()));
        if (peopleBtn) {
          const mm = (peopleBtn.textContent || '').match(/(\d+)/);
          if (mm && mm[1]) return parseInt(mm[1], 10);
        }
        // Also try an aria-label with the number in it ("2 Pessoas").
        for (const e of btns) {
          const lm = (e.getAttribute('aria-label') || '').match(/(\d+)\s*(pessoas?|people|participants?|participantes)/i);
          if (lm && lm[1]) return parseInt(lm[1], 10);
        }
        // 2) Fallback: tiles/avatars (may undercount when cameras are off).
        const set = new Set<Element>();
        for (const sel of [
          '[data-tid="participant-tile"]',
          '[data-cid="calling-participant-stream"]',
          '[data-tid="participant-avatar"]',
          '[data-cid="roster-participant"]',
          '[role="listitem"][data-tid*="participant" i]',
        ]) {
          document.querySelectorAll(sel).forEach((el) => set.add(el));
        }
        return set.size;
      });
    } catch {
      return 0;
    }
  },

  async hasEnded(page: Page): Promise<boolean> {
    if (page.isClosed()) return true;
    // Text in the captions or the chat is what people said, not Teams' end screen.
    const sel = await visibleOutside(page, SEL.ended, [...teamsDriver.captionConfig.region, ...CHAT.panel]);
    return sel !== null;
  },

  async leave(page: Page): Promise<void> {
    const sel = await firstVisible(page, ['[data-tid="hangup-button"]'], 1_500);
    if (sel) await page.locator(sel).first().click().catch(() => {});
  },
};
