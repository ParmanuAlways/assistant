import { browser } from 'wxt/browser';
import { runTask, type Confirmation, type PickedFile } from '../../lib/agent';
import { act, snapshot } from '../../lib/page';
import { api, ApiError } from '../../lib/api';
import { getConfig, type CommsSource } from '../../lib/config';
import { getAccessToken, login, logout } from '../../lib/auth';
import { describeEvent, startRecording, stopRecording, type TeachEvent } from '../../lib/teach';
import { esc, renderTimeline } from '../../lib/timeline';
import { targetTab } from '../../lib/agent';
import { loadLetters } from './letters';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let me: { name: string; emp_id: string; roles: string[] } | null = null;
let stopped = false;

// ---------------------------------------------------------------- sign in / out

async function showSignedIn() {
  try {
    me = await api('/api/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return showSignedOut();
    throw e;
  }
  $('signed-out').hidden = true;
  $('signed-in').hidden = false;
  $('user-name').textContent = me!.name;
  $('user-emp').textContent = me!.emp_id;
  const roles = me!.roles.filter((r) => ['auditor', 'admin'].includes(r));
  $('user-roles').textContent = roles.length ? `· ${roles.join(', ')}` : '';
  $('audit-btn').hidden = !me!.roles.includes('auditor');
  $('avatar').textContent = me!.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const h = new Date().getHours();
  $('greeting-text').textContent = `${h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'}, ${me!.name.split(' ')[0]}`;
  loadHome();
  api('/api/settings').then((st: any) => ($('model-status').textContent = `${st.active.model} · on-prem`)).catch(() => {});
}

function showSignedOut(msg = '') {
  me = null;
  $('signed-in').hidden = true;
  $('signed-out').hidden = false;
  $('login-error').textContent = msg;
}

$('login-btn').onclick = async () => {
  try {
    await login();
    await showSignedIn();
  } catch (e: any) {
    showSignedOut(e.message);
  }
};
$('logout-btn').onclick = async () => {
  await logout();
  $('log').innerHTML = '';
  thread().classList.remove('has-messages');
  showSignedOut();
};
$('audit-btn').onclick = () => browser.tabs.create({ url: browser.runtime.getURL('/audit.html') });

// ---------------------------------------------------------------- tabs

document.querySelectorAll<HTMLButtonElement>('nav button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll<HTMLElement>('.tab').forEach((t) => (t.hidden = t.id !== `tab-${b.dataset.tab}`));
    if (b.dataset.tab === 'history') loadHistory();
    if (b.dataset.tab === 'profile') loadProfile();
    if (b.dataset.tab === 'settings') loadSettings();
    if (b.dataset.tab === 'teach') loadPlaybooks();
    if (b.dataset.tab === 'comms') openComms();
    if (b.dataset.tab === 'letters') loadLetters();
  };
});

// ---------------------------------------------------------------- assistant

const SUGGESTIONS = [
  ['🌴', 'Apply for leave', 'Apply casual leave for 3 days from Monday, reason: family function'],
  ['🛠️', 'Raise an IT ticket', 'Raise an IT ticket: my laptop screen keeps flickering. It is urgent.'],
  ['📅', 'Book a meeting room', 'Book a meeting room for 6 people tomorrow from 3 pm to 4 pm for Sprint planning.'],
  ['✈️', 'Request travel', 'In the Legacy ERP, raise a travel request to Pune from 21 Oct 2026 to 23 Oct 2026 for a client visit.'],
  ['📨', 'Find a communication', 'Find the letters I sent to Priya about leave'],
];

// ---------------------------------------------------------------- home screen (first thing after sign-in)

const TILE_COLORS = ['#4f46e5', '#0891b2', '#16a34a', '#ea580c', '#db2777', '#7c3aed', '#0f766e', '#b45309'];
const ICON_FOR = (text: string) =>
  /leave|holiday|vacation/i.test(text) ? '🌴' : /ticket|laptop|it |vpn|printer/i.test(text) ? '🛠️' : /room|meeting/i.test(text) ? '📅' :
  /travel|trip/i.test(text) ? '✈️' : /expense|claim|reimburse/i.test(text) ? '🧾' : /visitor/i.test(text) ? '🪪' :
  /food|lunch|order|canteen/i.test(text) ? '🍱' : /mail|email|reply|forward/i.test(text) ? '✉️' : /approve|purchase|po-/i.test(text) ? '✅' : '✦';

function usePrompt(text: string) {
  const t = $<HTMLTextAreaElement>('prompt');
  t.value = text;
  autogrow();
  t.focus();
}

