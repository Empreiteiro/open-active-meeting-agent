// Meeting Agent UI — the page served by `oma ui` (src/ui/server.ts).
// A chat with the local agent (Claude Code, or a command) beside the meetings:
// their live transcript, plan and outputs. No framework, no build step.

const TOKEN = document.querySelector('meta[name="oma-token"]').content;
const LANG = (new URLSearchParams(location.search).get('lang') || navigator.language || 'en').toLowerCase().startsWith('pt') ? 'pt' : 'en';
document.documentElement.lang = LANG;

// ── Text ────────────────────────────────────────────────────────────────────

const I18N = {
  en: {
    newChat: 'New chat', joinMeeting: 'Join a meeting', setup: 'Setup', search: 'Search', closeSidebar: 'Close sidebar', openSidebar: 'Open sidebar',
    meetings: 'Meetings', chats: 'Chats', noMeetings: 'No meetings yet', noChats: 'No chats yet',
    greeting: 'What meeting are we working on?', placeholder: 'Ask the agent, or paste a meeting link', placeholderMeeting: 'Ask about this meeting',
    placeholderSay: 'Write in the meeting chat as {name}', send: 'Send', stop: 'Stop',
    sug1: 'Join a meeting', sug2: 'What was agreed in the last meeting?', sug3: 'Build the plan of the last meeting', sug4: 'Do the tasks of the last meeting',
    msug1: 'What was agreed in this meeting?', msug2: 'Build the plan for this meeting', msug3: 'Deliver the outputs of this meeting', msug4: 'Do the tasks of this meeting',
    st_joining: 'Joining', st_in_call: 'In the meeting', st_processing: 'Processing', st_needs_plan: 'Ready to plan', st_planned: 'Planned', st_failed: 'Failed', st_cancelled: 'Cancelled',
    tabChat: 'Chat', tabLive: 'Live', tabTranscript: 'Transcript', tabPlan: 'Plan',
    end: 'End meeting', discard: 'Leave without keeping', confirmDiscard: 'The agent leaves and nothing of this meeting is kept. Continue?',
    deliver: 'Deliver', delivering: 'Delivering…', buildPlan: 'Build the plan', doTasks: 'Do the tasks',
    captionsOn: 'Captions on', captionsOff: 'No captions', chatOn: 'Chat open', chatOff: 'No chat', waitingBot: 'Waiting for the bot…',
    answers: 'Answers: {who}', answersAgent: 'your agent (watch_meeting)', nobody: 'Nobody answers when called', useClaude: 'Let Claude Code answer',
    answerHere: 'Answer in the meeting', liveTasksTo: 'Tasks asked for: created in {target}', liveTasksAfter: 'Tasks asked for: with the plan',
    noLines: 'Nothing said yet. Call the agent by name: "{name}, …"', afterOnly: 'This meeting acts after the call — the agent only listens.',
    processingText: 'Transcribing and reading the shared screen…', joiningText: 'The agent is joining. Admit it from the lobby if asked.',
    noTranscript: 'No transcript yet.', readyToPlan: 'The meeting is ready to plan.', autoPlan: '{model} builds plans here by itself.',
    tasks: 'Tasks', crm: 'CRM update', doc: 'Document', questions: 'Open questions', createdLive: 'Created during the meeting', notes: 'Notes',
    deliveredTo: 'Delivered · {target}', notDelivered: 'Not delivered yet', acceptance: 'Acceptance criteria', dependsOn: 'after {keys}', leftOut: 'left out',
    ts_todo: 'To do', ts_in_progress: 'In progress', ts_blocked: 'Blocked', ts_done: 'Done', ts_skipped: 'Skipped',
    pr_low: 'Low', pr_medium: 'Medium', pr_high: 'High', pr_urgent: 'Urgent',
    company: 'Company', contacts: 'Contacts', deal: 'Deal', nextSteps: 'Next steps', summary: 'Summary', builtBy: 'by {who}',
    used: 'Used', using: 'Using', wantsTo: '{agent} wants to use {tool}', allow: 'Allow', deny: 'Deny', allowed: 'Allowed', denied: 'Denied',
    folder: 'Folder', changeFolder: 'Change folder', folderPrompt: 'The folder the agent works in:', deleteChat: 'Delete chat', confirmDelete: 'Delete this chat?',
    joinTitle: 'Join a meeting', link: 'Meeting link (Google Meet or Teams)', title: 'Title', optional: 'optional', whenActs: 'When the agent acts',
    act_after: 'After', act_during: 'During', act_both: 'Both',
    actHelp_after: 'Quiet in the meeting; works on the plan once it ends.', actHelp_during: 'Answers when someone calls it; afterwards it only keeps the plan.', actHelp_both: 'Answers in the meeting, and works on the plan after it.',
    autonomy: 'After the call, on its own', au_suggest: 'Stop at the plan', au_issues: 'Deliver the outputs', au_prs: 'Also open pull requests',
    tasksTo: 'Tasks', crmTo: 'CRM', docTo: 'Document', none: 'None', more: 'More options', repo: 'GitHub repository (owner/repo)', workdir: 'Work folder', cancel: 'Cancel', join: 'Join',
    noBrain: 'Nobody will answer in the meeting yet.',
    localAi: 'Local AI', chatAgent: 'This chat', notFound: 'not found', plansAnswers: 'Plans and answers in the meeting', notSet: 'Not set: you build plans here in the chat.',
    useClaudeCode: 'Use Claude Code', stopUsing: 'Stop using', defaults: 'Defaults for new meetings', agentName: 'Agent\'s name in the meeting', language: 'Language of plans and messages',
    save: 'Save', saved: 'Saved', machine: 'This machine', checking: 'Checking…', secrets: 'Tokens and keys: {file}',
    searchPlaceholder: 'Search meetings and chats', nothingFound: 'Nothing found', liveCount: '{n} in a meeting', ready: 'ready', local: 'local',
    lost: 'Lost the connection to oma ui.', reload: 'Reload', sent: 'Sent to the meeting', ended: 'The agent is leaving the meeting.',
    source_bot: 'Bot', source_meetily: 'meetily', source_file: 'Recording', gm: 'Google Meet', teams: 'Teams', actSum_after: 'acts after the call', actSum_during: 'acts during the call', actSum_both: 'acts during and after the call', autonomyV: 'autonomy: {v}',
  },
  pt: {
    newChat: 'Nova conversa', joinMeeting: 'Entrar numa reunião', setup: 'Configuração', search: 'Buscar', closeSidebar: 'Fechar barra lateral', openSidebar: 'Abrir barra lateral',
    meetings: 'Reuniões', chats: 'Conversas', noMeetings: 'Nenhuma reunião ainda', noChats: 'Nenhuma conversa ainda',
    greeting: 'Em que reunião vamos trabalhar?', placeholder: 'Pergunte ao agente ou cole o link da reunião', placeholderMeeting: 'Pergunte sobre esta reunião',
    placeholderSay: 'Escreva no chat da reunião como {name}', send: 'Enviar', stop: 'Parar',
    sug1: 'Entrar numa reunião', sug2: 'O que ficou combinado na última reunião?', sug3: 'Monte o plano da última reunião', sug4: 'Execute as tarefas da última reunião',
    msug1: 'O que ficou combinado nesta reunião?', msug2: 'Monte o plano desta reunião', msug3: 'Entregue as saídas desta reunião', msug4: 'Execute as tarefas desta reunião',
    st_joining: 'Entrando', st_in_call: 'Na reunião', st_processing: 'Processando', st_needs_plan: 'Pronta para o plano', st_planned: 'Planejada', st_failed: 'Falhou', st_cancelled: 'Cancelada',
    tabChat: 'Conversa', tabLive: 'Ao vivo', tabTranscript: 'Transcrição', tabPlan: 'Plano',
    end: 'Encerrar', discard: 'Sair sem guardar', confirmDiscard: 'O agente sai e nada desta reunião é guardado. Continuar?',
    deliver: 'Entregar', delivering: 'Entregando…', buildPlan: 'Montar o plano', doTasks: 'Executar as tarefas',
    captionsOn: 'Legendas ligadas', captionsOff: 'Sem legendas', chatOn: 'Chat aberto', chatOff: 'Sem chat', waitingBot: 'Esperando o bot…',
    answers: 'Quem responde: {who}', answersAgent: 'seu agente (watch_meeting)', nobody: 'Ninguém responde quando chamado', useClaude: 'Deixar o Claude Code responder',
    answerHere: 'Responder na reunião', liveTasksTo: 'Tarefas pedidas: criadas no {target}', liveTasksAfter: 'Tarefas pedidas: vêm com o plano',
    noLines: 'Nada dito ainda. Chame o agente pelo nome: "{name}, …"', afterOnly: 'Esta reunião age depois da call — o agente só escuta.',
    processingText: 'Transcrevendo e lendo a tela compartilhada…', joiningText: 'O agente está entrando. Aceite-o na sala de espera se pedir.',
    noTranscript: 'Ainda sem transcrição.', readyToPlan: 'A reunião está pronta para o plano.', autoPlan: '{model} monta os planos aqui sozinho.',
    tasks: 'Tarefas', crm: 'Atualização do CRM', doc: 'Documento', questions: 'Perguntas em aberto', createdLive: 'Criadas durante a reunião', notes: 'Notas',
    deliveredTo: 'Entregue · {target}', notDelivered: 'Ainda não entregue', acceptance: 'Critérios de aceite', dependsOn: 'depois de {keys}', leftOut: 'fora',
    ts_todo: 'A fazer', ts_in_progress: 'Em andamento', ts_blocked: 'Bloqueada', ts_done: 'Feita', ts_skipped: 'Pulada',
    pr_low: 'Baixa', pr_medium: 'Média', pr_high: 'Alta', pr_urgent: 'Urgente',
    company: 'Empresa', contacts: 'Contatos', deal: 'Negócio', nextSteps: 'Próximos passos', summary: 'Resumo', builtBy: 'por {who}',
    used: 'Usou', using: 'Usando', wantsTo: '{agent} quer usar {tool}', allow: 'Permitir', deny: 'Negar', allowed: 'Permitido', denied: 'Negado',
    folder: 'Pasta', changeFolder: 'Trocar pasta', folderPrompt: 'A pasta em que o agente trabalha:', deleteChat: 'Apagar conversa', confirmDelete: 'Apagar esta conversa?',
    joinTitle: 'Entrar numa reunião', link: 'Link da reunião (Google Meet ou Teams)', title: 'Título', optional: 'opcional', whenActs: 'Quando o agente age',
    act_after: 'Depois', act_during: 'Durante', act_both: 'Os dois',
    actHelp_after: 'Fica quieto na reunião; trabalha no plano quando ela acaba.', actHelp_during: 'Responde quando alguém o chama; depois só guarda o plano.', actHelp_both: 'Responde na reunião e trabalha no plano depois.',
    autonomy: 'Depois da call, sozinho', au_suggest: 'Parar no plano', au_issues: 'Entregar as saídas', au_prs: 'Também abrir pull requests',
    tasksTo: 'Tarefas', crmTo: 'CRM', docTo: 'Documento', none: 'Nenhum', more: 'Mais opções', repo: 'Repositório GitHub (owner/repo)', workdir: 'Pasta de trabalho', cancel: 'Cancelar', join: 'Entrar',
    noBrain: 'Ninguém vai responder na reunião ainda.',
    localAi: 'IA local', chatAgent: 'Esta conversa', notFound: 'não encontrado', plansAnswers: 'Planos e respostas na reunião', notSet: 'Não configurado: os planos são montados aqui na conversa.',
    useClaudeCode: 'Usar o Claude Code', stopUsing: 'Parar de usar', defaults: 'Padrões para novas reuniões', agentName: 'Nome do agente na reunião', language: 'Idioma dos planos e mensagens',
    save: 'Salvar', saved: 'Salvo', machine: 'Esta máquina', checking: 'Verificando…', secrets: 'Tokens e chaves: {file}',
    searchPlaceholder: 'Buscar reuniões e conversas', nothingFound: 'Nada encontrado', liveCount: '{n} em reunião', ready: 'pronto', local: 'local',
    lost: 'A conexão com o oma ui caiu.', reload: 'Recarregar', sent: 'Enviado na reunião', ended: 'O agente está saindo da reunião.',
    source_bot: 'Bot', source_meetily: 'meetily', source_file: 'Gravação', gm: 'Google Meet', teams: 'Teams', actSum_after: 'age depois da call', actSum_during: 'age durante a call', actSum_both: 'age durante e depois da call', autonomyV: 'autonomia: {v}',
  },
};

