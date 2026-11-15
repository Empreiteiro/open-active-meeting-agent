// One webhook for every output (OMA_WEBHOOK_URL): Zapier, Make, n8n, a script…
// The body says what it carries ("event": tasks, task, crm, doc); with
// OMA_WEBHOOK_SECRET it is signed: x-oma-signature: sha256=<hex HMAC of the body>.

import { createHmac } from 'node:crypto';
import { config } from '../config.js';

export async function postWebhook(event: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!config.webhookUrl) throw new Error('OMA_WEBHOOK_URL is not set.');
  const body = JSON.stringify({ event, ...payload, sent_at: new Date().toISOString() });
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'open-meeting-agent' };
  if (config.webhookSecret) headers['x-oma-signature'] = `sha256=${createHmac('sha256', config.webhookSecret).update(body).digest('hex')}`;
  let r: Response;
  try {
    r = await fetch(config.webhookUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new Error(`webhook: ${(e as Error).message}`);
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`webhook: HTTP ${r.status} ${text.slice(0, 300)}`);
  try {
    const j = JSON.parse(text) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