async function loadHome() {
  let home: any = { links: [], frequent: [], recent: [] };
  try {
    home = await api('/api/home');
  } catch {}
  // Your apps: the user's own shortcuts, opened as normal pages (no assistant involved)
  $('apps').innerHTML = home.links.map((l: any, i: number) => {
    const color = TILE_COLORS[[...l.title].reduce((a: number, c: string) => a + c.charCodeAt(0), i) % TILE_COLORS.length];
    return `<a class="app" href="${esc(l.url)}" data-url="${esc(l.url)}" title="${esc(l.url)}">` +
      `<span class="tile" style="background:${color}">${esc(l.title.trim()[0]?.toUpperCase() || '•')}</span><span class="nm">${esc(l.title)}</span>` +
      `<span class="x" data-del="${l.id}" title="Remove">×</span></a>`;
  }).join('') + '<button type="button" class="app add" id="add-tile"><span class="tile">+</span><span class="nm">Add app</span></button>';
  $('apps').querySelectorAll<HTMLAnchorElement>('a.app').forEach((a) => {
    a.onclick = async (e) => {
      e.preventDefault();
      const del = (e.target as HTMLElement).closest<HTMLElement>('[data-del]');
      if (del) {
        await api(`/api/links/${del.dataset.del}`, 'DELETE');
        return loadHome();
      }
      await browser.tabs.create({ url: a.dataset.url!, active: true });
    };
  });
  $('add-tile').onclick = () => toggleLinkForm(true);
  // What you usually do (from your history), else a few things to try
  const frequent = home.frequent.filter((f: any) => f.done > 0 || f.count > 1);
  $('frequent-title').textContent = frequent.length ? 'You often' : 'Try asking';
  const items: [string, string, string][] = frequent.length
    ? frequent.map((f: any) => [ICON_FOR(f.prompt), f.prompt, f.count > 1 ? `${f.count}×` : ''])
    : SUGGESTIONS.map(([em, , prompt]) => [em, prompt, '']);
  $('suggestions').innerHTML = items.map(([em, prompt, count], i) =>
    `<button type="button" class="suggestion" data-i="${i}"><span class="em">${em}</span><div><b>${esc(prompt.length > 70 ? prompt.slice(0, 70) + '…' : prompt)}</b></div>` +
    (count ? `<span class="count">${esc(count)}</span>` : '') + '</button>').join('');
  $('suggestions').querySelectorAll<HTMLButtonElement>('.suggestion').forEach((b) => {
    b.onclick = () => usePrompt(items[Number(b.dataset.i)][1]);
  });
  // Recent tasks
  $('recent-section').hidden = !home.recent.length;
  $('recent').innerHTML = home.recent.slice(0, 3).map((t: any) => {
    const icon = ({ completed: '✓', failed: '✕', cancelled: '✋', unverified: '!', running: '…' } as any)[t.status] || '•';
    return `<div class="task" data-prompt="${esc(t.prompt)}"><span class="st ${esc(t.status)}">${icon}</span><div><div class="p">${esc(t.prompt)}</div>` +
      `<div class="s">${esc(t.started_at.slice(0, 16).replace('T', ' '))} · ${esc(t.summary || t.status)}</div></div></div>`;
  }).join('');
  $('recent').querySelectorAll<HTMLElement>('.task').forEach((el) => (el.onclick = () => usePrompt(el.dataset.prompt!)));
}

function toggleLinkForm(show = $('link-form').hidden) {
  $('link-form').hidden = !show;
  $('link-msg').textContent = '';
  if (show) $<HTMLInputElement>('link-title').focus();
}
$('add-link-btn').onclick = () => toggleLinkForm();
$('link-current').onclick = async () => {   // save the page that is open in the browser
  const tab = await targetTab();
  if (!tab?.url) return;
  $<HTMLInputElement>('link-url').value = tab.url;
  $<HTMLInputElement>('link-title').value = (tab.title || '').split(/[–|-]/)[0].trim().slice(0, 40);
};
$('link-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/links', 'POST', { title: $<HTMLInputElement>('link-title').value, url: $<HTMLInputElement>('link-url').value });
    $<HTMLInputElement>('link-title').value = $<HTMLInputElement>('link-url').value = '';
    toggleLinkForm(false);
    await loadHome();
    if (!r.assistant_can_use) {
      $('link-form').hidden = false;
      $('link-msg').textContent = 'Saved. You can open it, but the assistant may not work on it (not an approved site).';
    }
  } catch (err: any) {
    $('link-msg').textContent = err.message;
  }
};
document.querySelectorAll<HTMLElement>('[data-goto]').forEach((b) => {
  b.onclick = () => document.querySelector<HTMLButtonElement>(`nav button[data-tab=${b.dataset.goto}]`)!.click();
});
$('home-btn').onclick = () => {   // back to the home screen (a fresh conversation)
  if (document.body.dataset.agent === 'running') return;
  $('log').innerHTML = '';
  thread().classList.remove('has-messages');
  $('home-btn').hidden = true;
  loadHome();
};