function t(key, vars = {}) {
  let s = I18N[LANG][key] ?? I18N.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

const $ = (s, root = document) => root.querySelector(s);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const ICONS = {
  edit: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a1 1 0 0 1 3 3l-9 9a2 2 0 0 1-.85.5l-2.9.85a.5.5 0 0 1-.6-.62l.84-2.87a2 2 0 0 1 .5-.85z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>',
  video: '<path d="m16 13 5.2 3.1a.5.5 0 0 0 .8-.4V8.3a.5.5 0 0 0-.8-.4L16 11"/><rect x="2" y="6" width="14" height="12" rx="2.5"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  phoneOff: '<path d="M10.7 13.3a16 16 0 0 0 3.4 2.6l1.3-1.3a2 2 0 0 1 2.1-.5 13 13 0 0 0 2.8.7 2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2A20 20 0 0 1 3.2 5.2 2 2 0 0 1 5.1 3h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L9 10.9"/><path d="m22 2-20 20"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 17v4M17 19h4"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  link: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  wave: '<path d="M2 12h2M6 8v8M10 5v14M14 8v8M18 10v4M22 12h0"/>',
};

function icon(name, cls = '') {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
  return tpl.content.firstChild;
}

function toast(msg, error = false) {
  const el = h('div', { class: `toast${error ? ' error' : ''}` }, msg);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), error ? 7000 : 3500);
}

// ── Markdown (escaped first; links only http(s)/mailto) ─────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(src) {
  const codes = [];
  let s = String(src).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_, txt, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

function mdList(lines, start) {
  const first = lines[start].match(/^(\s*)([-*+]|\d+[.)])\s+/);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  let html = ordered ? '<ol>' : '<ul>';
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    const m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (!m) {
      if (l.trim() && /^\s{2,}/.test(l) && html.endsWith('</li>')) { html = `${html.slice(0, -5)}<br>${inline(l.trim())}</li>`; i++; continue; }
      break;
    }
    const ind = m[1].length;
    if (ind < base) break;
    if (ind > base) {
      const [sub, j] = mdList(lines, i);
      html = html.endsWith('</li>') ? `${html.slice(0, -5)}${sub}</li>` : html + sub;
      i = j;
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break;
    let item = m[3];
    let box = '';
    const c = item.match(/^\[([ xX])\]\s+(.*)$/);
    if (c) { box = `<input type="checkbox" disabled${c[1] === ' ' ? '' : ' checked'}>`; item = c[2]; }
    html += `<li>${box}${inline(item)}</li>`;
    i++;
  }
  return [html + (ordered ? '</ol>' : '</ul>'), i];
}

function md(src) {
  const lines = String(src ?? '').replace(/\r/g, '').split('\n');
  let out = '';
  const para = [];
  const flush = () => { if (para.length) { out += `<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`; para.length = 0; } };
  const cells = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (/^\s*```/.test(l)) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
    } else if ((m = l.match(/^(#{1,4})\s+(.*)$/))) {
      flush();
      out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
      i++;
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) {
      flush(); out += '<hr>'; i++;
    } else if (/^\s*>/.test(l)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out += `<blockquote>${md(buf.join('\n'))}</blockquote>`;
    } else if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      flush();
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out += `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      flush();
      const [html, j] = mdList(lines, i);
      out += html;
      i = j;
    } else if (!l.trim()) {
      flush(); i++;
    } else {
      para.push(l); i++;
    }
  }
  flush();
  return out;
}

const mdEl = (src, cls = 'md') => h('div', { class: cls, html: md(src) });

// ── API ─────────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'x-oma-token': TOKEN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}

// ── State ───────────────────────────────────────────────────────────────────

const S = {
  state: null,
  calls: [],
  chats: [],
  route: { name: 'home' },
  chat: null,      // the open chat (with its messages)
  detail: null,    // the open meeting
  tab: null,
  pane: null,      // the chat on screen: { thread, scroller, composer }
  sections: JSON.parse(localStorage.getItem('oma.sections') || '{"meetings":true,"chats":true}'),
};

