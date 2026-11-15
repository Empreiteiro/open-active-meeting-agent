// The CRM update in HubSpot (a private app token, HUBSPOT_TOKEN): the company
// and the contacts are found (by domain / email) or created, a deal is created
// when the call talked about one, and a note with the summary and the next
// steps is logged on all of them.

import { config } from '../config.js';
import type { CrmUpdate } from '../types.js';
import { requestJson } from './http.js';

// HubSpot-defined association types (v4).
const ASSOC = { contactToCompany: 279, dealToContact: 3, dealToCompany: 341, noteToContact: 202, noteToCompany: 190, noteToDeal: 214 } as const;

type Assoc = { to: { id: string }; types: Array<{ associationCategory: 'HUBSPOT_DEFINED'; associationTypeId: number }> };
const assoc = (id: string, typeId: number): Assoc => ({ to: { id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }] });

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''));

export async function deliverHubspot(crm: CrmUpdate, meeting: { title: string }): Promise<{ url: string | null; detail: string }> {
  if (!config.hubspotToken) throw new Error('HubSpot: HUBSPOT_TOKEN is not set');
  const api = config.hubspotApiUrl;
  const headers = { authorization: `Bearer ${config.hubspotToken}` };
  const findOne = async (type: string, prop: string, value: string): Promise<string | null> => {
    const r = await requestJson<{ results?: Array<{ id: string }> }>('POST', `${api}/crm/v3/objects/${type}/search`, {
      label: 'HubSpot', headers, body: { filterGroups: [{ filters: [{ propertyName: prop, operator: 'EQ', value }] }], limit: 1 },
    });
    return r.results?.[0]?.id ?? null;
  };
  const create = async (type: string, properties: Record<string, unknown>, associations: Assoc[] = []): Promise<string> => {
    const r = await requestJson<{ id?: string }>('POST', `${api}/crm/v3/objects/${type}`, {
      label: 'HubSpot', headers, body: { properties: clean(properties), ...(associations.length ? { associations } : {}) },
    });
    if (!r.id) throw new Error(`HubSpot: ${type} not created`);
    return r.id;
  };

  let companyId: string | null = null;
  const co = crm.company;
  if (co?.name || co?.domain) {
    companyId = (co.domain ? await findOne('companies', 'domain', co.domain) : await findOne('companies', 'name', co.name))
      ?? await create('companies', { name: co.name, domain: co.domain });
  }

  const contactIds: string[] = [];
  for (const c of crm.contacts.slice(0, 10)) {
    let id = c.email ? await findOne('contacts', 'email', c.email) : null;
    if (!id) {
      const [first, ...rest] = c.name.trim().split(/\s+/);
      id = await create('contacts', { firstname: first, lastname: rest.join(' '), email: c.email, jobtitle: c.role, phone: c.phone },
        companyId ? [assoc(companyId, ASSOC.contactToCompany)] : []);
    }
    contactIds.push(id);
  }

  let dealId: string | null = null;
  const d = crm.deal;
  if (d?.name) {
    const close = d.close_date && Number.isFinite(Date.parse(d.close_date)) ? new Date(d.close_date).toISOString() : null;
    dealId = await create('deals', {
      dealname: d.name,
      amount: d.amount != null ? String(d.amount) : null,
      closedate: close,
      pipeline: config.hubspotPipeline ?? 'default',
      dealstage: config.hubspotDealStage ?? 'appointmentscheduled',
    }, [...contactIds.map((id) => assoc(id, ASSOC.dealToContact)), ...(companyId ? [assoc(companyId, ASSOC.dealToCompany)] : [])]);
  }

  const body = [
    `<p><strong>${esc(meeting.title)}</strong></p>`,
    crm.summary ? `<p>${esc(crm.summary)}</p>` : '',
    d?.stage ? `<p>Stage discussed: ${esc(d.stage)}</p>` : '',
    crm.next_steps.length ? `<p>Next steps:</p><ul>${crm.next_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '',
    '<p><em>Logged by open-meeting-agent from the meeting.</em></p>',
  ].join('');
  const noteId = await create('notes', { hs_timestamp: new Date().toISOString(), hs_note_body: body }, [
    ...contactIds.map((id) => assoc(id, ASSOC.noteToContact)),
    ...(companyId ? [assoc(companyId, ASSOC.noteToCompany)] : []),
    ...(dealId ? [assoc(dealId, ASSOC.noteToDeal)] : []),
  ]);

  // A link to the main record, when the account id can be read.
  let url: string | null = null;
  try {
    const acct = await requestJson<{ portalId?: number }>('GET', `${api}/account-info/v3/details`, { label: 'HubSpot', headers });
    if (acct.portalId) {
      const rec = dealId ? `0-3/${dealId}` : companyId ? `0-2/${companyId}` : contactIds[0] ? `0-1/${contactIds[0]}` : null;
      if (rec) url = `https://app.hubspot.com/contacts/${acct.portalId}/record/${rec}`;
    }
  } catch { /* the link is a nicety */ }

  return { url, detail: `company ${companyId ?? '-'} · ${contactIds.length} contact(s) · deal ${dealId ?? '-'} · note ${noteId}` };
}
