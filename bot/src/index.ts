// One meeting, one container:
//   join → record (screen + audio) + track who speaks → notice the end → hand back
// Leaves its result in OUT_DIR (see handback.ts) and exits 0, or 1 on failure.
// Ported from Queryable's meeting bot.

import { existsSync, statSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'patchright';
import { config } from './config.js';
import { log } from './logger.js';
import { launchBrowser } from './browser.js';
import { meetDriver } from './meet.js';
import { teamsDriver } from './teams.js';
import { Recorder } from './recorder.js';
import { ensureMeetingSinkRouting } from './pulse.js';
import { SpeakerTracker } from './speakerTracker.js';
import {
  markInCall, markJoining, markFailed, uploadAndHandoff, shouldLeave, shouldDiscard, heartbeat, reportBotAuth, setStatus,
  type ExitInfo,
} from './handback.js';
import type { MeetingDriver } from './driver.js';
import { dumpRoster, pageEvidence } from './driver.js';

const driver: MeetingDriver = config.provider === 'google_meet' ? meetDriver : teamsDriver;

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let recorder: Recorder | null = null;
let tracker: SpeakerTracker | null = null;
// The hand back runs ONCE, even when the normal end, a loop error and a signal race.
let finalized = false;

/** Stop the recording and leave it in OUT_DIR. Idempotent. Also the path for a
 *  partial recording (signal, browser closed). True when there was audio. */
async function finalizeAndUpload(reason: string, exit?: ExitInfo): Promise<boolean> {
  if (finalized) return true;
  finalized = true;
  if (!recorder) return false; // never started recording (the join failed)
  log.info({ reason }, 'finishing the recording');
  setStatus('leaving');
  const exitInfo: ExitInfo = exit ?? { reason, recordedSec: Math.round(recorder.elapsed()) };
  try {
    await recorder.stop(); // SIGTERM to ffmpeg closes the MP4 properly
  } catch (e) {
    log.error({ error: (e as Error).message }, 'could not stop the recording cleanly (handing back anyway)');
  }
  const audioPath = recorder.outputPath;
  if (!(existsSync(audioPath) && statSync(audioPath).size > 1024)) {
    await markFailed('record', 'no audio was recorded');
    return false;
  }
  const timeline = tracker ? tracker.finalize() : '{"transcriptEntries":[]}';
  try {
    await uploadAndHandoff(audioPath, timeline, recorder.videoPath, exitInfo);
    return true;
  } catch (e) {
    await markFailed('handback', (e as Error).message);
    return false;
  }
}

async function discardRecording(): Promise<void> {
  finalized = true;
  try {
    await recorder?.stop();
  } catch {}
}

/** true at the normal end; false when the join turned out false (already reported). */
async function run(): Promise<boolean> {
  log.info({ provider: config.provider }, 'bot starting');
  ({ browser, context } = await launchBrowser());
  const page: Page = await context.newPage();

  // 1. Join
  await markJoining();
  try {
    await driver.join(page, config.displayName);
  } catch (e) {
    throw new Error(`join failed: ${(e as Error).message}`);
  }
  await reportBotAuth({ storageState: await context.storageState().catch(() => undefined) }).catch(() => {});
  await markInCall();
  const joinedAt = Date.now();

  // 2. Native captions (best effort): they carry the speaker's name, the most
  //    reliable source for "who spoke when".
  let captionsOn = false;
  try {
    captionsOn = await driver.enableCaptions(page);
    log.info({ captionsOn }, captionsOn ? 'native captions on' : 'native captions unavailable');
  } catch (e) {
    log.warn({ error: (e as Error).message }, 'could not turn captions on (continuing)');
  }

  // 3. Record + track the speaker
  recorder = new Recorder();
  await recorder.start();
  // Chromium's output stream only appears once audio plays: make sure it lands
  // in the sink ffmpeg records, a few times.
  void ensureMeetingSinkRouting();
  setTimeout(() => void ensureMeetingSinkRouting(), 5_000);
  setTimeout(() => void ensureMeetingSinkRouting(), 20_000);
  tracker = new SpeakerTracker(page, driver, recorder);
  await tracker.start(captionsOn);
  setTimeout(() => {
    void dumpRoster(page).then((r) => log.info({ roster: r }, 'roster'));
  }, 12_000);

  // 4. Watch for the end. An error here (page/browser closed by a signal, a
  //    Chromium crash) must not lose the recording: leave the loop and hand
  //    back what there is.
  const deadline = Date.now() + config.maxMeetingMs;
  let aloneSince: number | null = null;
  let tick = 0;
  // Only believe "I'm alone" after having seen someone: a selector that no
  // longer matches would otherwise end real meetings.
  let everSawOthers = false;
  let exitReason: ExitInfo['reason'] = 'interrupted';
  let exitDetail: string | undefined;

  try {
    while (true) {
      await page.waitForTimeout(3_000);
      tick++;
      if (Date.now() > deadline) { exitReason = 'max_duration'; break; }
      if (await shouldLeave()) { exitReason = shouldDiscard() ? 'cancelled' : 'manual'; break; }
      if (await driver.hasEnded(page)) { exitReason = 'ended'; break; }
      const count = await driver.participantCount(page);
      if (tick % 10 === 0) void heartbeat(count);
      if (count >= 2) {
        if (!everSawOthers) log.info({ count }, 'other participants detected');
        everSawOthers = true;
        aloneSince = null;
      } else if (count === 1 && everSawOthers) {
        if (aloneSince === null) aloneSince = Date.now();
        else if (Date.now() - aloneSince > config.aloneGraceMs) { exitReason = 'alone'; break; }
      } else if (!everSawOthers && config.scheduledEndMs && Date.now() > config.scheduledEndMs) {
        exitReason = 'scheduled_end';
        break;
      }
    }
  } catch (e) {
    log.warn({ error: (e as Error).message }, 'loop interrupted (page/browser closed?) — saving what was recorded');
    exitReason = 'interrupted';
    exitDetail = (e as Error).message.slice(0, 200);
  }

  const evidence = exitReason === 'ended' || exitReason === 'interrupted'
    ? await pageEvidence(page).catch(() => undefined)
    : undefined;
  const inCallMs = Date.now() - joinedAt;

  // Cancelled: leave and keep nothing.
  if (exitReason === 'cancelled') {
    await discardRecording();
    await driver.leave(page).catch(() => {});
    setStatus('done', { discarded: true });
    return true;
  }

  // 5a. A false entry: the call "ended" seconds after joining and the bot never
  // saw anyone → it was never really in (a refusal or lobby screen that passed
  // for "joined"). Report a join failure instead of handing back silence.
  if (exitReason === 'ended' && !everSawOthers && inCallMs < config.earlyExitMs && !finalized) {
    const msg = `the call "ended" ${Math.round(inCallMs / 1000)}s after joining without the bot seeing anyone — `
      + `probably not admitted (lobby / guest refused) | ${evidence ?? 'no evidence'}`;
    await discardRecording();
    await driver.leave(page).catch(() => {});
    await markFailed('join', msg);
    return false;
  }

  // 5b. Hand back (partial or complete).
  await driver.leave(page).catch(() => {});
  await finalizeAndUpload('run-end', {
    reason: exitReason,
    detail: exitDetail,
    inCallSec: Math.round(inCallMs / 1000),
    recordedSec: Math.round(recorder?.elapsed() ?? 0),
    sawOthers: everSawOthers,
    evidence,
  });
  return true;
}

async function cleanup(): Promise<void> {
  try {
    await context?.close();
    await browser?.close();
  } catch {}
}

// `docker stop` sends SIGTERM; Ctrl+C SIGINT. Both save what was recorded.
async function onSignal(sig: string): Promise<void> {
  log.warn(`${sig} received — saving the partial recording`);
  if (shouldDiscard()) await discardRecording();
  else await finalizeAndUpload(sig).catch(() => {});
  await cleanup();
  process.exit(0);
}
process.on('SIGTERM', () => void onSignal('SIGTERM'));
process.on('SIGINT', () => void onSignal('SIGINT'));

run()
  .then(async (ok) => {
    await cleanup();
    log.info(ok ? 'bot finished' : 'bot ended without a recording (join failure reported)');
    process.exit(ok ? 0 : 1);
  })
  .catch(async (e) => {
    log.error({ error: (e as Error).message }, 'bot failed');
    const saved = await finalizeAndUpload('run-error').catch(() => false);
    if (!saved) await markFailed('bot', (e as Error).message).catch(() => {});
    await cleanup();
    process.exit(saved ? 0 : 1);
  });
