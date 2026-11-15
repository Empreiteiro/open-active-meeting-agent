// Live text from the meeting UI as plain functions (no browser, no imports):
// the bot reads the caption blocks and the chat panel as snapshots, and these
// turn the snapshots into events. The host's tests exercise them directly.

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The text of one caption block as it changes. Meet and Teams append words,
 * revise the last ones and, on long turns, drop the oldest lines from the DOM:
 * the newer snapshot wins from the point where it starts in the older text.
 */
export function mergeSnapshot(prev: string, next: string): string {
  const a = norm(prev);
  const b = norm(next);
  if (!a) return b;
  if (!b || a === b) return a;
  // Where the new view starts inside the old text (it grew, or its head scrolled out).
  const head = b.slice(0, Math.min(24, b.length));
  const at = a.lastIndexOf(head);
  if (at >= 0) return a.slice(0, at) + b;
  // The first words were revised.
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i >= 8) return b;
  // Something else entirely in the same block: keep both.
  return `${a} ${b}`;
}

export interface CaptionEvent {
  seg: string;
  speaker: string;
  text: string;
  /** false while the person is still speaking: a later event with the same seg replaces it. */
  final: boolean;
  at: number;
}

interface Block { speaker: string; text: string; done: number; seg: string | null; changed: number }

/**
 * Caption blocks → turns. A turn settles (final) when its block stops changing
 * for `pauseMs` or a newer block appears; more words in the same block later
 * start a new turn with only the new text.
 */
export class CaptionSegmenter {
  private blocks = new Map<string, Block>();
  private n = 0;

  constructor(private readonly emit: (e: CaptionEvent) => void, private readonly pauseMs = 2000) {}

  /** The caption blocks on screen now, oldest first. */
  update(blocks: Array<{ id: string; speaker: string; text: string }>, now: number): void {
    for (const blk of blocks) {
      let b = this.blocks.get(blk.id);
      if (!b) {
        b = { speaker: blk.speaker, text: '', done: 0, seg: null, changed: now };
        this.blocks.set(blk.id, b);
      }
      if (blk.speaker) b.speaker = blk.speaker;
      const merged = mergeSnapshot(b.text, blk.text);
      if (merged === b.text) continue;
      b.text = merged;
      b.changed = now;
      const tail = merged.slice(b.done).trim();
      if (!tail) continue;
      if (!b.seg) b.seg = `s${++this.n}`;
      this.emit({ seg: b.seg, speaker: b.speaker, text: tail, final: false, at: now });
    }
    const last = blocks.at(-1)?.id;
    if (last) for (const [id, b] of this.blocks) if (id !== last && b.seg) this.settle(b, now);
    this.tick(now);
  }

  /** Settle the turns that paused; forget old blocks. */
  tick(now: number): void {
    for (const b of this.blocks.values()) if (b.seg && now - b.changed >= this.pauseMs) this.settle(b, now);
    if (this.blocks.size > 40) {
      for (const [id, b] of this.blocks) {
        if (this.blocks.size <= 20) break;
        if (!b.seg) this.blocks.delete(id);
      }
    }
  }

  /** The end of the call: everything open settles. */
  flush(now: number): void {
    for (const b of this.blocks.values()) this.settle(b, now);
  }

  private settle(b: Block, now: number): void {
    const tail = b.text.slice(b.done).trim();
    if (b.seg && tail) this.emit({ seg: b.seg, speaker: b.speaker, text: tail, final: true, at: now });
    b.done = b.text.length;
    b.seg = null;
  }
}

/** The lines of `next` after the part it shares with `prev` (the chat panel grows at the end). */
export function newLines(prev: string[], next: string[]): string[] {
  if (!prev.length) return next;
  for (let k = Math.min(3, prev.length); k >= 1; k--) {
    const anchor = prev.slice(-k);
    for (let p = next.length - k; p >= 0; p--) {
      if (anchor.every((l, j) => next[p + j] === l)) return next.slice(p + k);
    }
  }
  const seen = new Set(prev);
  return next.filter((l) => !seen.has(l));
}

const TIME = /^\d{1,2}:\d{2}(\s?[AaPp]\.?[Mm]\.?)?$/;
const SENDER_AND_TIME = /^(.{1,60}?)\s+\d{1,2}:\d{2}(\s?[AaPp]\.?[Mm]\.?)?$/;

/**
 * Messages from the chat panel's text. The panel shows a sender line followed
 * by a time line ("Ana" / "10:31", or "Ana 10:31") and then the messages; the
 * bot's own messages (sent as "You"/"Você" or its name) are left out. The
 * first read is the baseline: what was already there is not news.
 */
export class ChatReader {
  private prev: string[] | null = null;
  private sender = '';
  private readonly self: Set<string>;

  constructor(selfNames: string[]) {
    this.self = new Set(selfNames.map((s) => norm(s).toLowerCase()).filter(Boolean));
  }

  read(panelText: string): Array<{ speaker: string; text: string }> {
    const lines = panelText.split('\n').map(norm).filter(Boolean);
    if (this.prev === null) {
      this.prev = lines;
      this.follow(lines);
      return [];
    }
    const fresh = newLines(this.prev, lines);
    this.prev = lines;
    return this.follow(fresh);
  }

  private follow(lines: string[]): Array<{ speaker: string; text: string }> {
    const out: Array<{ speaker: string; text: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (TIME.test(l)) continue;
      if (i + 1 < lines.length && TIME.test(lines[i + 1]!)) { this.sender = l; continue; }
      const st = l.match(SENDER_AND_TIME);
      if (st) { this.sender = st[1]!; continue; }
      if (this.self.has(this.sender.toLowerCase())) continue;
      out.push({ speaker: this.sender, text: l });
    }
    return out;
  }
}