const IN_MEETING = new Set(['joining', 'in_call']);
const isMeetingUrl = (s) => /^https:\/\/(meet\.google\.com\/|teams\.microsoft\.com\/|teams\.live\.com\/)\S+$/.test(s.trim());

function fold(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function mentions(text, names) {
  const f = ` ${fold(text)} `;
  return names.some((n) => { const x = fold(n); return x.length >= 3 && f.includes(` ${x} `); });
}

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return LANG === 'pt' ? 'agora' : 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString(LANG === 'pt' ? 'pt-BR' : undefined, { day: 'numeric', month: 'short' });
}
function clock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const hh = Math.floor(sec / 3600);
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ── Sidebar and top bar ─────────────────────────────────────────────────────

function iconBtn(name, title, onclick) {
  return h('button', { class: 'icon-btn', title, 'aria-label': title, onclick }, icon(name));
}

function toggleSidebar() {
  document.body.classList.toggle('collapsed');
  localStorage.setItem('oma.collapsed', document.body.classList.contains('collapsed') ? '1' : '0');
}

function section(key, label, items) {
  const open = S.sections[key] !== false;
  return h('section', {},
    h('button', {
      class: `sb-head${open ? ' open' : ''}`,
      onclick: () => { S.sections[key] = !open; localStorage.setItem('oma.sections', JSON.stringify(S.sections)); renderSidebar(); },
    }, label, icon('chevron', 'sm')),
    open ? h('div', { class: 'sb-list' }, items) : null);
}

function renderSidebar() {
  const sb = $('#sidebar');
  const keep = $('.sb-scroll', sb)?.scrollTop ?? 0;
  const r = S.route;
  const meetings = S.calls.length
    ? S.calls.map((c) => h('a', { class: `sb-item${r.name === 'meeting' && r.id === c.id ? ' active' : ''}`, href: `#/m/${c.id}`, title: `${c.title} · ${t(`st_${c.status}`)}` },
      h('span', { class: `dot ${c.status}` }), h('span', { class: 'label' }, c.title), h('span', { class: 'when' }, ago(c.created_at))))
    : h('div', { class: 'sb-empty' }, t('noMeetings'));
  const free = S.chats.filter((c) => !c.call_id);
  const chats = free.length
    ? free.map((c) => h('a', { class: `sb-item${r.name === 'chat' && r.id === c.id ? ' active' : ''}`, href: `#/c/${c.id}`, title: c.title },
      c.running ? h('span', { class: 'dot running' }) : null,
      h('span', { class: 'label' }, c.title || t('newChat')),
      h('span', { class: 'when' }, ago(c.updated_at)),
      h('button', {
        class: 'del', title: t('deleteChat'),
        onclick: async (e) => {
          e.preventDefault(); e.stopPropagation();
          if (!confirm(t('confirmDelete'))) return;
          await api('DELETE', `/api/chats/${c.id}`).catch((x) => toast(x.message, true));
          await loadChats();
          if (S.route.name === 'chat' && S.route.id === c.id) location.hash = '#/';
        },
      }, icon('trash', 'sm'))))
    : h('div', { class: 'sb-empty' }, t('noChats'));

  const ag = S.state?.agent;
  sb.replaceChildren(
    h('div', { class: 'sb-top' },
      h('a', { class: 'brand', href: '#/' }, 'Meeting Agent'),
      h('div', { class: 'sb-icons' }, iconBtn('search', t('search'), openSearch), iconBtn('sidebar', t('closeSidebar'), toggleSidebar))),
    h('nav', { class: 'sb-nav' },
      h('a', { class: `nav-item${r.name === 'home' ? ' active' : ''}`, href: '#/' }, icon('edit'), t('newChat')),
      h('button', { class: 'nav-item', onclick: () => openJoin() }, icon('video'), t('joinMeeting'))),
    h('div', { class: 'sb-scroll' }, section('meetings', t('meetings'), meetings), section('chats', t('chats'), chats)),
    h('div', { class: 'sb-bottom' },
      h('div', { class: 'agent-card' },
        h('span', { class: `avatar${ag?.ready ? '' : ' off'}` }, ag?.kind === 'command' ? '>_' : 'CC'),
        h('div', {},
          h('div', { class: 'agent-name' }, ag?.label ?? '…'),
          h('div', { class: 'agent-sub' }, ag ? (ag.ready ? `${t('local')} · ${t('ready')}` : t('notFound')) : ''))),
      h('button', { class: 'wide-btn', onclick: openSetup }, icon('sliders', 'sm'), t('setup'))),
  );
  const sc = $('.sb-scroll', sb);
  if (sc) sc.scrollTop = keep;
}

function renderTopbar() {
  const live = S.calls.filter((c) => IN_MEETING.has(c.status));
  let title = '';
  if (S.route.name === 'chat' && S.chat) title = S.chat.title || t('newChat');
  $('#topbar').replaceChildren(
    h('div', { class: 'top-left' },
      h('button', { class: 'icon-btn', id: 'btn-expand', title: t('openSidebar'), onclick: toggleSidebar }, icon('sidebar')),
      h('div', { class: 'top-title' }, title)),
    h('div', { class: 'top-right' },
      live.length ? h('a', { class: 'pill live', href: `#/m/${live[0].id}` }, h('span', { class: `dot ${live[0].status}` }), t('liveCount', { n: live.length })) : null,
      h('a', { class: 'icon-btn', href: '#/', title: t('newChat') }, icon('edit'))),
  );
}

// ── Composer ────────────────────────────────────────────────────────────────

function composer({ placeholder, onSend, onStop, plus, chip, autofocus }) {
  const ta = h('textarea', { rows: 1, placeholder, 'aria-label': placeholder });
  const btn = h('button', { class: 'send', title: t('send'), disabled: true }, icon('arrowUp'));
  let running = false;
  const size = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`; btn.disabled = !running && !ta.value.trim(); };
  const submit = () => {
    const v = ta.value.trim();
    if (!v || running) return;
    ta.value = '';
    size();
    onSend(v);
  };
  ta.addEventListener('input', size);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  btn.addEventListener('click', () => (running ? onStop?.() : submit()));
  const el = h('div', { class: 'composer' },
    plus ? h('button', { class: 'icon-btn', title: t('joinMeeting'), onclick: (e) => plus(e.currentTarget) }, icon('plus')) : null,
    ta, chip ?? null, btn);
  if (autofocus) setTimeout(() => ta.focus(), 0);
  return {
    el, ta,
    setRunning(r) {
      running = r;
      btn.classList.toggle('stop', r);
      btn.title = r ? t('stop') : t('send');
      btn.replaceChildren(icon(r ? 'stop' : 'arrowUp'));
      size();
    },
  };
}

function menu(anchor, items) {
  closeMenus();
  const m = h('div', { class: 'menu' }, items.map(([ic, label, fn]) => h('button', { onclick: () => { closeMenus(); fn(); } }, icon(ic), label)));
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const top = r.top - m.offsetHeight - 8;
  m.style.left = `${Math.max(8, r.left)}px`;
  m.style.top = `${top > 8 ? top : r.bottom + 8}px`;
  setTimeout(() => document.addEventListener('click', closeMenus, { once: true }), 0);
}
function closeMenus() { document.querySelectorAll('.menu').forEach((m) => m.remove()); }

function agentChip() {
  const ag = S.state?.agent;
  return h('button', { class: 'chip', title: ag?.detail ?? '', onclick: openSetup }, ag?.label ?? '…');
}

// ── Home ────────────────────────────────────────────────────────────────────

function renderHome() {
  S.pane = null;
  const c = composer({
    placeholder: t('placeholder'), autofocus: true, chip: agentChip(),
    plus: (el) => menu(el, [['video', t('joinMeeting'), () => openJoin()]]),
    onSend: (text) => homeSend(text),
  });
  const sug = (ic, label, fn) => h('button', { class: 'suggestion', onclick: fn }, icon(ic), label);
  const latest = S.calls.find((x) => !['failed', 'cancelled'].includes(x.status));
  $('#view').replaceChildren(h('div', { class: 'home' },
    h('h1', { class: 'greeting' }, t('greeting')),
    c.el,
    h('div', { class: 'suggestions' },
      sug('video', t('sug1'), () => openJoin()),
      latest ? sug('message', t('sug2'), () => meetingAsk(latest.id, t('msug1'))) : null,
      latest ? sug('sparkle', t('sug3'), () => meetingAsk(latest.id, t('msug2'))) : null,
      latest ? sug('code', t('sug4'), () => meetingAsk(latest.id, t('msug4'))) : null)));
}

async function homeSend(text) {
  if (isMeetingUrl(text)) { openJoin({ url: text.trim() }); return; }
  try {
    const chat = await api('POST', '/api/chats', {});
    await api('POST', `/api/chats/${chat.id}/messages`, { text });
    location.hash = `#/c/${chat.id}`;
    loadChats();
  } catch (e) { toast(e.message, true); }
}

