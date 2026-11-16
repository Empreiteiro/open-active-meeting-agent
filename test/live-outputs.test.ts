// The pure parts of acting in the meeting and of the outputs: caption turns
// and chat from UI snapshots (the bot's liveText.ts), mentions, the CRM /
// document parts of a plan, markdown for Notion and Jira, output targets.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaptionSegmenter, ChatReader, mergeSnapshot, newLines, type CaptionEvent } from '../bot/src/liveText.js';
import { fold, mentionsAgent } from '../src/live.js';
import { parseOutputs } from '../src/outputs/index.js';
import { markdownToNotionBlocks, richText } from '../src/outputs/notion.js';
import { jiraText } from '../src/outputs/tasks.js';
import { normalizeCrm, normalizeDoc, normalizePlan, parseAmount } from '../src/plan/normalize.js';
import { planRules } from '../src/plan/prompt.js';

test('mergeSnapshot: growth, scrolled-out head, revised words, a new text', () => {
  assert.equal(mergeSnapshot('', 'hello'), 'hello');
  assert.equal(mergeSnapshot('hello there', 'hello there my friend'), 'hello there my friend');
  // Meet drops the first lines of a long turn: the text keeps them.
  assert.equal(
    mergeSnapshot('one two three four five six seven eight nine', 'five six seven eight nine ten eleven'),
    'one two three four five six seven eight nine ten eleven',
  );
  assert.equal(mergeSnapshot('we should ship on friday', 'we should ship on Friday.'), 'we should ship on Friday.');
  assert.equal(mergeSnapshot('first sentence here', 'zzz'), 'first sentence here zzz');
  assert.equal(mergeSnapshot('same', '  same '), 'same');
});

test('CaptionSegmenter: open turns, a pause settles them, more words start a new turn', () => {
  const events: CaptionEvent[] = [];
  const seg = new CaptionSegmenter((e) => events.push(e), 2000);
  seg.update([{ id: 'b1', speaker: 'Ana', text: 'Meeting Agent,' }], 0);
  seg.update([{ id: 'b1', speaker: 'Ana', text: 'Meeting Agent, create a task' }], 500);
  assert.deepEqual(events.map((e) => [e.seg, e.final, e.text]), [['s1', false, 'Meeting Agent,'], ['s1', false, 'Meeting Agent, create a task']]);
  seg.tick(2600); // 2.1 s without change
  assert.deepEqual(events.at(-1), { seg: 's1', speaker: 'Ana', text: 'Meeting Agent, create a task', final: true, at: 2600 });
  // Ana goes on in the same block: only the new words, in a new turn.
  seg.update([{ id: 'b1', speaker: 'Ana', text: 'Meeting Agent, create a task for the login page' }], 3000);
  assert.deepEqual([events.at(-1)!.seg, events.at(-1)!.text, events.at(-1)!.final], ['s2', 'for the login page', false]);
  // Bruno's block appears: Ana's turn settles at once.
  seg.update([{ id: 'b1', speaker: 'Ana', text: 'Meeting Agent, create a task for the login page' }, { id: 'b2', speaker: 'Bruno', text: 'Agreed.' }], 3200);
  const finals = events.filter((e) => e.final).map((e) => [e.speaker, e.text]);
  assert.deepEqual(finals, [['Ana', 'Meeting Agent, create a task'], ['Ana', 'for the login page']]);
  seg.flush(4000);
  assert.deepEqual(events.at(-1)!.text, 'Agreed.');
  assert.equal(events.at(-1)!.final, true);
});

test('ChatReader: the first read is the baseline; senders from the time lines; the bot\'s own messages left out', () => {
  const r = new ChatReader(['Meeting Agent', 'You']);
  assert.deepEqual(r.read('In-call messages\nAna\n10:30\nhello all'), []);
  assert.deepEqual(r.read('In-call messages\nAna\n10:30\nhello all\n@Meeting Agent can you note this?'), [{ speaker: 'Ana', text: '@Meeting Agent can you note this?' }]);
  assert.deepEqual(r.read('In-call messages\nAna\n10:30\nhello all\n@Meeting Agent can you note this?\nYou\n10:31\nNoted!\nBruno 10:32\nthanks'), [{ speaker: 'Bruno', text: 'thanks' }]);
  assert.deepEqual(newLines(['a', 'b', 'c'], ['b', 'c', 'd', 'e']), ['d', 'e']);
  assert.deepEqual(newLines([], ['x']), ['x']);
});

test('mentions: the agent\'s name in speech or chat, accents and punctuation ignored', () => {
  const names = ['Meeting Agent', 'Assistente'];
  assert.equal(fold('Olá, @Meeting-Agent!'), 'ola meeting agent');
  assert.ok(mentionsAgent('Meeting Agent, create a task', names));
  assert.ok(mentionsAgent('@meeting agent can you help', names));
  assert.ok(mentionsAgent('ok assistente, anota isso', names));
  assert.ok(!mentionsAgent('the meeting agenda is long', names));
  assert.ok(mentionsAgent('Meeting Agents, what is on my screen?', names)); // a transcription slip
  assert.ok(mentionsAgent('meting agent anota isso', names));
  assert.ok(!mentionsAgent('a meeting about agents', names));
  assert.ok(!mentionsAgent('assistentes de vendas', names));
});

