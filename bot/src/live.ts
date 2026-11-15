// The agent in the meeting: reads the captions (who said what, as turns) and
// the chat, writes them to live.jsonl for the host, and runs the host's
// commands (post in the chat). Best-effort throughout: a selector that no
// longer matches costs the live features, never the recording.

import type { Page } from 'patchright';
import { config } from './config.js';
import { chatText, openChat, sendChat, type MeetingDriver } from './driver.js';
import { appendLive, readCommands } from './handback.js';
import { CaptionSegmenter, ChatReader } from './liveText.js';
import { log } from './logger.js';

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

export class LiveChannel {
  private readonly segmenter = new CaptionSegmenter((e) => appendLive({ type: 'caption', ...e }));
  private readonly chat = new ChatReader([config.displayName, 'You', 'Você', 'Tú', 'Vous', 'Du']);
  private commandsRun = 0;
  private chatOpen = false;
  private captionsOk = false;
  private busy = false;
  /** What the agent posted lately: read back from the panel, it is not news. */
  private sent: string[] = [];

  constructor(private readonly page: Page, private readonly driver: MeetingDriver) {}

  async start(captionsOn: boolean): Promise<void> {
    if (captionsOn) {
      this.captionsOk = await this.installCaptionReader().catch((e) => {
        log.warn({ error: (e as Error).message }, 'live: caption reader failed');
        return false;
      });
    }
    const chat = this.driver.chatConfig;
    if (chat && config.liveChat) {
      this.chatOpen = await openChat(this.page, chat).catch(() => false);
      if (this.chatOpen) this.chat.read(await chatText(this.page, chat)); // baseline
    }
    appendLive({ type: 'live', captions: this.captionsOk, chat: this.chatOpen });
    log.info({ captions: this.captionsOk, chat: this.chatOpen }, 'live: reading the meeting');
  }

  /** Called about once a second from the main loop. */
  async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.segmenter.tick(Date.now());
      await this.readChat();
      await this.runCommands();
    } catch (e) {
      log.warn({ error: (e as Error).message }, 'live: pump failed');
    } finally {
      this.busy = false;
    }
  }

  /** The end of the call: the turns still open settle. */
  stop(): void {
    this.segmenter.flush(Date.now());
  }

  private async readChat(): Promise<void> {
    const chat = this.driver.chatConfig;
    if (!chat || !this.chatOpen) return;
    const text = await chatText(this.page, chat);
    if (!text) return;
    for (const m of this.chat.read(text)) {
      if (this.sent.includes(norm(m.text))) continue;
      appendLive({ type: 'chat', speaker: m.speaker, text: m.text });
    }
  }

  private async runCommands(): Promise<void> {
    for (const c of readCommands(this.commandsRun)) {
      this.commandsRun++;
      if (!c.id || !c.text.trim()) continue;
      const chat = this.driver.chatConfig;
      if (!chat) {
        appendLive({ type: 'sent', id: c.id, ok: false, error: 'no chat support for this meeting provider' });
        continue;
      }
      try {
        const wasOpen = this.chatOpen;
        await sendChat(this.page, chat, c.text);
        this.chatOpen = true;
        this.sent = [...this.sent.slice(-19), norm(c.text)];
        // Opened just now: what is in the panel is the baseline, not news.
        if (!wasOpen) this.chat.read(await chatText(this.page, chat));
        appendLive({ type: 'sent', id: c.id, ok: true, text: c.text });
      } catch (e) {
        log.warn({ error: (e as Error).message }, 'live: could not post in the chat');
        appendLive({ type: 'sent', id: c.id, ok: false, error: (e as Error).message.slice(0, 300) });
      }
    }
  }

  /**
   * A MutationObserver on the captions: the last few caption blocks (speaker +
   * text) go to the segmenter, which turns them into turns. Self-test: true
   * only when the captions region exists now.
   */
  private async installCaptionReader(): Promise<boolean> {
    const cfg = this.driver.captionConfig;
    await this.page.exposeFunction('__omaCaptions', (blocks: Array<{ id: string; speaker: string; text: string }>) => {
      this.segmenter.update(blocks, Date.now());
    });
    return this.page.evaluate((c) => {
      type W = { __omaCaptions?: (b: Array<{ id: string; speaker: string; text: string }>) => void; __omaN?: number };
      const w = window as unknown as W;
      const ids = new WeakMap<Element, string>();
      const idOf = (el: Element): string => {
        let id = ids.get(el);
        if (!id) { w.__omaN = (w.__omaN ?? 0) + 1; id = `b${w.__omaN}`; ids.set(el, id); }
        return id;
      };
      const region = (): Element | null => {
        for (const s of c.region) {
          try { const el = document.querySelector(s); if (el) return el; } catch { /* invalid selector */ }
        }
        return null;
      };
      const read = () => {
        const root = region();
        if (!root) return;
        let lines: Element[] = [];
        for (const s of c.line) {
          try { lines.push(...Array.from(root.querySelectorAll(s))); } catch { /* invalid selector */ }
        }
        // The outermost matches are the blocks (inner ones are their parts).
        lines = lines.filter((el) => !lines.some((o) => o !== el && o.contains(el)));
        if (!lines.length) lines = [root];
        const out: Array<{ id: string; speaker: string; text: string }> = [];
        for (const el of lines.slice(-4)) {
          let speaker = '';
          for (const s of c.speaker) {
            try {
              const name = el.querySelector(s)?.textContent?.trim();
              if (name && name.length > 1 && name.length <= 60 && !/[.!?]\s*$/.test(name)) { speaker = name; break; }
            } catch { /* invalid selector */ }
          }
          let text = ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (speaker && text.startsWith(speaker)) text = text.slice(speaker.length).trim();
          if (text) out.push({ id: idOf(el), speaker, text });
        }
        if (out.length) w.__omaCaptions?.(out);
      };
      let scheduled = false;
      new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => { scheduled = false; read(); }, 400);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
      return !!region();
    }, cfg);
  }
}