/** Ask the agent something in a meeting's chat (opening the meeting there). */
async function meetingAsk(callId, text) {
  try {
    const d = await api('GET', `/api/calls/${callId}`);
    const chatId = d.chat_id ?? (await api('POST', '/api/chats', { call_id: callId })).id;
    await api('POST', `/api/chats/${chatId}/messages`, { text });
    if (S.route.name === 'meeting' && S.route.id === callId && S.tab === 'chat') { await openMeeting(callId, 'chat'); return; }
    location.hash = `#/m/${callId}/chat`;
  } catch (e) { toast(e.message, true); }
}

// ── Chat ────────────────────────────────────────────────────────────────────

/** Claude Code's own bookkeeping, not worth a line in the chat. */
const HIDDEN_TOOLS = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

function toolLabel(name) {
  const m = name.match(/^mcp__(?:plugin_[^_]+(?:-[^_]+)*_)?(.+?)__(.+)$/);
  return m ? m[2].replace(/_/g, ' ') : name;
}
function toolArg(input) {
  for (const k of ['command', 'file_path', 'path', 'url', 'pattern', 'query', 'call_id', 'description']) {
    if (typeof input?.[k] === 'string' && input[k]) return input[k];
  }
  return '';
}

function renderPart(p, msg) {
  if (p.type === 'text') return p.text.trim() ? mdEl(p.text) : null;
  if (p.type === 'tool' && HIDDEN_TOOLS.has(p.name)) return null;
  if (p.type === 'tool') {
    const state = p.status === 'running' ? h('span', { class: 'spin' }) : h('span', { class: `state ${p.status}` }, icon(p.status === 'ok' ? 'check' : 'alert', 'sm'));
    const body = [JSON.stringify(p.input, null, 2), p.result ? `\n→ ${p.result}` : ''].join('');
    return h('details', { class: 'tool' },
      h('summary', {}, icon('terminal', 'sm'), h('span', { class: 'name' }, `${p.status === 'running' ? t('using') : t('used')} ${toolLabel(p.name)}`), h('span', { class: 'arg' }, toolArg(p.input)), state),
      h('pre', {}, body));
  }
  if (p.type === 'permission') {
    const agent = S.state?.agent?.label ?? 'Agent';
    if (p.decision !== 'pending' || !S.chat?.running) {
      return h('div', { class: 'permission done' }, icon(p.decision === 'allowed' ? 'check' : 'x', 'sm'),
        `${p.decision === 'allowed' ? t('allowed') : t('denied')}: ${toolLabel(p.tool)}`, h('span', { class: 'muted' }, toolArg(p.input)));
    }
    const answer = (allow) => api('POST', `/api/chats/${S.chat.id}/permissions/${encodeURIComponent(p.id)}`, { allow }).catch((e) => toast(e.message, true));
    return h('div', { class: 'permission' },
      h('div', { class: 'head' }, icon('shield', 'sm'), t('wantsTo', { agent, tool: toolLabel(p.tool) })),
      h('pre', {}, toolArg(p.input) || JSON.stringify(p.input, null, 2)),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => answer(true) }, t('allow')),
        h('button', { class: 'btn', onclick: () => answer(false) }, t('deny'))));
  }
  return null;
}

function renderMsg(msg) {
  if (msg.role === 'user') return h('div', { class: 'msg user', 'data-id': msg.id }, h('div', { class: 'bubble' }, msg.text));
  const parts = (msg.parts ?? []).map((p) => renderPart(p, msg)).filter(Boolean);
  const last = S.chat?.messages.at(-1);
  const waiting = S.chat?.running && last?.id === msg.id && !(msg.parts ?? []).some((p) => p.type === 'text' && p.text.trim());
  return h('div', { class: 'msg assistant', 'data-id': msg.id },
    parts,
    waiting ? h('div', { class: 'typing' }, h('i'), h('i'), h('i')) : null,
    msg.error ? h('div', { class: 'msg-error' }, icon('alert', 'sm'), msg.error) : null);
}

function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 140; }

function updateMsg(msg) {
  if (!S.pane) return;
  const stick = nearBottom(S.pane.scroller);
  const old = S.pane.thread.querySelector(`[data-id="${msg.id}"]`);
  const el = renderMsg(msg);
  if (old) old.replaceWith(el); else S.pane.thread.append(el);
  if (stick) S.pane.scroller.scrollTop = S.pane.scroller.scrollHeight;
}

/** The chat panel: the open chat, or the empty state of a meeting's chat. */
function chatPane({ callId = null, empty = null }) {
  const thread = h('div', { class: 'thread' });
  const scroller = h('div', { class: 'messages' }, thread);
  const c = composer({
    placeholder: callId ? t('placeholderMeeting') : t('placeholder'), autofocus: true, chip: agentChip(),
    plus: (el) => menu(el, [['video', t('joinMeeting'), () => openJoin()], ['folder', t('changeFolder'), changeFolder]]),
    onSend: (text) => chatSend(text, callId),
    onStop: () => S.chat && api('POST', `/api/chats/${S.chat.id}/stop`, {}).catch((e) => toast(e.message, true)),
  });
  S.pane = { thread, scroller, composer: c };
  if (S.chat?.messages.length) {
    for (const m of S.chat.messages) thread.append(renderMsg(m));
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  } else if (empty) thread.append(empty);
  c.setRunning(!!S.chat?.running);
  const folder = S.chat?.workdir ?? S.state?.defaults.workdir ?? '';
  return h('div', { class: 'chat' }, scroller,
    h('div', { class: 'composer-dock' }, c.el,
      h('div', { class: 'dock-hint' },
        h('button', { onclick: changeFolder, title: t('changeFolder') }, icon('folder', 'sm'), folder.replace(/^\/Users\/[^/]+/, '~')))));
}

async function changeFolder() {
  const cur = S.chat?.workdir ?? S.state?.defaults.workdir ?? '';
  const v = prompt(t('folderPrompt'), cur);
  if (!v || v === cur) return;
  try {
    if (!S.chat) S.chat = { ...(await api('POST', '/api/chats', { call_id: S.route.name === 'meeting' ? S.route.id : null, workdir: v })), running: false };
    else S.chat = { ...(await api('PATCH', `/api/chats/${S.chat.id}`, { workdir: v })), running: S.chat.running };
    rerenderChat();
  } catch (e) { toast(e.message, true); }
}

function rerenderChat() {
  if (S.route.name === 'chat') renderChatView();
  else if (S.route.name === 'meeting' && S.tab === 'chat') renderMeetingBody();
}

async function chatSend(text, callId) {
  try {
    if (!S.chat) {
      S.chat = { ...(await api('POST', '/api/chats', { call_id: callId })), running: false };
      if (S.pane) S.pane.thread.replaceChildren();
    }
    const r = await api('POST', `/api/chats/${S.chat.id}/messages`, { text });
    upsertMsg(r.user);
    upsertMsg(r.assistant);
    S.chat.running = true;
    S.pane?.composer.setRunning(true);
    updateMsg(r.user);
    updateMsg(r.assistant);
    if (S.pane) S.pane.scroller.scrollTop = S.pane.scroller.scrollHeight;
    loadChats();
  } catch (e) { toast(e.message, true); }
}

function upsertMsg(m) {
  const list = S.chat.messages;
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) list[i] = m; else list.push(m);
}

const pendingRender = new Set();
function renderSoon(msg) {
  if (pendingRender.has(msg.id)) return;
  pendingRender.add(msg.id);
  requestAnimationFrame(() => { pendingRender.delete(msg.id); updateMsg(msg); });
}