test('normalizeCrm / normalizeDoc, and a plan that is only a CRM update', () => {
  const crm = normalizeCrm({
    company: { name: ' Acme ', domain: 'https://www.acme.com/about' },
    contacts: [{ name: 'Ana Souza', email: 'ANA@acme.com', role: 'CTO' }, { name: 'Bruno', email: 'not an email' }, { email: 'x@y.z' }],
    deal: { name: 'Acme rollout', amount: '$12,000', currency: 'usd', close_date: '2026-12-31' },
    summary: 'Acme wants SSO.',
    next_steps: ['Send the proposal', ''],
  });
  assert.ok(crm);
  assert.deepEqual(crm.company, { name: 'Acme', domain: 'www.acme.com' });
  assert.deepEqual(crm.contacts.map((c) => [c.name, c.email]), [['Ana Souza', 'ana@acme.com'], ['Bruno', null]]);
  assert.equal(crm.deal?.amount, 12000);
  assert.equal(crm.deal?.currency, 'USD');
  assert.deepEqual(crm.next_steps, ['Send the proposal']);
  assert.equal(normalizeCrm({ contacts: [], summary: '' }), null);
  assert.deepEqual(['12,000', '$12.000,50', '1.234.567', '12.5', '12,5', 3000, 'n/a'].map(parseAmount), [12000, 12000.5, 1234567, 12.5, 12.5, 3000, null]);
  assert.deepEqual(normalizeDoc({ title: 'Minutes', markdown: '# Minutes' }), { title: 'Minutes', markdown: '# Minutes' });
  assert.equal(normalizeDoc({ title: 'empty' }), null);

  const plan = normalizePlan({ title: 'Sales call', summary: 'S', tasks: [], crm: { summary: 'Talked about pricing.' } }, [], [], 'host');
  assert.ok(plan);
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.crm?.summary, 'Talked about pricing.');
  // With no repository, a task whose deliverable was not said is a follow-up, not a PR.
  const p2 = normalizePlan({ tasks: [{ title: 'Send the proposal' }] }, [], [], 'host');
  assert.equal(p2?.tasks[0]?.deliverable, 'issue');
});

test('plan rules ask for the CRM update and the document only when the call delivers them', () => {
  const plain = planRules('en');
  assert.doesNotMatch(plain, /"crm"/);
  const both = planRules('pt', { crm: true, doc: true, template: '## Ata\n## Decisões' });
  assert.match(both, /"crm": what the call means for the CRM/);
  assert.match(both, /never guess an email/);
  assert.match(both, /<doc_template>\n## Ata\n## Decisões\n<\/doc_template>/);
  assert.match(both, /,"crm":\{…\},"doc":\{"title":"…","markdown":"…"\}\}$/);
});

test('markdown → Notion blocks and Jira markup', () => {
  const blocks = markdownToNotionBlocks('# Minutes\n\nWe agreed on **SSO** first.\nSee [the doc](https://x.dev/a).\n\n## Action items\n- [ ] Send proposal\n- [x] Book room\n- plain bullet\n1. first\n> quoted\n---\n```\ncode here\n```');
  assert.deepEqual(blocks.map((b) => b.type), ['heading_1', 'paragraph', 'heading_2', 'to_do', 'to_do', 'bulleted_list_item', 'numbered_list_item', 'quote', 'divider', 'code']);
  const para = (blocks[1] as unknown as { paragraph: { rich_text: Array<{ text: { content: string; link?: { url: string } }; annotations?: { bold?: boolean } }> } }).paragraph.rich_text;
  assert.deepEqual(para.map((r) => r.text.content), ['We agreed on ', 'SSO', ' first. See ', 'the doc', '.']);
  assert.equal(para[1]!.annotations?.bold, true);
  assert.equal(para[3]!.text.link?.url, 'https://x.dev/a');
  assert.equal((blocks[4] as unknown as { to_do: { checked: boolean } }).to_do.checked, true);
  assert.equal(richText('x'.repeat(4500)).length, 3); // 2000-char pieces

  assert.equal(jiraText('### Acceptance criteria\n- [ ] it works\n**bold** `code` [a](https://b.c)\n> q'), 'h3. Acceptance criteria\n* it works\n*bold* {{code}} [a|https://b.c]\nbq. q');
});

test('outputs: known targets, "none", and a clear error otherwise', () => {
  const base = { tasks: 'github' as const, crm: null, doc: null };
  assert.deepEqual(parseOutputs({ tasks: 'clickup', crm: 'hubspot' }, base), { tasks: 'clickup', crm: 'hubspot', doc: null });
  assert.deepEqual(parseOutputs({ tasks: 'none', doc: 'notion' }, base), { tasks: null, crm: null, doc: 'notion' });
  assert.deepEqual(parseOutputs(undefined, base), base);
  assert.throws(() => parseOutputs({ crm: 'salesforce' }, base), /crm cannot go to "salesforce" \(one of: hubspot, webhook, agent, none\)/);
});
