// The meeting document as a Notion page: markdown → Notion blocks (headings,
// lists, to-dos, quotes, code, dividers, bold/code/links), under a page or as
// a row of a database.

import { config } from '../config.js';
import { requestJson } from './http.js';

type RichText = { type: 'text'; text: { content: string; link?: { url: string } | null }; annotations?: { bold?: boolean; code?: boolean } };
export type NotionBlock = { object: 'block'; type: string } & Record<string, unknown>;

const MAX_TEXT = 2000;

/** Inline markdown (**bold**, `code`, [text](url)) as Notion rich text, in ≤2000-char pieces. */
export function richText(s: string): RichText[] {
  const out: RichText[] = [];
  const push = (content: string, extra: Partial<RichText> = {}) => {
    for (let i = 0; i < content.length; i += MAX_TEXT) {
      out.push({ type: 'text', text: { ...(extra.text ?? {}), content: content.slice(i, i + MAX_TEXT) }, ...(extra.annotations ? { annotations: extra.annotations } : {}) });
    }
  };
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:[^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) push(s.slice(last, m.index));
    if (m[1] != null) push(m[1], { annotations: { bold: true } });
    else if (m[2] != null) push(m[2], { annotations: { code: true } });
    else if (m[3] != null) push(m[3], { text: { content: '', link: { url: m[4]! } } });
    last = m.index + m[0].length;
  }
  if (last < s.length) push(s.slice(last));
  return out;
}

const block = (type: string, body: Record<string, unknown>): NotionBlock => ({ object: 'block', type, [type]: body });

export function markdownToNotionBlocks(md: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(block('paragraph', { rich_text: richText(para.join(' ')) }));
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith('```'); i++) code.push(lines[i]!);
      blocks.push(block('code', { rich_text: richText(code.join('\n')), language: 'plain text' }));
      continue;
    }
    const t = line.trim();
    let m: RegExpMatchArray | null;
    if (!t) { flush(); continue; }
    if ((m = t.match(/^(#{1,6})\s+(.*)$/))) { flush(); blocks.push(block(`heading_${Math.min(m[1]!.length, 3)}`, { rich_text: richText(m[2]!) })); continue; }
    if ((m = t.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/))) { flush(); blocks.push(block('to_do', { rich_text: richText(m[2]!), checked: m[1] !== ' ' })); continue; }
    if ((m = t.match(/^[-*]\s+(.*)$/))) { flush(); blocks.push(block('bulleted_list_item', { rich_text: richText(m[1]!) })); continue; }
    if ((m = t.match(/^\d+[.)]\s+(.*)$/))) { flush(); blocks.push(block('numbered_list_item', { rich_text: richText(m[1]!) })); continue; }
    if ((m = t.match(/^>\s?(.*)$/))) { flush(); blocks.push(block('quote', { rich_text: richText(m[1]!) })); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); blocks.push(block('divider', {})); continue; }
    para.push(t);
  }
  flush();
  return blocks;
}

const headers = () => ({ authorization: `Bearer ${config.notionToken}`, 'notion-version': '2022-06-28' });

/** A new page with the document; returns its URL. */
export async function createNotionPage(title: string, markdown: string): Promise<{ url: string; id: string }> {
  if (!config.notionToken) throw new Error('Notion: NOTION_TOKEN is not set');
  if (!config.notionDatabase && !config.notionParentPage) throw new Error('Notion: set OMA_NOTION_PARENT_PAGE_ID (a page shared with the integration) or OMA_NOTION_DATABASE_ID');
  const children = markdownToNotionBlocks(markdown);
  const titleText = [{ type: 'text', text: { content: title.slice(0, MAX_TEXT) } }];
  const parent = config.notionDatabase ? { database_id: config.notionDatabase } : { page_id: config.notionParentPage };
  const properties = config.notionDatabase ? { [config.notionTitleProperty]: { title: titleText } } : { title: { title: titleText } };
  const page = await requestJson<{ id?: string; url?: string }>('POST', `${config.notionApiUrl}/pages`, {
    label: 'Notion', headers: headers(), body: { parent, properties, children: children.slice(0, 100) },
  });
  if (!page.id) throw new Error('Notion: page not created');
  // A request takes at most 100 blocks: the rest is appended.
  for (let i = 100; i < children.length; i += 100) {
    await requestJson('PATCH', `${config.notionApiUrl}/blocks/${page.id}/children`, {
      label: 'Notion', headers: headers(), body: { children: children.slice(i, i + 100) },
    });
  }
  return { url: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, '')}`, id: page.id };
}
