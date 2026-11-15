import type { Page } from 'patchright';
import type { MeetingDriver } from './driver.js';
import type { Recorder } from './recorder.js';
import { config } from './config.js';
import { log } from './logger.js';

/**
 * Builds the "who-spoke-when" timeline to line up with the audio in
 * Whisper. Two strategies, in order of preference:
 *
 *  1. MutationObserver on the NATIVE CAPTIONS (preferred). When the bot
 *     turns captions on, each caption block comes with the speaker's NAME.
 *     We observe the DOM and capture every speaker transition — without
 *     losing events (polling missed short utterances between ticks).
 *
 *  2. Fallback: polling getActiveSpeaker() — the old heuristic, only
 *     used when captions aren't available (or were turned off
 *     mid-meeting and the observer stopped receiving signals).
 *
 * Emits the format transcribe.ts already consumes as `transcript_native`:
 *   { transcriptEntries: [{ participant:{displayName}, startTime, endTime }] }
 *
 * Hardening against silent failure:
 *  - start(captionsOn): if enableCaptions reported false, it does NOT even try the
 *    observer — it goes straight to polling. We used to install the observer
 *    against a nonexistent region and end up with an empty timeline.
 *  - installCaptionObserver runs a SELF-TEST: it only reports success if the
 *    captions region actually exists in the DOM at that moment. Otherwise, false.
 *  - HEALTH-CHECK: every 30s, if the observer is running but
 *    `observerHits == 0` for more than 60s, assume something broke and ENABLE
 *    polling as a contingency. The observer keeps running — if it starts
 *    working again, it wins (no duplicate turns for the same speaker).
 */

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_GRACE_MS = 60_000; // minimum wait before treating the observer as "dead"

export class SpeakerTracker {
  private entries: Array<{ speaker: string; start: number; end: number }> = [];
  private current: { speaker: string; start: number } | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private usingObserver = false;
  private observerHits = 0;
  private pollingActive = false;
  private startedAt = 0;
  private fallbackTriggered = false;

  constructor(
    private page: Page,
    private driver: MeetingDriver,
    private recorder: Recorder,
  ) {}

  /**
   * @param captionsOn  result of `driver.enableCaptions()`. If false,
   *                    skips the observer and polls directly.
   */
  async start(captionsOn = true): Promise<void> {
    this.startedAt = Date.now();
    if (captionsOn) {
      try {
        this.usingObserver = await this.installCaptionObserver();
      } catch (e) {
        log.warn({ error: (e as Error).message }, 'speaker: caption observer failed');
        this.usingObserver = false;
      }
    } else {
      log.info('speaker: captionsOn=false — skipping the observer, going straight to polling');
      this.usingObserver = false;
    }
    if (this.usingObserver) {
      log.info('speaker: capturing from native captions (MutationObserver)');
      // Health-check: catches the case where the region exists but the observer
      // emits nothing (DOM differs from what's expected for the speaker).
      this.healthTimer = setInterval(() => this.healthCheck(), HEALTH_CHECK_INTERVAL_MS);
    } else {
      log.info('speaker: captions unavailable — falling back to DOM polling');
      this.startPolling();
    }
  }

  /** Installs a MutationObserver in the page DOM that, on every new caption
   *  block, calls back into Node with the speaker's name.
   *
   *  SELF-TEST: after installing, reads the captions region right away. If
   *  it doesn't exist, returns false (we don't keep a "ghost" observer
   *  running against a nonexistent region).
   */
  private async installCaptionObserver(): Promise<boolean> {
    const cfg = this.driver.captionConfig;
    if (!cfg) return false;

    // Node callback — called by the page when the speaker of the latest
    // caption changes.
    await this.page.exposeFunction('__maCaption', (speaker: string) => {
      this.onSpeaker(speaker);
    });

    // Installs the observer. Returns { installed, regionFound } — we only
    // report success when the region ALREADY exists (self-test).
    const result = await this.page.evaluate((c) => {
      const w = window as unknown as { __maCaption?: (s: string) => void };
      if (typeof w.__maCaption !== 'function') return { installed: false, regionFound: false };

      const findRegion = (): Element | null => {
        for (const s of c.region) {
          try {
            const el = document.querySelector(s);
            if (el) return el;
          } catch { /* invalid selector */ }
        }
        return null;
      };
      const readSpeaker = (): string | null => {
        const root = findRegion();
        if (!root) return null;
        const lines: Element[] = [];
        for (const s of c.line) {
          try { lines.push(...Array.from(root.querySelectorAll(s))); } catch { /* invalid selector */ }
        }
        const last = (lines[lines.length - 1] as Element | undefined) ?? root;
        for (const s of c.speaker) {
          try {
            const el = last.querySelector(s);
            const name = el?.textContent?.trim();
            if (name && name.length > 1 && name.length <= 60 && !/[.!?]\s*$/.test(name)) {
              return name;
            }
          } catch { /* invalid selector */ }
        }
        return null;
      };

      let lastEmitted: string | null = null;
      let scheduled = false;
      const emit = () => {
        scheduled = false;
        const sp = readSpeaker();
        if (sp && sp !== lastEmitted) {
          lastEmitted = sp;
          w.__maCaption!(sp);
        }
      };
      const obs = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(emit, 350); // throttle ~3x/s
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      return { installed: true, regionFound: !!findRegion() };
    }, cfg);

    if (!result.installed) return false;
    if (!result.regionFound) {
      // Short retry: the region may show up milliseconds after the
      // toggle settles. 3 checks of 700ms cover ~2s.
      for (let i = 0; i < 3; i += 1) {
        await this.page.waitForTimeout(700);
        const present = await this.page.evaluate((c) => {
          for (const s of c.region) {
            try { if (document.querySelector(s)) return true; } catch { /* skip */ }
          }
          return false;
        }, cfg);
        if (present) return true;
      }
      log.warn('speaker: observer installed but the captions region does not exist — self-test failed');
      return false;
    }
    return true;
  }

