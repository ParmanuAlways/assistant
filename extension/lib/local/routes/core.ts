// The user, their profile and apps, the home screen, history and the audit trail. All kept in this browser.
import { getConfig } from '../../config';
import { ApiError } from '../../errors';
import { logEvent, mask, taskEvents, verifyChain, type AuditEvent } from '../audit';
import { requireRole } from '../identity';
import { route } from '../router';
import * as store from '../store';
import { fnmatch, hostOf, similarity } from '../text';

route('GET', '/api/me', ({ user: u }) => ({ emp_id: u.emp_id, username: u.username, name: u.name, email: u.email, roles: u.roles }));

// ---------------------------------------------------------------- profile

async function profileRows(emp_id: string) {
  return (await store.all('profile', 'emp_id', emp_id))
    .map(({ field, value, source, updated_at }: any) => ({ field, value, source, updated_at }))
    .sort((a, b) => (a.field < b.field ? -1 : 1));
}

route('GET', '/api/profile', ({ user }) => profileRows(user.emp_id));

route('PUT', '/api/profile', async ({ user, body }) => {
  for (const [field, value] of Object.entries(body || {})) {
    const f = field.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    await store.put('profile', { emp_id: user.emp_id, field: f, value: String(value), source: 'user', updated_at: store.now() });
  }
  await logEvent(user.emp_id, 'profile_updated', mask({ fields: body }));
  return profileRows(user.emp_id);
});

route('DELETE', '/api/profile/:field', async ({ user, params }) => {
  await store.del('profile', [user.emp_id, params.field]);
  await logEvent(user.emp_id, 'profile_field_deleted', { field: params.field });
  return { ok: true };
});

// ---------------------------------------------------------------- your apps, home screen

async function links(emp_id: string) {
  return (await store.all('links', 'emp_id', emp_id)).sort((a, b) => a.id - b.id).map(({ id, title, url }: any) => ({ id, title, url }));
}

route('GET', '/api/links', ({ user }) => links(user.emp_id));

route('POST', '/api/links', async ({ user, body }) => {
  const url = String(body.url || '').trim();
  let title = String(body.title || '').trim();
  if (!/^https?:\/\/[^\s/]+/.test(url)) throw new ApiError(400, 'Enter a full address starting with http:// or https://');
  title = (title || hostOf(url)).slice(0, 60);
  const id = await store.add('links', { emp_id: user.emp_id, title, url, created_at: store.now() });
  await logEvent(user.emp_id, 'link_added', { title, url });
  const allowed = (await getConfig()).allowedSites.some((s) => fnmatch(hostOf(url), s));
  return { id, title, url, assistant_can_use: allowed };
});

route('DELETE', '/api/links/:id', async ({ user, params }) => {
  const id = Number(params.id);
  const row = await store.get('links', id);
  if (row && row.emp_id === user.emp_id) await store.del('links', id);
  await logEvent(user.emp_id, 'link_deleted', { id });
  return { ok: true };
});

/** The user's tasks, newest first */
async function userTasks(emp_id: string) {
  return (await store.all('tasks', 'emp_id', emp_id)).sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
}

route('GET', '/api/home', async ({ user }) => {
  // the first screen after sign-in: the user's apps, the tasks they do most often, and their latest tasks
  const tasks = (await userTasks(user.emp_id)).slice(0, 200)
    .map(({ task_id, prompt, status, summary, started_at }: any) => ({ task_id, prompt, status, summary, started_at }));
  const groups: { prompt: string; count: number; done: number; last: string }[] = [];
  for (const t of tasks) {   // similar requests count as the same kind of task ("apply leave ..." twice)
    const g = groups.find((x) => similarity(x.prompt, t.prompt) >= 0.6);
    if (g) { g.count++; g.done += t.status === 'completed' ? 1 : 0; }
    else groups.push({ prompt: t.prompt, count: 1, done: t.status === 'completed' ? 1 : 0, last: t.started_at });
  }
  const frequent = [...groups].sort((a, b) => b.count - a.count).slice(0, 4);   // (stable: ties stay newest first)
  return { links: await links(user.emp_id), frequent, recent: tasks.slice(0, 5) };
});

// ---------------------------------------------------------------- history & audit

route('GET', '/api/history', async ({ user, query }) => {
  const all = ['1', 'true'].includes(query.get('all') || '') && user.roles.includes('auditor');
  const emp = query.get('emp_id') || '', status = query.get('status') || '', site = query.get('site') || '';
  let rows: any[] = all ? await store.all('tasks') : await store.all('tasks', 'emp_id', user.emp_id);
  if (all && emp) rows = rows.filter((t) => t.emp_id === emp);
  if (status) rows = rows.filter((t) => t.status === status);
  if (site) rows = rows.filter((t) => (t.site || '').toLowerCase().includes(site.toLowerCase()));
  return rows.sort((a, b) => (a.started_at < b.started_at ? 1 : -1)).slice(0, 500);
});

route('GET', '/api/history/:task_id', async ({ user, params }) => {
  const t = await store.get('tasks', params.task_id);
  if (!t || (t.emp_id !== user.emp_id && !user.roles.includes('auditor'))) throw new ApiError(404, 'Task not found');
  return { task: t, events: await taskEvents(params.task_id) };
});

route('GET', '/api/audit/verify', async ({ user }) => {
  requireRole(user, 'auditor');
  const result = await verifyChain();
  await logEvent(user.emp_id, 'audit_verified', result);
  return result;
});

route('GET', '/api/audit/log', async ({ user }) => {
  requireRole(user, 'auditor');
  const rows = (await store.all<AuditEvent>('events')).filter((e) => e.task_id === null);
  return rows.reverse().slice(0, 500).map(({ id, emp_id, event_type, payload, created_at }) => ({ id, emp_id, event_type, payload, created_at }));
});

/** Everything in this browser's audit trail, for collecting centrally (the auditor page's export). */
route('GET', '/api/audit/export', async ({ user }) => {
  requireRole(user, 'auditor');
  const verify = await verifyChain();
  await logEvent(user.emp_id, 'audit_exported', { events: verify.checked, ok: verify.ok });
  return { exported_at: store.now(), exported_by: user.emp_id, verify, tasks: await store.all('tasks'), events: await store.all('events') };
});

// ---------------------------------------------------------------- admin rules: set by IT through browser policy

route('GET', '/api/admin/policy', async ({ user }) => {
  requireRole(user, 'admin');
  const c = await getConfig();
  return { allow_custom_endpoints: c.allowCustomEndpoints, allowed_model_hosts: c.allowedModelHosts, allowed_sites: c.allowedSites,
    max_steps: c.maxSteps };
});

route('PUT', '/api/admin/policy', () => {
  throw new ApiError(403, 'Admin rules come from browser policy (set by IT), not from the assistant.');
});