const thread = () => $('thread');
const scrollDown = () => requestAnimationFrame(() => (thread().scrollTop = thread().scrollHeight));

function addRow(html: string, cls: string) {
  const row = document.createElement('div');
  row.className = cls;
  row.innerHTML = html;
  $('log').appendChild(row);
  thread().classList.add('has-messages');
  $('home-btn').hidden = false;
  scrollDown();
  return row;
}

// One "working" card per stretch of work; a question or approval from the user starts a new one
interface Work { card: HTMLElement; steps: HTMLElement; title: HTMLElement; meta: HTMLElement; start: number; count: number }
let work: Work | null = null;
let model = '';
let pendingThought = '';

const ICONS: [RegExp, string][] = [
  [/^Click at/, '🎯'], [/^Click/, '👆'], [/^Type|^Fill in/, '⌨️'], [/^Choose/, '☰'], [/^Pick/, '📅'], [/^Open the menu/, '☰'],
  [/^Open/, '🌐'], [/^Find/, '🔎'], [/^Attach/, '📎'], [/^Site asked/, '💬'],
];

function startWork() {
  const row = addRow(`<span class="mark sm busy"></span><div class="work"><div class="work-head"><span class="spinner"></span>` +
    `<span class="tick">✓</span><span class="title shimmer">Working on it…</span><span class="meta"></span><span class="chev">▾</span></div>` +
    `<ul class="steps"></ul></div>`, 'row-assistant');
  const card = row.querySelector<HTMLElement>('.work')!;
  card.querySelector<HTMLElement>('.work-head')!.onclick = () => card.classList.toggle('collapsed');
  work = { card, steps: card.querySelector('.steps')!, title: card.querySelector('.title')!, meta: card.querySelector('.meta')!,
           start: Date.now(), count: 0 };
  work.meta.textContent = model;
  return work;
}

function settleWork(state: 'paused' | 'success' | 'failed') {
  if (!work) return;
  const secs = Math.round((Date.now() - work.start) / 1000);
  const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  work.card.classList.add('done', state === 'failed' ? 'failed' : 'success');
  work.card.classList.add('collapsed');   // open it again with a click
  work.card.parentElement!.querySelector('.mark')!.classList.remove('busy');
  work.title.classList.remove('shimmer');
  work.title.textContent = `${state === 'failed' ? 'Stopped' : 'Worked'} · ${work.count} step${work.count === 1 ? '' : 's'}`;
  work.meta.textContent = took;
  work.steps.querySelectorAll('.current').forEach((x) => x.classList.remove('current'));
  work = null;
}

function addStep(text: string, kind: string) {
  const w = work || startWork();
  w.steps.querySelectorAll('.current').forEach((x) => x.classList.remove('current'));
  const li = document.createElement('li');
  const icon = kind === 'info' ? '💭' : kind === 'error' ? '!' : ICONS.find(([re]) => re.test(text))?.[1] || '•';
  li.className = kind === 'info' ? 'thought' : kind === 'error' ? 'error' : 'action current';
  li.innerHTML = `<span class="si">${icon}</span><span class="txt"></span>`;
  li.querySelector('.txt')!.textContent = text;
  w.steps.appendChild(li);
  if (kind === 'action') w.count++;
  w.steps.scrollTop = w.steps.scrollHeight;
  scrollDown();
}

/** The agent's progress messages (lib/agent.ts AgentUI.step), as a conversation. */
function log(text: string, kind = 'info') {
  if (kind === 'user') {
    settleWork('paused');
    addRow('<div class="bubble"></div>', 'row-user').querySelector('.bubble')!.textContent = text;
    return;
  }
  const m = text.match(/^Task started · model: (.*)$/);
  if (m) {
    model = m[1];
    if (work) work.meta.textContent = model;
    return;
  }
  if (kind === 'ok') return;   // the final summary is shown by finishTask
  addStep(text, kind);
}

/** The result of a task: close the working card and answer in a bubble. */
function finishTask(status: string, summary: string) {
  settleWork(status === 'completed' ? 'success' : 'failed');
  const ok = status === 'completed';
  const head = ok ? '✅ Done' : status === 'unverified' ? '⚠️ Please check' : status === 'cancelled' ? '✋ Stopped' : '❌ I couldn’t finish';
  const html = esc(summary || '').replace(/\b([A-Z]{2,4}-\d{3,})\b/g, '<span class="ref">$1</span>');
  addRow(`<span class="mark sm"></span><div class="bubble result ${ok ? 'ok' : 'error'}"><div class="result-head">${head}</div>${html}</div>`,
         'row-assistant');
}

