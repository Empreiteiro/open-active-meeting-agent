// Audio routing check (belt-and-suspenders for the "silent sink" fix).
// Even with the deterministic entrypoint, make sure at runtime that Chromium's
// output stream (the call audio) is playing into MeetingSink — where ffmpeg
// captures from. Moves any sink-input that landed on another sink and logs the
// routing (the observability that was missing in incident ac008458).
import { spawn } from 'node:child_process';
import { log } from './logger.js';

function pactl(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn('pactl', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', () => resolve('')); // pactl missing/failed → best-effort
    p.on('close', () => resolve(out));
  });
}

/** Numeric index of MeetingSink — the `sink` column of sink-inputs is the index,
 *  not the name, so we resolve name → index to detect strays. */
async function meetingSinkIndex(): Promise<string | null> {
  const sinks = await pactl(['list', 'short', 'sinks']); // idx \t name \t ...
  for (const ln of sinks.split('\n')) {
    const [idx, name] = ln.split('\t');
    if (name?.trim() === 'MeetingSink') return idx?.trim() ?? null;
  }
  return null;
}

/**
 * Moves every output stream that is not on MeetingSink over to it. Best-effort
 * and idempotent: NEVER throws (it must not bring the recording down). Run it a
 * few times — Chromium's stream only appears once the call starts playing audio.
 * Returns how many streams were misplaced (0 = already fine / nothing playing).
 */
export async function ensureMeetingSinkRouting(): Promise<number> {
  try {
    const meeting = await meetingSinkIndex();
    if (!meeting) {
      log.warn('MeetingSink not found while checking audio routing');
      return 0;
    }
    const inputs = (await pactl(['list', 'short', 'sink-inputs'])).split('\n').filter(Boolean);
    let moved = 0;
    for (const ln of inputs) {
      const cols = ln.split('\t');
      const inputIdx = cols[0]?.trim();
      const sinkIdx = cols[1]?.trim();
      if (!inputIdx) continue;
      if (sinkIdx !== meeting) {
        await pactl(['move-sink-input', inputIdx, 'MeetingSink']);
        moved++;
        log.warn({ inputIdx, from: sinkIdx, to: meeting }, 'sink-input outside MeetingSink — moved back');
      }
    }
    log.info({ sinkInputs: inputs.length, moved }, 'audio routing checked (MeetingSink)');
    return moved;
  } catch (e) {
    log.warn({ error: (e as Error).message }, 'failed to check audio routing (continuing)');
    return 0;
  }
}