function onChatEvent(e) {
  if (e.type === 'start' || e.type === 'done') loadChats();
  if (!S.chat || S.chat.id !== e.chat_id) return;
  const find = (id) => S.chat.messages.find((m) => m.id === id);
  if (e.type === 'start') {
    upsertMsg(e.user); upsertMsg(e.assistant);
    S.chat.running = true;
    updateMsg(e.user); updateMsg(e.assistant);
  } else if (e.type === 'text') {
    const m = find(e.message_id);
    if (!m) return;
    const last = m.parts.at(-1);
    if (last?.type === 'text') last.text += e.text; else m.parts.push({ type: 'text', text: e.text });
    renderSoon(m);
    return;
  } else if (e.type === 'part') {
    const m = find(e.message_id);
    if (!m) return;
    const i = m.parts.findIndex((p) => p.type === e.part.type && p.id === e.part.id);
    if (i >= 0) m.parts[i] = e.part; else m.parts.push(e.part);
    updateMsg(m);
  } else if (e.type === 'done') {
    upsertMsg(e.message);
    S.chat.running = false;
    updateMsg(e.message);
    if (e.error) toast(e.error, true);
  }
  S.pane?.composer.setRunning(!!S.chat.running);
}

async function openChat(id) {
  try {
    S.chat = await api('GET', `/api/chats/${id}`);
  } catch (e) { toast(e.message, true); location.hash = '#/'; return; }
  if (S.chat.call_id) { location.replace(`#/m/${S.chat.call_id}/chat`); return; }
  S.detail = null;
  renderChatView();
}

function renderChatView() {
  $('#view').replaceChildren(chatPane({}));
  renderTopbar();
}

// ── Meeting ─────────────────────────────────────────────────────────────────

function defaultTab(d) {
  const st = d.call.status;
  if (IN_MEETING.has(st)) return 'live';
  if (st === 'planned' || st === 'needs_plan' || st === 'processing') return 'plan';
  return d.chat_id ? 'chat' : 'plan';
}

async function openMeeting(id, tab) {
  try {
    S.detail = await api('GET', `/api/calls/${id}`);
  } catch (e) { toast(e.message, true); location.hash = '#/'; return; }
  S.chat = S.detail.chat_id ? await api('GET', `/api/chats/${S.detail.chat_id}`).catch(() => null) : null;
  S.tab = tab || S.route.tab || defaultTab(S.detail);
  renderMeeting();
}

async function refreshMeeting() {
  const id = S.detail?.call.id;
  if (!id) return;
  const d = await api('GET', `/api/calls/${id}`).catch(() => null);
  if (!d || S.detail?.call.id !== id) return;
  const statusChanged = d.call.status !== S.detail.call.status;
  S.detail = d;
  $('.m-head')?.replaceWith(meetingHead());
  if (S.tab === 'live') renderLiveLines();
  else if (S.tab === 'plan' || statusChanged) { if (S.tab !== 'chat') renderMeetingBody(); }
}

const providerName = (c) => (c.provider === 'google_meet' ? t('gm') : c.provider === 'microsoft_teams' ? t('teams') : t(`source_${c.source}`));

function meetingHead() {
  const d = S.detail;
  const c = d.call;
  const o = c.outputs ?? {};
  const outs = ['tasks', 'crm', 'doc'].filter((k) => o[k]).map((k) => `${t(`${k}To`)} → ${o[k]}`);
  const actions = [];
  if (IN_MEETING.has(c.status)) {
    actions.push(h('button', { class: 'btn', onclick: endMeeting }, icon('phoneOff', 'sm'), t('end')));
    actions.push(h('button', { class: 'btn danger', onclick: discardMeeting }, t('discard')));
  }
  if (d.plan) actions.push(h('button', { class: 'btn', onclick: deliver, id: 'btn-deliver' }, icon('send', 'sm'), t('deliver')));
  const tab = (key, ic, label, count) => h('button', { class: `tab${S.tab === key ? ' active' : ''}`, onclick: () => { location.hash = `#/m/${c.id}/${key}`; } },
    icon(ic, 'sm'), label, count ? h('span', { class: 'count' }, count) : null);
  const liveLabel = d.live && IN_MEETING.has(c.status) ? t('tabLive') : t('tabTranscript');
  const lineCount = d.transcript?.length || d.live?.lines.length || 0;
  return h('div', { class: 'm-head' },
    h('div', { class: 'm-row' },
      h('div', { class: 'm-title' }, h('h2', { title: c.title }, c.title), h('span', { class: 'status' }, h('span', { class: `dot ${c.status}` }), t(`st_${c.status}`))),
      h('div', { class: 'm-actions' }, actions)),
    h('div', { class: 'm-sub' },
      h('span', {}, providerName(c)),
      c.source === 'bot' ? h('span', {}, t(`actSum_${c.act}`)) : null,
      h('span', {}, t('autonomyV', { v: t(`au_${c.autonomy}`) })),
      outs.length ? h('span', {}, outs.join(' · ')) : null,
      c.repos.length ? h('span', {}, c.repos.join(', ')) : null,
      h('span', {}, new Date(c.created_at).toLocaleString(LANG === 'pt' ? 'pt-BR' : undefined, { dateStyle: 'medium', timeStyle: 'short' }))),
    c.status === 'failed' && c.error ? h('div', { class: 'banner error' }, icon('alert', 'sm'), c.error) : null,
    h('div', { class: 'tabs' },
      tab('chat', 'message', t('tabChat')),
      tab('live', 'wave', liveLabel, lineCount || null),
      tab('plan', 'list', t('tabPlan'), d.plan ? `${d.plan.progress.done}/${d.plan.progress.total}` : null)));
}

function renderMeeting() {
  $('#view').replaceChildren(h('div', { class: 'meeting' }, meetingHead(), h('div', { class: 'm-body' })));
  renderMeetingBody();
  renderTopbar();
}

function renderMeetingBody() {
  const body = $('.m-body');
  if (!body || !S.detail) return;
  if (S.tab === 'chat') {
    const id = S.detail.call.id;
    const sug = (ic, text) => h('button', { class: 'suggestion', onclick: () => chatSend(text, id) }, icon(ic), text);
    const empty = h('div', { class: 'suggestions', style: 'margin-top:8vh' },
      sug('message', t('msug1')), sug('sparkle', t('msug2')), sug('send', t('msug3')), sug('code', t('msug4')));
    body.replaceChildren(chatPane({ callId: id, empty }));
    return;
  }
  S.pane = null;
  if (S.tab === 'live') body.replaceChildren(livePane());
  else body.replaceChildren(planPane());
}

async function endMeeting() {
  try { S.detail = await api('POST', `/api/calls/${S.detail.call.id}/end`, {}); toast(t('ended')); renderMeeting(); } catch (e) { toast(e.message, true); }
}
async function discardMeeting() {
  if (!confirm(t('confirmDiscard'))) return;
  try { S.detail = await api('POST', `/api/calls/${S.detail.call.id}/cancel`, {}); renderMeeting(); } catch (e) { toast(e.message, true); }
}
async function deliver() {
  const b = $('#btn-deliver');
  if (b) { b.disabled = true; b.textContent = t('delivering'); }
  try {
    const r = await api('POST', `/api/calls/${S.detail.call.id}/deliver`, {});
    S.detail = r.detail;
    toast(r.text.split('\n')[0] || t('saved'), r.results.some((x) => !x.ok));
    renderMeeting();
  } catch (e) { toast(e.message, true); renderMeeting(); }
}

// Live / transcript

function livePane() {
  const d = S.detail;
  const c = d.call;
  const wrap = h('div', { class: 'chat' });
  const scroller = h('div', { class: 'scroll', id: 'live-scroll' }, h('div', { class: 'col', id: 'live-col' }));
  wrap.append(scroller);
  if (c.source === 'bot' && IN_MEETING.has(c.status)) {
    const say = composer({
      placeholder: t('placeholderSay', { name: c.agent_name }),
      onSend: async (text) => {
        try {
          const r = await api('POST', `/api/calls/${c.id}/say`, { text });
          if (r.ok === false) toast(r.error || 'failed', true); else toast(t('sent'));
        } catch (e) { toast(e.message, true); }
      },
    });
    wrap.append(h('div', { class: 'composer-dock' }, say.el));
  }
  requestAnimationFrame(() => renderLiveLines(true));
  return wrap;
}