function ask(question: string, options?: string[], isUserAction?: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    $('ask-box').hidden = false;
    $('ask-question').textContent = question;
    const input = $<HTMLInputElement>('ask-input');
    input.value = '';
    input.hidden = !!isUserAction || !!options?.length;
    $('ask-file').hidden = true;
    $('ask-send').textContent = isUserAction ? 'Continue' : 'Send';
    $('ask-send').hidden = !!options?.length;
    $('ask-options').innerHTML = '';
    const finish = (v: string | null) => {
      $('ask-box').hidden = true;
      if (v !== null) log(v || '(continued)', 'user');
      resolve(v);
    };
    settleWork('paused');
    for (const o of options || []) {
      const b = document.createElement('button');
      b.textContent = o;
      b.onclick = () => finish(o);
      $('ask-options').appendChild(b);
    }
    $('ask-send').onclick = () => finish(isUserAction ? 'done' : input.value.trim());
    input.onkeydown = (e) => e.key === 'Enter' && finish(input.value.trim());
    $('ask-cancel').onclick = () => finish(null);
    if (!input.hidden) input.focus();
    scrollDown();
  });
}

// The assistant needs a file from the user's computer (it can never read files by itself)
function askFile(question: string): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    $('ask-box').hidden = false;
    $('ask-question').textContent = question;
    $('ask-input').hidden = true;
    $('ask-options').innerHTML = '';
    const file = $<HTMLInputElement>('ask-file');
    file.value = '';
    file.hidden = false;
    $('ask-send').hidden = false;
    $('ask-send').textContent = 'Attach';
    const finish = (v: PickedFile | null) => {
      $('ask-box').hidden = true;
      file.hidden = true;
      log(v ? `Attached ${v.name}` : 'No file attached', 'user');
      resolve(v);
    };
    $('ask-send').onclick = async () => {
      const f = file.files?.[0];
      if (!f) return finish(null);
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      finish({ name: f.name, type: f.type, data: btoa(bin) });
    };
    $('ask-cancel').onclick = () => finish(null);
  });
}

function confirmSubmit(c: Confirmation): Promise<boolean> {
  return new Promise((resolve) => {
    $('confirm-box').hidden = false;
    $('confirm-warning').hidden = !c.warning;
    $('confirm-warning').textContent = c.warning ? `⚠ ${c.warning}` : '';
    $('confirm-checks').hidden = !c.checks?.length;
    $('confirm-checks').innerHTML = (c.checks || []).map((x) => `<li>${esc(x)}</li>`).join('');
    // Where each value came from, so a guessed value stands out
    const kind = (src = '') => /request/.test(src) ? 's-request' : /profile/.test(src) ? 's-profile' : /told me/.test(src) ? 's-told' : '';
    $('confirm-button').textContent = `“${c.button}”`;
    $('confirm-table').innerHTML = c.fields.map((f) => `<tr><th>${esc(f.label)}</th><td>${esc(f.value)}` +
      (f.source ? `<br><span class="src ${f.guess ? 'guess' : kind(f.source)}">${f.guess ? '⚠ ' : ''}${esc(f.source)}</span>` : '') +
      '</td></tr>').join('');
    scrollDown();
    const done = (v: boolean) => {
      $('confirm-box').hidden = true;
      log(v ? `Yes, submit ${c.button ? `“${c.button}”` : ''}` : 'Don’t submit', 'user');
      resolve(v);
    };
    $('confirm-yes').onclick = () => done(true);
    $('confirm-no').onclick = () => done(false);
  });
}

$('prompt-form').onsubmit = async (e) => {
  e.preventDefault();
  const prompt = $<HTMLTextAreaElement>('prompt').value.trim();
  if (!prompt) return;
  $<HTMLTextAreaElement>('prompt').value = '';
  autogrow();
  log(prompt, 'user');
  if (COMMS_SEARCH.test(prompt) && COMMS_WORDS.test(prompt)) {   // a search, not a task: no need to drive the browser
    await answerCommsSearch(prompt);
    return;
  }
  stopped = false;
  $('run-btn').hidden = true;
  $('stop-btn').hidden = false;
  document.body.dataset.agent = 'running';
  startWork();
  const result = await runTask(prompt, { step: log, ask, askFile, confirm: confirmSubmit, isStopped: () => stopped });
  finishTask(result.status, result.summary);
  document.body.dataset.agent = result.status;
  $('run-btn').hidden = false;
  $('stop-btn').hidden = true;
};
$('stop-btn').onclick = () => (stopped = true);