  /** Receives a speaker (from the observer): closes the previous turn, opens a new one. */
  private onSpeaker(speaker: string): void {
    this.observerHits += 1;
    const now = this.recorder.elapsed();
    if (this.current?.speaker !== speaker) {
      if (this.current) this.entries.push({ ...this.current, end: now });
      this.current = { speaker, start: now };
    }
  }

  /** Starts the polling loop (idempotent). Used both as the primary
   *  mode (no captions) and as the contingency the health-check
   *  enables when the observer goes silent. */
  private startPolling(): void {
    if (this.pollingActive) return;
    this.pollingActive = true;
    this.pollTimer = setInterval(() => void this.tick(), config.pollIntervalMs);
  }

  /** Fallback: polls getActiveSpeaker (no captions OR contingency). */
  private async tick(): Promise<void> {
    let speaker: string | null = null;
    try {
      speaker = await this.driver.getActiveSpeaker(this.page);
    } catch {
      speaker = null;
    }
    const now = this.recorder.elapsed();
    if (speaker && this.current?.speaker !== speaker) {
      if (this.current) this.entries.push({ ...this.current, end: now });
      this.current = { speaker, start: now };
    } else if (!speaker && this.current) {
      this.entries.push({ ...this.current, end: now });
      this.current = null;
    }
  }

  /** Runs periodically. If the observer has been running for more than
   *  HEALTH_CHECK_GRACE_MS and never emitted anything, enables polling as a
   *  contingency (doesn't turn the observer off — if it "wakes up", it stays
   *  the preferred source via `current`, which both update). */
  private healthCheck(): void {
    if (!this.usingObserver) return;
    if (this.fallbackTriggered) return;
    if (this.observerHits > 0) return; // observer is alive
    if (Date.now() - this.startedAt < HEALTH_CHECK_GRACE_MS) return;
    this.fallbackTriggered = true;
    log.warn(
      { observerHits: this.observerHits, sinceStartMs: Date.now() - this.startedAt },
      'speaker: observer has had no hits for too long — enabling polling as a contingency',
    );
    this.startPolling();
  }

  /** Turns that overlap the window [from, to] (recording seconds), clipped
   *  to it: the slice of the timeline that goes with each chunk of the
   *  incremental upload. Absolute recording times (the orchestrator rebases them
   *  when concatenating). Doesn't change state: the open turn stays open. */
  slice(from: number, to: number): string {
    const open = this.current ? [{ ...this.current, end: this.recorder.elapsed() }] : [];
    const clipped = [...this.entries, ...open].map((e) => ({
      speaker: e.speaker,
      start: Math.max(e.start, from),
      end: Math.min(e.end, to),
    }));
    return JSON.stringify({ transcriptEntries: toNativeEntries(clipped) });
  }

  /** Closes the open turn and returns the JSON in transcript_native format. */
  finalize(): string {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.current) {
      this.entries.push({ ...this.current, end: this.recorder.elapsed() });
      this.current = null;
    }
    const transcriptEntries = toNativeEntries(this.entries);
    log.info(
      {
        turns: transcriptEntries.length,
        source: this.usingObserver
          ? (this.fallbackTriggered ? 'captions+polling-fallback' : 'captions')
          : 'polling',
        observerHits: this.observerHits,
        fallbackTriggered: this.fallbackTriggered,
      },
      'speaker timeline finalized',
    );
    return JSON.stringify({ transcriptEntries });
  }
}

/** The transcript_native format that transcribe.ts consumes. */
function toNativeEntries(entries: Array<{ speaker: string; start: number; end: number }>) {
  return entries
    .filter((e) => e.end > e.start && e.speaker)
    .map((e) => ({
      participant: { displayName: e.speaker },
      startTime: `${e.start.toFixed(3)}s`,
      endTime: `${e.end.toFixed(3)}s`,
    }));
}