function renderLiveLines(first = false) {
  const col = $('#live-col');
  const scroller = $('#live-scroll');
  if (!col || !S.detail) return;
  const d = S.detail;
  const c = d.call;
  const stick = first || nearBottom(scroller);
  const kids = [];
  const inMeeting = c.source === 'bot' && IN_MEETING.has(c.status);

  if (inMeeting) {
    if (c.status === 'joining') kids.push(h('div', { class: 'banner' }, h('span', { class: 'spin' }), t('joiningText')));
    const info = [];
    if (d.live) {
      info.push(d.live.captions === null ? h('span', {}, t('waitingBot'))
        : h('span', { class: d.live.captions ? 'on' : 'off' }, `● ${d.live.captions ? t('captionsOn') : t('captionsOff')}`));
      if (d.live.chat !== null) info.push(h('span', { class: d.live.chat ? 'on' : 'off' }, `● ${d.live.chat ? t('chatOn') : t('chatOff')}`));
    }
    if (c.act === 'after') {
      info.push(h('span', {}, t('afterOnly')));
      info.push(h('button', { class: 'btn', onclick: () => setAct('both') }, t('answerHere')));
    } else if (d.brain) {
      info.push(h('span', {}, t('answers', { who: d.brain === 'agent' ? t('answersAgent') : d.brain })));
      info.push(h('span', {}, d.live_tasks_to ? t('liveTasksTo', { target: d.live_tasks_to }) : t('liveTasksAfter')));
    } else {
      info.push(h('span', { class: 'off' }, t('nobody')));
      if (S.state?.agent?.kind === 'claude' && S.state.agent.ready) info.push(h('button', { class: 'btn blue', onclick: useClaudeCode }, t('useClaude')));
    }
    kids.push(h('div', { class: 'live-info' }, info));
  }

  const lines = [];
  if (d.transcript?.length && !inMeeting) {
    for (const s of d.transcript) {
      lines.push(h('div', { class: 'line' }, h('span', { class: 't' }, clock(s.start)), h('div', {}, h('span', { class: 'who' }, s.speaker), s.text)));
    }
  } else if (d.live) {
    const start = Date.parse(c.joined_at ?? c.created_at);
    const when = (at) => (Number.isFinite(start) ? clock((at - start) / 1000) : '');
    for (const l of d.live.lines) {
      const mention = l.kind !== 'agent' && mentions(l.text, d.names ?? [c.agent_name]);
      lines.push(h('div', { class: `line ${l.kind}${mention ? ' mention' : ''}` },
        h('span', { class: 't' }, when(l.at)),
        h('div', {}, l.kind === 'chat' ? h('span', { class: 'tag' }, 'chat') : null, h('span', { class: 'who' }, l.speaker || '—'), l.text)));
    }
    for (const s of d.live.speaking) {
      lines.push(h('div', { class: 'line speaking' }, h('span', { class: 't' }, when(s.at)), h('div', {}, h('span', { class: 'who' }, s.speaker || '—'), `${s.text} …`)));
    }
  }
  if (lines.length) kids.push(h('div', { class: 'lines' }, lines));
  else if (inMeeting) kids.push(h('div', { class: 'empty' }, c.act === 'after' ? '' : t('noLines', { name: c.agent_name })));
  else if (c.status === 'processing') kids.push(h('div', { class: 'empty' }, h('span', { class: 'spin' }), t('processingText')));
  else kids.push(h('div', { class: 'empty' }, t('noTranscript')));

  col.replaceChildren(...kids);
  if (stick) scroller.scrollTop = scroller.scrollHeight;
}

async function setAct(act) {
  try { S.detail = await api('PATCH', `/api/calls/${S.detail.call.id}`, { act }); renderMeeting(); } catch (e) { toast(e.message, true); }
}

async function useClaudeCode() {
  try {
    await api('POST', '/api/config', { OMA_LLM_PROVIDER: 'claude-code' });
    S.state = await api('GET', '/api/state');
    if (S.detail) await refreshMeeting();
    toast(t('saved'));
  } catch (e) { toast(e.message, true); }
}

// Plan

function deliveryLine(del) {
  if (!del) return h('span', { class: 'pending' }, t('notDelivered'));
  return h('span', { class: 'delivered' }, icon('check', 'sm'), t('deliveredTo', { target: del.target }),
    del.url ? h('a', { href: del.url, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 'sm')) : null);
}

