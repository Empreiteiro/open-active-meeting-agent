// Speaker names: the bot reads who is speaking from the meeting's own UI
// (native captions or the speaking indicator) and saves a timeline. Each ASR
// segment takes the name of the turn it overlaps the most.

import type { Segment } from '../types.js';

export interface Turn { start: number; end: number; speaker: string }

/** The bot's timeline file: { transcriptEntries: [{ participant: { displayName }, startTime: "12.300s", endTime }] }. */
export function parseTimeline(raw: string | null): Turn[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as {
      transcriptEntries?: Array<{ participant?: { displayName?: string }; startTime: string; endTime: string }>;
    };
    const secs = (v: string) => (v.endsWith('s') ? Number(v.slice(0, -1)) : new Date(v).getTime() / 1000);
    return (data.transcriptEntries ?? [])
      .map((e) => ({ start: secs(e.startTime), end: secs(e.endTime), speaker: e.participant?.displayName ?? 'Unknown' }))
      .filter((t) => Number.isFinite(t.start) && Number.isFinite(t.end) && t.end > t.start);
  } catch {
    return [];
  }
}

export function applySpeakers(segments: Segment[], turns: Turn[]): Segment[] {
  if (!turns.length) return segments;
  return segments.map((seg) => {
    let best: Turn | null = null;
    let bestOvl = 0;
    for (const t of turns) {
      const ovl = Math.min(seg.end, t.end) - Math.max(seg.start, t.start);
      if (ovl > bestOvl) { bestOvl = ovl; best = t; }
    }
    return best ? { ...seg, speaker: best.speaker } : seg;
  });
}
