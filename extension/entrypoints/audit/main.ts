import { api } from '../../lib/api';
import { esc, renderTimeline } from '../../lib/timeline';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let tasks: any[] = [];

async function loadTasks() {
  const q = new URLSearchParams({
    all: 'true',
    emp_id: $<HTMLInputElement>('f-emp').value.trim(),
    status: $<HTMLSelectElement>('f-status').value,
    site: $<HTMLInputElement>('f-site').value.trim(),
  });
  tasks = await api<any[]>(`/api/history?${q}`);
  $('tasks').innerHTML = '<tr><th>Time</th><th>Employee</th><th>Request</th><th>Status</th><th>Model</th></tr>' + tasks
    .map((t) => `<tr data-id="${t.task_id}"><td>${esc(t.started_at.slice(0, 19).replace('T', ' '))}</td>` +
      `<td>${esc(t.user_name)}<div class="small muted">${esc(t.emp_id)}</div></td><td>${esc(t.prompt)}</td>` +
      `<td><span class="badge ${esc(t.status)}">${esc(t.status)}</span></td><td class="small">${esc(t.model)}</td></tr>`)
    .join('');
  $('tasks').querySelectorAll<HTMLTableRowElement>('tr[data-id]').forEach((tr) => {
    tr.onclick = async () => renderTimeline($('detail'), await api(`/api/history/${tr.dataset.id}`));
  });
}

async function loadActivity() {
  const rows = await api<any[]>('/api/audit/log');
  $('activity').innerHTML = '<tr><th>Time</th><th>Employee</th><th>Event</th><th>Details</th></tr>' + rows
    .map((r) => `<tr><td>${esc(r.created_at.slice(0, 19).replace('T', ' '))}</td><td>${esc(r.emp_id)}</td>` +
      `<td>${esc(r.event_type)}</td><td class="small">${esc(JSON.stringify(r.payload))}</td></tr>`)
    .join('');
}

async function loadHealth() {
  const rows = await api<any[]>('/api/admin/playbook-health');
  $('health').innerHTML = '<tr><th>Site / workflow</th><th>Status</th><th>Runs</th><th>Done</th><th>Last 5</th><th>Last problem</th></tr>' +
    (rows.length ? rows.map((h) => `<tr><td>${esc(h.name)}</td>` +
      `<td><span class="badge ${h.status === 'ok' ? 'completed' : 'failed'}">${esc(h.status)}</span></td>` +
      `<td>${h.runs}</td><td>${h.completed}</td><td class="small">${esc(h.recent.join(', '))}</td>` +
      `<td class="small">${esc(h.last_problem ? `${h.last_problem.when.slice(0, 16).replace('T', ' ')} ${h.last_problem.status}: ${h.last_problem.summary}` : '')}` +
      (h.drift ? ` <b>· workflow stopped matching the site ${h.drift}×</b>` : '') + '</td></tr>').join('')
      : '<tr><td colspan="6" class="muted">No finished tasks yet.</td></tr>');
}

$('verify-btn').onclick = async () => {
  const r = await api('/api/audit/verify');
  $('verify-result').innerHTML = r.ok
    ? `<span class="verify-ok">✔ Chain valid — ${r.checked} events checked</span>`
    : `<span class="verify-bad">✖ TAMPERING DETECTED at event #${r.broken_at_event_id} (${esc(r.event_type)}, task ${esc(r.task_id)}, step ${r.seq}) after ${r.checked} valid events</span>`;
  loadActivity();
};

$('export-btn').onclick = () => {
  const cols = ['started_at', 'emp_id', 'user_name', 'prompt', 'site', 'status', 'summary', 'model', 'model_url', 'client_ip'];
  const csv = [cols.join(',')]
    .concat(tasks.map((t) => cols.map((c) => `"${String(t[c] ?? '').replace(/"/g, '""')}"`).join(',')))
    .join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'assistant-audit.csv';
  a.click();
};
$('f-apply').onclick = loadTasks;

(async () => {
  try {
    const me = await api('/api/me');
    $('who').textContent = `${me.name} (${me.emp_id})`;
    if (!me.roles.includes('auditor')) throw new Error('Only users with the auditor role can open this page.');
    $('main').hidden = false;
    await Promise.all([loadTasks(), loadActivity(), loadHealth()]);
  } catch (e: any) {
    $('denied').hidden = false;
    $('denied').textContent = e.message;
  }
})();