function taskCard(task, d) {
  const frames = task.frames.filter((f) => d.frames.some((x) => x.label === f));
  const tags = [
    h('span', { class: `tagc ${task.state}` }, task.include ? t(`ts_${task.state}`) : t('leftOut')),
    task.priority ? h('span', { class: `tagc ${task.priority}` }, t(`pr_${task.priority}`)) : null,
    h('span', { class: 'tagc' }, task.deliverable === 'pr' ? `PR${task.repo ? ` · ${task.repo}` : ''}` : (task.repo ?? 'issue')),
    task.depends_on.length ? h('span', { class: 'tagc' }, t('dependsOn', { keys: task.depends_on.join(', ') })) : null,
  ];
  const links = [
    task.issue_url ? h('a', { href: task.issue_url, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 'sm'), task.issue_url.replace(/^https?:\/\//, '').slice(0, 48)) : null,
    task.pr_url ? h('a', { href: task.pr_url, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 'sm'), 'PR') : null,
  ].filter(Boolean);
  return h('details', { class: 'card' },
    h('summary', {}, h('span', { class: 'key' }, task.key),
      h('div', { class: 'title' }, task.title, h('div', { class: 'meta' }, tags), links.length ? h('div', { class: 'links' }, links) : null)),
    h('div', { class: 'body' },
      mdEl(task.description),
      task.acceptance.length ? h('div', {}, h('div', { class: 'section-title' }, t('acceptance')),
        mdEl(task.acceptance.map((a) => `- [${task.state === 'done' ? 'x' : ' '}] ${a}`).join('\n'))) : null,
      frames.length ? h('div', { class: 'frames' }, frames.map((f) => {
        const src = `/api/calls/${d.call.id}/frames/${f}?t=${encodeURIComponent(TOKEN)}`;
        const fr = d.frames.find((x) => x.label === f);
        return h('a', { href: src, target: '_blank' }, h('img', { src, alt: f, loading: 'lazy' }), h('span', {}, `${f} · ${clock(fr?.t ?? 0)}`));
      })) : null));
}

function planPane() {
  const d = S.detail;
  const c = d.call;
  const p = d.plan;
  const col = h('div', { class: 'col' });
  const scroller = h('div', { class: 'scroll' }, col);
  if (!p) {
    if (c.status === 'processing') col.append(h('div', { class: 'empty' }, h('span', { class: 'spin' }), t('processingText')));
    else if (IN_MEETING.has(c.status)) col.append(h('div', { class: 'empty' }, t(c.status === 'joining' ? 'joiningText' : 'st_in_call')));
    else if (c.status === 'needs_plan') {
      col.append(h('div', { class: 'empty' },
        h('div', { class: 'big' }, t('readyToPlan')),
        S.state?.model.configured ? h('div', {}, t('autoPlan', { model: S.state.model.label })) : null,
        h('button', { class: 'btn primary', onclick: () => { location.hash = `#/m/${c.id}/chat`; setTimeout(() => chatSend(t('msug2'), c.id), 200); } }, icon('sparkle', 'sm'), t('buildPlan'))));
    } else col.append(h('div', { class: 'empty' }, c.error ?? t(`st_${c.status}`)));
    return scroller;
  }
  const pr = p.progress;
  col.append(
    h('div', { class: 'plan-head' }, h('h3', {}, p.title), h('div', { class: 'muted', style: 'font-size:13px' }, t('builtBy', { who: p.built_by }))),
    p.summary ? mdEl(p.summary) : null,
    pr.total ? h('div', { class: 'progress', title: `${pr.done}/${pr.total}` }, h('div', { style: `width:${Math.round((100 * pr.done) / pr.total)}%` })) : null,
    h('div', { class: 'm-actions' },
      p.tasks.some((x) => x.include && !['done', 'skipped'].includes(x.state))
        ? h('button', { class: 'btn primary', onclick: () => { location.hash = `#/m/${c.id}/chat`; setTimeout(() => chatSend(t('msug4'), c.id), 200); } }, icon('code', 'sm'), t('doTasks'))
        : null,
      h('button', { class: 'btn', onclick: deliver, id: 'btn-deliver2' }, icon('send', 'sm'), t('deliver'))),
  );
  if (p.tasks.length) {
    col.append(h('div', { class: 'row' }, h('div', { class: 'section-title' }, `${t('tasks')} · ${pr.done}/${pr.total}`),
      c.outputs?.tasks && ['webhook', 'agent'].includes(c.outputs.tasks) ? deliveryLine(p.deliveries?.tasks) : null));
    col.append(h('div', { class: 'cards' }, p.tasks.map((x) => taskCard(x, d))));
  }
  if (c.live_tasks?.length) {
    col.append(h('div', { class: 'section-title' }, t('createdLive')));
    col.append(mdEl(c.live_tasks.map((x) => `- ${x.title}${x.url ? ` — ${x.url}` : ''}`).join('\n')));
  }
  if (p.crm) {
    const k = p.crm;
    const kv = [];
    if (k.company) kv.push(h('div', { class: 'k' }, t('company')), h('div', {}, `${k.company.name}${k.company.domain ? ` (${k.company.domain})` : ''}`));
    if (k.contacts.length) kv.push(h('div', { class: 'k' }, t('contacts')), h('div', {}, k.contacts.map((x) => [x.name, x.role, x.email, x.phone].filter(Boolean).join(' · ')).join('\n')));
    if (k.deal) kv.push(h('div', { class: 'k' }, t('deal')), h('div', {}, [k.deal.name, k.deal.stage, k.deal.amount != null ? `${k.deal.amount}${k.deal.currency ? ` ${k.deal.currency}` : ''}` : null, k.deal.close_date].filter(Boolean).join(' · ')));
    col.append(h('div', { class: 'row' }, h('div', { class: 'section-title' }, t('crm')), deliveryLine(p.deliveries?.crm)),
      h('div', { class: 'card' }, h('div', { class: 'body', style: 'padding-top:14px' },
        kv.length ? h('div', { class: 'kv', style: 'white-space:pre-line' }, kv) : null,
        k.summary ? mdEl(k.summary) : null,
        k.next_steps.length ? h('div', {}, h('div', { class: 'section-title' }, t('nextSteps')), mdEl(k.next_steps.map((s) => `- ${s}`).join('\n'))) : null)));
  }
  if (p.doc) {
    col.append(h('div', { class: 'row' }, h('div', { class: 'section-title' }, t('doc')), deliveryLine(p.deliveries?.doc)),
      h('details', { class: 'card' }, h('summary', {}, icon('list', 'sm'), h('div', { class: 'title' }, p.doc.title || p.title)), h('div', { class: 'body' }, mdEl(p.doc.markdown))));
  }
  if (p.questions.length) {
    col.append(h('div', { class: 'section-title' }, t('questions')), mdEl(p.questions.map((q) => `- ${q}`).join('\n')));
  }
  if (c.notes?.length) {
    col.append(h('div', { class: 'section-title' }, t('notes')), mdEl(c.notes.map((n) => `- ${n.text.split('\n')[0]}`).join('\n')));
  }
  return scroller;
}

// ── Dialogs ─────────────────────────────────────────────────────────────────

function dialog(title, body, foot) {
  const dlg = $('#dialog');
  dlg.replaceChildren(h('form', { class: 'dlg', method: 'dialog' },
    h('div', { class: 'dlg-head' }, h('h2', {}, title), h('button', { type: 'button', class: 'icon-btn', onclick: () => dlg.close(), 'aria-label': 'Close' }, icon('x'))),
    h('div', { class: 'dlg-body' }, body),
    foot ? h('div', { class: 'dlg-foot' }, foot) : null));
  if (!dlg.open) dlg.showModal();
  return dlg;
}

function select(name, options, value) {
  return h('select', { class: 'input', name }, options.map(([v, label]) => h('option', { value: v, selected: v === (value ?? '') }, label)));
}

function openJoin(pre = {}) {
  const st = S.state;
  const def = st?.defaults ?? {};
  let act = def.act ?? 'after';
  const help = h('small', {}, t(`actHelp_${act}`));
  const brainHint = h('div', { class: 'banner hidden' }, icon('alert', 'sm'), t('noBrain'),
    st?.agent?.kind === 'claude' && st.agent.ready ? h('button', { type: 'button', class: 'btn blue', onclick: async () => { await useClaudeCode(); syncBrain(); } }, t('useClaude')) : null);
  const syncBrain = () => brainHint.classList.toggle('hidden', act === 'after' || !!S.state?.model.configured);
  const seg = h('div', { class: 'seg' }, ['after', 'during', 'both'].map((a) => h('button', {
    type: 'button', class: a === act ? 'on' : '',
    onclick: (e) => { act = a; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); help.textContent = t(`actHelp_${a}`); syncBrain(); },
  }, t(`act_${a}`))));
  const targets = (list) => [['none', t('none')], ...list.map((x) => [x, x])];
  const url = h('input', { class: 'input', name: 'url', placeholder: 'https://meet.google.com/abc-defg-hij', required: true, value: pre.url ?? '', autocomplete: 'off' });
  const dlg = dialog(t('joinTitle'), [
    h('label', { class: 'field' }, h('span', {}, t('link')), url),
    h('label', { class: 'field' }, h('span', {}, `${t('title')} (${t('optional')})`), h('input', { class: 'input', name: 'title', autocomplete: 'off' })),
    h('div', { class: 'field' }, h('span', {}, t('whenActs')), seg, help),
    brainHint,
    h('div', { class: 'grid3' },
      h('label', { class: 'field' }, h('span', {}, t('tasksTo')), select('tasks', targets(st?.targets.tasks ?? []), def.tasks ?? 'none')),
      h('label', { class: 'field' }, h('span', {}, t('crmTo')), select('crm', targets(st?.targets.crm ?? []), def.crm ?? 'none')),
      h('label', { class: 'field' }, h('span', {}, t('docTo')), select('doc', targets(st?.targets.doc ?? []), def.doc ?? 'none'))),
    h('label', { class: 'field' }, h('span', {}, t('autonomy')), select('autonomy', [['suggest', t('au_suggest')], ['issues', t('au_issues')], ['prs', t('au_prs')]], def.autonomy)),
    h('details', { class: 'more' }, h('summary', {}, t('more')),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', {}, t('repo')), h('input', { class: 'input', name: 'repo', placeholder: 'acme/app', autocomplete: 'off' })),
        h('label', { class: 'field' }, h('span', {}, t('workdir')), h('input', { class: 'input', name: 'workdir', value: def.workdir ?? '', autocomplete: 'off' })))),
  ], [
    h('button', { type: 'button', class: 'btn', onclick: () => $('#dialog').close() }, t('cancel')),
    h('button', { type: 'submit', class: 'btn primary', id: 'join-go' }, icon('video', 'sm'), t('join')),
  ]);
  syncBrain();
  const form = $('form', dlg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const go = $('#join-go');
    go.disabled = true;
    try {
      const d = await api('POST', '/api/calls', {
        url: f.get('url'), title: f.get('title'), act, autonomy: f.get('autonomy'),
        tasks: f.get('tasks'), crm: f.get('crm'), doc: f.get('doc'), repo: f.get('repo'), workdir: f.get('workdir'),
      });
      dlg.close();
      await loadCalls();
      location.hash = `#/m/${d.call.id}/live`;
    } catch (err) { toast(err.message, true); go.disabled = false; }
  });
  setTimeout(() => (pre.url ? $('input[name=title]', dlg) : url).focus(), 0);
}

