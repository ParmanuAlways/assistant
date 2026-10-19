import { browser } from 'wxt/browser';
import { runTask, type Confirmation } from '../../lib/agent';
import { api, ApiError } from '../../lib/api';
import { getAccessToken, login, logout } from '../../lib/auth';
import { describeEvent, startRecording, stopRecording, type TeachEvent } from '../../lib/teach';
import { esc, renderTimeline } from '../../lib/timeline';
import { targetTab } from '../../lib/agent';

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
  $('user-name').textContent = `Hello, ${me!.name}`;
  $('user-emp').textContent = `(${me!.emp_id})`;
  $('user-roles').textContent = 'Roles: ' + me!.roles.filter((r) => ['user', 'auditor', 'admin'].includes(r)).join(', ');
  $('audit-btn').hidden = !me!.roles.includes('auditor');
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
  };
});

// ---------------------------------------------------------------- assistant

function log(text: string, kind = 'info') {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.textContent = text;
  $('log').appendChild(div);
  $('log').scrollTop = $('log').scrollHeight;
}

function ask(question: string, options?: string[], isUserAction?: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    $('ask-box').hidden = false;
    $('ask-question').textContent = question;
    const input = $<HTMLInputElement>('ask-input');
    input.value = '';
    input.hidden = !!isUserAction || !!options?.length;
    $('ask-send').textContent = isUserAction ? 'Continue' : 'Send';
    $('ask-send').hidden = !!options?.length;
    $('ask-options').innerHTML = '';
    const finish = (v: string | null) => {
      $('ask-box').hidden = true;
      if (v !== null) log(v || '(continued)', 'user');
      resolve(v);
    };
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
  });
}

function confirmSubmit(c: Confirmation): Promise<boolean> {
  return new Promise((resolve) => {
    $('confirm-box').hidden = false;
    $('confirm-warning').hidden = !c.warning;
    $('confirm-warning').textContent = c.warning ? `⚠ ${c.warning}` : '';
    $('confirm-table').innerHTML = c.fields.map((f) => `<tr><th>${esc(f.label)}</th><td>${esc(f.value)}</td></tr>`).join('');
    const done = (v: boolean) => {
      $('confirm-box').hidden = true;
      log(v ? `Confirmed: ${c.button}` : 'Declined', 'user');
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
  log(prompt, 'user');
  stopped = false;
  $('run-btn').hidden = true;
  $('stop-btn').hidden = false;
  document.body.dataset.agent = 'running';
  const result = await runTask(prompt, { step: log, ask, confirm: confirmSubmit, isStopped: () => stopped });
  document.body.dataset.agent = result.status;
  $('run-btn').hidden = false;
  $('stop-btn').hidden = true;
};
$('stop-btn').onclick = () => (stopped = true);

// ---------------------------------------------------------------- history

async function loadHistory() {
  $('history-detail').hidden = true;
  const tasks = await api<any[]>('/api/history');
  $('history-list').innerHTML = tasks.length
    ? tasks.map((t) => `<div class="task" data-id="${t.task_id}"><div>${esc(t.prompt)}</div>` +
        `<div class="small muted">${esc(t.started_at.slice(0, 16).replace('T', ' '))} · ` +
        `<span class="badge ${esc(t.status)}">${esc(t.status)}</span> · ${esc(t.summary || '')}</div></div>`).join('')
    : '<p class="muted">No tasks yet.</p>';
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