// Composer: grows with the text; Enter sends, Shift+Enter adds a line
function autogrow() {
  const t = $<HTMLTextAreaElement>('prompt');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 140)}px`;
}
$('prompt').addEventListener('input', autogrow);
$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !$('run-btn').hidden) {
    e.preventDefault();
    $<HTMLFormElement>('prompt-form').requestSubmit();
  }
});

// ---------------------------------------------------------------- communications

const comms = { q: '', dir: '', folder: '', lastSync: 0 };
const COMM_ICON: Record<string, string> = { Letter: '✉️', Note: '📝', Circular: '📢', 'E-mail': '📧' };

// The office app's list, read as the user: directly (the extension may use the user's session for sites it is
// allowed on), else from inside an open tab of that site
async function readAsUser(src: CommsSource): Promise<any[] | null> {
  try {
    const r = await fetch(src.listUrl, { credentials: 'include' });
    if (r.ok) return await r.json();
  } catch {}
  const origin = new URL(src.listUrl).origin;
  for (const t of await browser.tabs.query({ url: `${origin}/*` })) {
    const [res] = await browser.scripting.executeScript({
      target: { tabId: t.id! },
      func: async (u: string) => {
        const x = await fetch(u, { credentials: 'include' });
        return x.ok ? await x.json() : null;
      },
      args: [src.listUrl],
    }).catch(() => [null as any]);
    if (res?.result) return res.result;
  }
  return null;
}

async function syncComms() {
  $('comms-info').textContent = 'Reading your communications…';
  const problems: string[] = [];
  let total = 0;
  for (const src of (await getConfig()).commsSources) {
    const items = await readAsUser(src);
    if (!items) {
      problems.push(src.name);
      continue;
    }
    total += (await api('/api/comms/sync', 'POST', { source: src.name, items })).synced;
  }
  comms.lastSync = Date.now();
  await searchComms();
  if (problems.length) {
    const src = (await getConfig()).commsSources.find((x) => x.name === problems[0])!;
    $('comms-info').innerHTML = `Sign in to <a href="#" id="comms-signin">${esc(problems.join(', '))}</a> so I can read your communications, ` +
      'then press ↻ Update.';
    $('comms-signin').onclick = (e) => {
      e.preventDefault();
      browser.tabs.create({ url: src.signInUrl });
    };
  } else if (total) {
    $('comms-info').dataset.synced = `Updated just now · ${total} items`;
  }
}

function commCard(c: any) {
  const snip = esc(c.snip || '').replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');
  const who = c.direction === 'sent' ? `to ${c.recipients}` : `from ${c.sender}`;
  const day = new Date(c.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return `<a class="comm" data-url="${esc(c.url)}" href="${esc(c.url)}">` +
    `<div class="l1"><span class="dir ${c.direction}">${c.direction === 'sent' ? '↗ Sent' : '↙ Received'}</span>` +
    `<span class="ty">${COMM_ICON[c.type] || '•'} ${esc(c.type)}</span><span>${esc(c.folder)}</span><span class="dt">${esc(day)}</span></div>` +
    `<div class="sj">${esc(c.subject)}</div><div class="sn">${esc(who)} — ${snip}</div>` +
    `<div class="rf">${esc(c.ref)}${c.attachments?.length ? ` · 📎 ${esc(c.attachments.join(', '))}` : ''}</div></a>`;
}

function wireCards(root: HTMLElement) {
  root.querySelectorAll<HTMLAnchorElement>('.comm').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      if (a.dataset.url) browser.tabs.create({ url: a.dataset.url, active: true });   // open it in the office app
    };
  });
}

function filterPills(qf: any) {
  const p: string[] = [];
  if (qf.direction) p.push(qf.direction === 'sent' ? 'sent by you' : 'received');
  if (qf.type) p.push(qf.type);
  if (qf.to) p.push(`to: ${qf.to}`);
  if (qf.from) p.push(`from: ${qf.from}`);
  if (qf.after || qf.before) p.push(qf.after === qf.before ? qf.after : `${qf.after || '…'} → ${qf.before || 'now'}`);
  for (const t of qf.terms || []) p.push(`“${t}”`);
  return p.length ? `<div class="pills">${p.map((x) => `<span class="pill">${esc(x)}</span>`).join('')}</div>` : '';
}

async function searchComms() {
  const params = new URLSearchParams({ q: comms.q, folder: comms.folder, direction: comms.dir });
  const r = await api<any>(`/api/comms/search?${params}`);
  $('n-sent').textContent = r.sent ? String(r.sent) : '';
  $('n-received').textContent = r.received ? String(r.received) : '';
  const all = Object.values(r.folders as Record<string, number>).reduce((a, b) => a + b, 0);
  $('comms-folders').innerHTML = `<button type="button" class="folder ${comms.folder ? '' : 'on'}" data-f="">All<b>${all}</b></button>` +
    Object.entries(r.folders as Record<string, number>).filter(([, n]) => n > 0)
      .map(([f, n]) => `<button type="button" class="folder ${comms.folder === f ? 'on' : ''}" data-f="${esc(f)}">${esc(f)}<b>${n}</b></button>`).join('');
  $('comms-folders').querySelectorAll<HTMLButtonElement>('.folder').forEach((b) => {
    b.onclick = () => {
      comms.folder = b.dataset.f || '';
      searchComms();
    };
  });
  if (!all) {
    $('comms-results').innerHTML = '<div class="empty">📭<br>No communications yet.<br><span class="small">Press ↻ Update to read them from your office apps.</span></div>';
    return;
  }
  const head = `${r.results.length}${r.results.length >= 30 ? '+' : ''} ${r.results.length === 1 ? 'result' : 'results'}` +
    (r.relaxed ? ' · nothing in that period, showing other dates' : r.match === 'any word' ? ' · showing close matches' : '') +
    ($('comms-info').dataset.synced ? ` · ${$('comms-info').dataset.synced}` : '');
  $('comms-info').innerHTML = esc(head) + (comms.q ? filterPills(r.query) : '');
  $('comms-results').innerHTML = r.results.length ? r.results.map(commCard).join('')
    : '<div class="empty">Nothing found. Try fewer words, or another folder.</div>';
  wireCards($('comms-results'));
}

let commsTimer: any;
$('comms-q').addEventListener('input', () => {
  clearTimeout(commsTimer);
  commsTimer = setTimeout(() => {
    comms.q = $<HTMLInputElement>('comms-q').value.trim();
    searchComms();
  }, 200);
});
$('comms-dir').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
  b.onclick = () => {
    comms.dir = b.dataset.dir || '';
    $('comms-dir').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    searchComms();
  };
});
$('comms-sync').onclick = () => syncComms();

async function openComms(q?: string) {
  if (q !== undefined) {
    comms.q = q;
    $<HTMLInputElement>('comms-q').value = q;
  }
  if (Date.now() - comms.lastSync > 10 * 60 * 1000) await syncComms();   // keep it fresh when the tab is opened
  else await searchComms();
}

// "find the letter I sent to Priya about leave" in the chat: answer from the communications index
const COMMS_SEARCH = /^\s*(find|search|show|look up|where is|list|which)\b/i;
const COMMS_WORDS = /\b(letters?|notes?|circulars?|e-?mails?|mails?|memos?|communications?|sent|received)\b/i;
async function answerCommsSearch(prompt: string) {
  if (Date.now() - comms.lastSync > 10 * 60 * 1000) await syncComms().catch(() => {});
  const r = await api<any>(`/api/comms/search?${new URLSearchParams({ q: prompt })}`);
  const top = r.results.slice(0, 4);
  const intro = top.length ? `I found ${r.results.length}${r.results.length >= 30 ? '+' : ''} in your communications` +
    (r.relaxed ? ' (none in that period, so here are other dates)' : '') + ':' : 'I couldn’t find anything like that in your communications.';
  const row = addRow(`<span class="mark sm"></span><div class="bubble comm-results-bubble"><div>${esc(intro)}</div>${filterPills(r.query)}` +
    `${top.map(commCard).join('')}${r.results.length > top.length ? '<button type="button" class="link small see-all">See all in Communications →</button>' : ''}</div>`,
    'row-assistant');
  wireCards(row);
  row.querySelector<HTMLButtonElement>('.see-all')?.addEventListener('click', () => {
    document.querySelector<HTMLButtonElement>('nav button[data-tab=comms]')!.click();
    openComms(prompt);
  });
}

// ---------------------------------------------------------------- history

async function loadHistory() {
  $('history-detail').hidden = true;
  const tasks = await api<any[]>('/api/history');
  $('history-list').innerHTML = tasks.length
    ? tasks.map((t) => {
        const icon = ({ completed: '✓', failed: '✕', cancelled: '✋', unverified: '!', running: '…' } as any)[t.status] || '•';
        return `<div class="task" data-id="${t.task_id}"><span class="st ${esc(t.status)}">${icon}</span><div>` +
          `<div class="p">${esc(t.prompt)}</div><div class="s">${esc(t.started_at.slice(0, 16).replace('T', ' '))} · ` +
          `<span class="badge ${esc(t.status)}">${esc(t.status)}</span> ${esc(t.summary || '')}</div></div></div>`;
      }).join('')
    : '<p class="muted">No tasks yet. Ask me to do something in the Assistant tab.</p>';
  $('history-list').querySelectorAll<HTMLElement>('.task').forEach((el) => {
    el.onclick = async () => {
      const d = $('history-detail');
      d.hidden = false;
      await renderTimeline(d, await api(`/api/history/${el.dataset.id}`));
      d.scrollIntoView();
    };
  });
}

// ---------------------------------------------------------------- profile

async function loadProfile() {
  const rows = await api<any[]>('/api/profile');
  $('profile-table').innerHTML = '<tr><th>Field</th><th>Value</th><th>Source</th><th></th></tr>' + rows
    .map((r) => `<tr><td>${esc(r.field)}</td><td>${esc(r.value)}</td><td class="small muted">${esc(r.source)}</td>` +
      `<td>${r.source === 'directory' ? '' : `<button class="link" data-del="${esc(r.field)}">delete</button>`}</td></tr>`)
    .join('');
  $('profile-table').querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/profile/${encodeURIComponent(b.dataset.del!)}`, 'DELETE');
      loadProfile();
    };
  });
}

$('profile-form').onsubmit = async (e) => {
  e.preventDefault();
  const field = $<HTMLInputElement>('profile-field').value.trim();
  const value = $<HTMLInputElement>('profile-value').value.trim();
  if (!field) return;
  await api('/api/profile', 'PUT', { [field]: value });
  $<HTMLInputElement>('profile-field').value = $<HTMLInputElement>('profile-value').value = '';
  loadProfile();
};

// ---------------------------------------------------------------- settings

function settingsBody() {
  const mode = (document.querySelector<HTMLInputElement>('input[name=mode]:checked')!).value;
  return {
    mode,
    provider_id: Number($<HTMLSelectElement>('model-select').value) || null,
    custom_url: $<HTMLInputElement>('custom-url').value.trim() || null,
    custom_model: $<HTMLInputElement>('custom-model').value.trim() || null,
    api_key: $<HTMLInputElement>('custom-key').value || null,
    temperature: Number($<HTMLInputElement>('temperature').value),
  };
}

async function loadSettings() {
  const [{ models, allow_custom_endpoints }, s] = await Promise.all([api('/api/models'), api('/api/settings')]);
  $('model-select').innerHTML = models
    .map((m: any) => `<option value="${m.id}">${esc(m.name)} — ${esc(m.model)}${m.is_default ? ' (default)' : ''}</option>`).join('');
  const current = s.provider_id ?? models.find((m: any) => m.is_default)?.id;
  $<HTMLSelectElement>('model-select').value = String(current);
  $('custom-label').hidden = $('custom-fields').hidden = !allow_custom_endpoints;
  document.querySelector<HTMLInputElement>(`input[name=mode][value=${s.custom_url && allow_custom_endpoints ? 'custom' : 'list'}]`)!.checked = true;
  $<HTMLInputElement>('custom-url').value = s.custom_url || '';
  $<HTMLInputElement>('custom-model').value = s.custom_model || '';
  $<HTMLInputElement>('custom-key').placeholder = s.has_custom_key ? 'API key (saved — leave blank to keep)' : 'API key (optional)';
  $<HTMLInputElement>('temperature').value = String(s.temperature);
  $('active-model').textContent = `${s.active.name} · ${s.active.model} @ ${s.active.url}`;
}

$('test-btn').onclick = async () => {
  $('settings-status').textContent = 'Testing…';
  try {
    const r = await api('/api/settings/test', 'POST', settingsBody());
    $('settings-status').textContent = r.ok
      ? `✅ Connected (${r.ms} ms)` + (r.structured_output
          ? ` · structured output: ${({ schema: 'JSON schema', object: 'JSON mode', none: 'plain text' } as any)[r.structured_output]}` +
            ` · system role: ${r.system_role ? 'yes' : 'no (merged into the request)'}`
          : '')
      : `❌ ${r.error}`;
  } catch (e: any) {
    $('settings-status').textContent = `❌ ${e.message}`;
  }
};
$('save-btn').onclick = async () => {
  try {
    await api('/api/settings', 'PUT', settingsBody());
    $('settings-status').textContent = '✅ Saved';
    loadSettings();
  } catch (e: any) {
    $('settings-status').textContent = `❌ ${e.message}`;
  }
};

// ---------------------------------------------------------------- teach mode

let teachEvents: TeachEvent[] = [];
let teachSite = '';

function addTeachEvent(e: TeachEvent) {
  const last = teachEvents[teachEvents.length - 1];
  if (e.kind === 'navigate' && last?.kind === 'navigate' && last.url === e.url) return;
  if (e.kind !== 'navigate' && last && last.kind === e.kind && last.label === e.label && e.kind !== 'click') {
    teachEvents[teachEvents.length - 1] = e; // keep the final value of a field
  } else {
    teachEvents.push(e);
  }
  $('teach-events').innerHTML = teachEvents.map((x) => `<li>${esc(describeEvent(x))}</li>`).join('');
}

browser.runtime.onMessage.addListener((msg: any) => {
  if (msg?.type === 'teach-event') addTeachEvent(msg.event);
});

$('teach-start').onclick = async () => {
  const name = $<HTMLInputElement>('teach-name').value.trim();
  if (!name) return ($('teach-status').textContent = 'Give the workflow a name first.');
  const tab = await targetTab();
  if (!tab?.id) return ($('teach-status').textContent = 'Open the website you want to teach first.');
  teachEvents = [];
  teachSite = new URL(tab.url!).hostname;
  $('teach-review').hidden = true;
  $('teach-events').innerHTML = '';
  await startRecording(tab.id, addTeachEvent);
  document.body.dataset.teach = 'recording';
  $('teach-start').hidden = true;
  $('teach-stop').hidden = false;
  $('teach-status').textContent = '● Recording — do the task in the page now.';
};

$('teach-stop').onclick = async () => {
  await stopRecording();
  $('teach-start').hidden = false;
  $('teach-stop').hidden = true;
  document.body.dataset.teach = 'drafting';
  $('teach-status').textContent = `Recorded ${teachEvents.length} steps. Asking the assistant to write a playbook…`;
  try {
    const sites = [...new Set(teachEvents.map((e) => { try { return new URL(e.url).hostname; } catch { return ''; } }))]
      .filter((h) => h && h !== 'intranet.office.local');
    teachSite = sites[sites.length - 1] || teachSite;
    const r = await api('/api/teach/draft', 'POST', { name: $<HTMLInputElement>('teach-name').value.trim(), site: teachSite, events: teachEvents });
    $<HTMLTextAreaElement>('teach-draft').value = r.steps;
    $('teach-review').hidden = false;
    $('teach-status').textContent = 'Review the draft, edit anything wrong, then save.';
    document.body.dataset.teach = 'review';
  } catch (e: any) {
    $('teach-status').textContent = `❌ ${e.message}`;
    document.body.dataset.teach = 'error';
  }
};

$('teach-save').onclick = async () => {
  const r = await api('/api/playbooks', 'POST', {
    site: teachSite, task: $<HTMLInputElement>('teach-name').value.trim(), steps: $<HTMLTextAreaElement>('teach-draft').value,
    events: teachEvents,   // replayed as a workflow: fixed steps run directly, values still come from each request
  });
  $('teach-review').hidden = true;
  $('teach-status').textContent = r.status === 'active' ? '✅ Playbook saved and active.' : '✅ Saved — waiting for an admin to approve it.';
  document.body.dataset.teach = 'saved';
  loadPlaybooks();
};
$('teach-discard').onclick = () => {
  $('teach-review').hidden = true;
  $('teach-status').textContent = 'Discarded.';
};

async function loadPlaybooks() {
  const rows = await api<any[]>('/api/playbooks');
  const isAdmin = me?.roles.includes('admin');
  $('playbook-list').innerHTML = rows.map((p) => `<div class="task"><b>${esc(p.task)}</b> · ${esc(p.site)} · ` +
    `<span class="badge">${esc(p.status)}</span> <span class="muted">${esc(p.source)} by ${esc(p.updated_by)}</span>` +
    (isAdmin && p.status === 'pending' ? ` <button class="link" data-approve="${p.id}">approve</button>` : '') +
    `<pre style="white-space:pre-wrap">${esc(p.steps)}</pre></div>`).join('');
  $('playbook-list').querySelectorAll<HTMLButtonElement>('[data-approve]').forEach((b) => {
    b.onclick = async () => { await api(`/api/playbooks/${b.dataset.approve}/approve`, 'POST'); loadPlaybooks(); };
  });
}

// ---------------------------------------------------------------- start

(async () => ((await getAccessToken()) ? showSignedIn() : showSignedOut()))();

// For automated tests of the page reader (tests/probe.mjs)
(window as any).__officeAssistantDebug = { snapshot, act, targetTab };