async function openSetup() {
  S.state = await api('GET', '/api/state').catch(() => S.state);
  const st = S.state;
  const def = st.defaults;
  const ag = st.agent;
  const machine = h('div', { class: 'checks' }, h('div', { class: 'muted' }, t('checking')));
  const model = st.model;
  const aiBox = h('div', { class: 'box' },
    h('h4', {}, t('localAi')),
    h('div', { class: 'row' }, h('span', {}, t('chatAgent')), h('span', { class: ag.ready ? '' : 'muted' }, `${ag.label} · ${ag.detail}`)),
    h('div', { class: 'row' }, h('span', {}, t('plansAnswers')),
      model.configured
        ? h('span', {}, model.label, model.provider === 'claude-code' ? h('button', { type: 'button', class: 'btn', style: 'margin-left:10px', onclick: () => setModel('') }, t('stopUsing')) : null)
        : h('span', {}, ag.kind === 'claude' && ag.ready ? h('button', { type: 'button', class: 'btn blue', onclick: () => setModel('claude-code') }, t('useClaudeCode')) : t('notSet'))),
    !model.configured ? h('small', { class: 'muted' }, t('notSet')) : null);
  const targets = (list) => [['none', t('none')], ...list.map((x) => [x, x])];
  const defaults = h('div', { class: 'box' },
    h('h4', {}, t('defaults')),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, t('whenActs')), select('OMA_ACT', [['after', t('act_after')], ['during', t('act_during')], ['both', t('act_both')]], def.act)),
      h('label', { class: 'field' }, h('span', {}, t('autonomy')), select('OMA_AUTONOMY', [['suggest', t('au_suggest')], ['issues', t('au_issues')], ['prs', t('au_prs')]], def.autonomy))),
    h('div', { class: 'grid3' },
      h('label', { class: 'field' }, h('span', {}, t('tasksTo')), select('OMA_TASKS_TARGET', targets(st.targets.tasks), def.tasks ?? 'none')),
      h('label', { class: 'field' }, h('span', {}, t('crmTo')), select('OMA_CRM_TARGET', targets(st.targets.crm), def.crm ?? 'none')),
      h('label', { class: 'field' }, h('span', {}, t('docTo')), select('OMA_DOC_TARGET', targets(st.targets.doc), def.doc ?? 'none'))),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, t('agentName')), h('input', { class: 'input', name: 'OMA_AGENT_NAME', value: def.agent_name })),
      h('label', { class: 'field' }, h('span', {}, t('language')), select('OMA_LANGUAGE', [['en', 'English'], ['pt', 'Português'], ['es', 'Español']], def.language))),
    h('label', { class: 'field' }, h('span', {}, t('workdir')), h('input', { class: 'input', name: 'OMA_UI_WORKDIR', value: def.workdir })),
    h('div', {}, h('button', { type: 'submit', class: 'btn primary' }, t('save'))));
  const dlg = dialog(t('setup'), [
    aiBox, defaults,
    h('div', { class: 'box' }, h('h4', {}, t('machine')), machine),
    h('small', { class: 'muted' }, t('secrets', { file: `${st.home}/config.json` })),
  ]);
  $('form', dlg).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const changes = {};
    for (const k of ['OMA_ACT', 'OMA_AUTONOMY', 'OMA_TASKS_TARGET', 'OMA_CRM_TARGET', 'OMA_DOC_TARGET', 'OMA_AGENT_NAME', 'OMA_LANGUAGE', 'OMA_UI_WORKDIR']) changes[k] = f.get(k) ?? '';
    try {
      const r = await api('POST', '/api/config', changes);
      S.state = await api('GET', '/api/state');
      toast(r.warnings?.length ? r.warnings.join('; ') : t('saved'), !!r.warnings?.length);
      dlg.close();
    } catch (err) { toast(err.message, true); }
  });
  try {
    const r = await api('GET', '/api/setup');
    machine.replaceChildren(...r.text.split('\n').map((line) => {
      const m = line.match(/^([✓✗·]|\s)\s?(.*)$/);
      const s = m?.[1] ?? ' ';
      return h('div', { class: 'check' }, h('span', { class: `s ${s === '✓' ? 'ok' : s === '✗' ? 'bad' : 'na'}` }, s.trim()), h('span', {}, m?.[2] ?? line));
    }));
  } catch (e) { machine.replaceChildren(h('div', { class: 'muted' }, e.message)); }
}

async function setModel(provider) {
  try {
    await api('POST', '/api/config', { OMA_LLM_PROVIDER: provider });
    toast(t('saved'));
    openSetup();
  } catch (e) { toast(e.message, true); }
}

function openSearch() {
  const input = h('input', { class: 'input', placeholder: t('searchPlaceholder'), autocomplete: 'off' });
  const results = h('div', { class: 'search-results' });
  const draw = () => {
    const q = fold(input.value);
    const hit = (s) => !q || fold(s).includes(q);
    const items = [
      ...S.calls.filter((c) => hit(c.title)).map((c) => h('a', { class: 'sb-item', href: `#/m/${c.id}`, onclick: () => $('#dialog').close() }, h('span', { class: `dot ${c.status}` }), h('span', { class: 'label' }, c.title), h('span', { class: 'when' }, ago(c.created_at)))),
      ...S.chats.filter((c) => !c.call_id && hit(c.title)).map((c) => h('a', { class: 'sb-item', href: `#/c/${c.id}`, onclick: () => $('#dialog').close() }, icon('message', 'sm'), h('span', { class: 'label' }, c.title || t('newChat')), h('span', { class: 'when' }, ago(c.updated_at)))),
    ];
    results.replaceChildren(...(items.length ? items.slice(0, 40) : [h('div', { class: 'sb-empty' }, t('nothingFound'))]));
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); results.querySelector('a')?.click(); } });
  dialog(t('search'), [input, results]);
  draw();
  setTimeout(() => input.focus(), 0);
}

// ── Loading, events, routing ────────────────────────────────────────────────

async function loadCalls() { S.calls = await api('GET', '/api/calls').catch(() => S.calls); renderSidebar(); renderTopbar(); }
async function loadChats() { S.chats = await api('GET', '/api/chats').catch(() => S.chats); renderSidebar(); }

function connectEvents() {
  const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
  es.addEventListener('calls', (e) => {
    S.calls = JSON.parse(e.data);
    renderSidebar();
    renderTopbar();
    if (S.route.name === 'meeting') refreshMeeting();
  });
  es.addEventListener('call', (e) => {
    const { id } = JSON.parse(e.data);
    if (S.route.name === 'meeting' && S.detail?.call.id === id) refreshMeeting();
  });
  es.addEventListener('chat', (e) => onChatEvent(JSON.parse(e.data)));
  es.onerror = () => {
    if (es.readyState !== EventSource.CLOSED) return;
    $('#toasts').replaceChildren(h('div', { class: 'toast error' }, t('lost'), ' ', h('button', { style: 'text-decoration:underline', onclick: () => location.reload() }, t('reload'))));
  };
}

async function route() {
  const p = location.hash.replace(/^#\/?/, '').split('/');
  const prev = S.route;
  S.route = p[0] === 'c' && p[1] ? { name: 'chat', id: p[1] } : p[0] === 'm' && p[1] ? { name: 'meeting', id: p[1], tab: p[2] || null } : { name: 'home' };
  closeMenus();
  if (window.innerWidth <= 760) document.body.classList.add('collapsed');
  if (S.route.name === 'meeting') {
    if (prev.name === 'meeting' && prev.id === S.route.id && S.detail) {
      S.tab = S.route.tab || S.tab;
      if (S.tab === 'chat' && S.detail.chat_id && !S.chat) S.chat = await api('GET', `/api/chats/${S.detail.chat_id}`).catch(() => null);
      renderMeeting();
    } else await openMeeting(S.route.id, S.route.tab);
  } else if (S.route.name === 'chat') {
    await openChat(S.route.id);
  } else {
    S.chat = null;
    S.detail = null;
    renderHome();
  }
  renderSidebar();
  renderTopbar();
}

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); location.hash = '#/'; }
  if (e.key === 'Escape') closeMenus();
});
$('#scrim').addEventListener('click', toggleSidebar);
window.addEventListener('hashchange', route);

(async function main() {
  if (localStorage.getItem('oma.collapsed') === '1' || window.innerWidth <= 760) document.body.classList.add('collapsed');
  try {
    S.state = await api('GET', '/api/state');
  } catch (e) {
    $('#view').replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'big' }, t('lost')), e.message));
    return;
  }
  [S.calls, S.chats] = await Promise.all([api('GET', '/api/calls'), api('GET', '/api/chats')]);
  connectEvents();
  await route();
})();
