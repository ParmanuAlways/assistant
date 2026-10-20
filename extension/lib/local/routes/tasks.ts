// The agent loop, model settings, teach mode and playbooks, answered in the browser. The model is the only thing
// reached over the network.
import { getConfig } from '../../config';
import { ApiError } from '../../errors';
import * as agent from '../agent';
import { logEvent, mask, stable, taskEvents } from '../audit';
import { getProfile, requireRole, today as todayDate, type User } from '../identity';
import { callModel, capabilities, defaultModelCfg, entryCfg, modelCfg, type Cfg, type UserSettings } from '../model';
import { route } from '../router';
import * as skills from '../skills';
import * as store from '../store';
import { fnmatch, hostOf } from '../text';

// Answers that must never become profile facts, and fields that are one-off by nature
const NON_ANSWER = /not sure|don'?t know|no idea|best judg|skip|n\/?a\b|^\s*-?\s*$/i;
const ONE_OFF_FIELD = /date|time|reason|purpose|quantity|amount|title|subject|description|comment|day/i;
const FAIL_FIX = 'The model did not give a usable answer.';
const ID_ACTIONS = ['click', 'type', 'select', 'pick_date', 'autocomplete', 'upload', 'hover'];

const LAST_PAGE_TEXT = new Map<string, string>();   // task_id -> page text seen before the latest action
const TASK_STATE = new Map<string, any>();          // task_id -> working memory (plan, workflow replay, sign-out, failures)

interface Task {
  task_id: string; emp_id: string; user_name: string; prompt: string; site: string | null; status: string; summary: string | null;
  model: string; model_url: string; client_ip: string | null; user_agent: string | null; steps: number; started_at: string; ended_at: string | null;
}

const slugOf = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
const slug2 = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const errText = (e: any) => String(e?.message || e);

// ---------------------------------------------------------------- model settings

/** Is a model server address allowed? Wildcards ("*.office.local"); CIDR rules ("10.0.0.0/8") match IP addresses only,
 *  since a browser cannot look up what a name resolves to. */
export function hostAllowed(url: string, rules: string[]): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname;
  if (!host || !['http:', 'https:'].includes(u.protocol)) return false;
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  const n = (a: string) => a.split('.').reduce((x, o) => x * 256 + Number(o), 0);
  for (const rule of rules) {
    if (rule.includes('/')) {
      const [net, bits] = rule.split('/');
      if (v4.test(host) && v4.test(net)) {
        const size = 2 ** (32 - Number(bits));
        if (Math.floor(n(host) / size) === Math.floor(n(net) / size)) return true;
      }
    } else if (fnmatch(host, rule)) return true;
  }
  return false;
}

async function settingsOf(u: User) {
  const s = await store.get<UserSettings>('settings', u.emp_id);
  const cfg = await modelCfg(u.emp_id);
  return { provider_id: s?.provider_id ?? null, custom_url: s?.custom_url ?? null, custom_model: s?.custom_model ?? null,
    has_custom_key: !!s?.custom_key, temperature: s?.temperature ?? 0.2, active: { name: cfg.name, url: cfg.url, model: cfg.model } };
}

async function validateSettings(b: any) {
  const pol = await getConfig();
  if (b.mode === 'custom') {
    if (!pol.allowCustomEndpoints) throw new ApiError(403, 'Your administrator has not allowed custom model endpoints.');
    if (!b.custom_url || !b.custom_model) throw new ApiError(400, 'Custom endpoint needs a URL and a model name.');
    if (!hostAllowed(b.custom_url, pol.allowedModelHosts))
      throw new ApiError(403, `${hostOf(b.custom_url)} is not an allowed model host (allowed: ${pol.allowedModelHosts.join(', ')}).`);
  } else if (b.provider_id != null && !pol.models.some((m) => m.id === b.provider_id)) throw new ApiError(400, 'Unknown model.');
}

route('GET', '/api/models', async () => {
  const c = await getConfig();
  const def = (c.models.find((m) => m.default) || c.models[0])?.id;
  return { models: c.models.map((m) => ({ id: m.id, name: m.name, base_url: m.url, model: m.model, supports_vision: m.vision ? 1 : 0,
    is_default: m.id === def ? 1 : 0, note: m.note || null })), allow_custom_endpoints: c.allowCustomEndpoints };
});

route('GET', '/api/settings', ({ user }) => settingsOf(user));

route('PUT', '/api/settings', async ({ user, body }) => {
  const b = { mode: 'list', temperature: 0.2, ...body };
  await validateSettings(b);
  const before = (await settingsOf(user)).active;
  const old = await store.get<UserSettings>('settings', user.emp_id);
  const custom = b.mode === 'custom';
  const key = b.api_key ? b.api_key : old?.custom_key && custom ? old.custom_key : null;
  await store.put('settings', { emp_id: user.emp_id, provider_id: custom ? null : b.provider_id ?? null, custom_url: custom ? b.custom_url : null,
    custom_model: custom ? b.custom_model : null, custom_key: custom ? key : null, temperature: b.temperature, updated_at: store.now() });
  const after = (await settingsOf(user)).active;
  await logEvent(user.emp_id, 'settings_changed', { from: before, to: after, temperature: b.temperature });
  return settingsOf(user);
});

route('POST', '/api/settings/test', async ({ body }) => {
  const b = { mode: 'list', ...body };
  await validateSettings(b);
  const pol = await getConfig();
  let cfg: any;
  if (b.mode === 'custom') cfg = { url: b.custom_url, model: b.custom_model, key: b.api_key };
  else if (b.provider_id) cfg = entryCfg(pol.models.find((m) => m.id === b.provider_id)!);
  else cfg = await defaultModelCfg();
  cfg = { json_mode: 'auto', context_tokens: 8192, ...cfg };
  const t0 = Date.now();
  let reply: string, ms: number;
  try {
    reply = await callModel(cfg, [{ role: 'user', content: 'Reply with the single word OK.' }], { timeout: 120, json_mode: false });
    ms = Date.now() - t0;
  } catch (e: any) {
    return { ok: false, error: `${e?.name || 'Error'}: ${errText(e)}`.slice(0, 300) };
  }
  try {   // optional: find out which structured-output mode and roles this server supports
    await callModel(cfg, [{ role: 'system', content: agent.SYSTEM_PROMPT }, { role: 'user', content:
      'The task is already complete. Reply with the done action.' }], { timeout: 180 });
    const caps = capabilities(cfg);
    return { ok: true, ms, reply: reply.slice(0, 200), structured_output: caps.json, system_role: caps.system };
  } catch {
    return { ok: true, ms, reply: reply.slice(0, 200), structured_output: null, system_role: null };
  }
});

// ---------------------------------------------------------------- playbooks (shared ones from policy, taught ones here)

export async function allPlaybooks(): Promise<any[]> {
  const c = await getConfig();
  const seed = c.playbooks.map((p, i) => ({ id: i + 1, site: p.site, task: p.task, steps: p.steps, updated_by: 'policy', updated_at: null,
    status: 'active', source: 'seed', macro: p.macro ? JSON.stringify(p.macro) : null }));
  const byId = new Map<number, any>(seed.map((p) => [p.id, p]));
  for (const p of await store.all('playbooks')) byId.set(p.id, { ...byId.get(p.id), ...p });   // a local edit of a shared one wins here
  return [...byId.values()];
}

/** Colleagues named in the request, from the company directory (a JSON list IT publishes), so the model never
 *  guesses e-mail addresses. Searches each capitalised word of the goal. */
export async function directoryLookup(goal: string): Promise<any[]> {
  const skip = new Set(['Send', 'Reply', 'Forward', 'Find', 'Move', 'Email', 'Apply', 'Book', 'Order', 'Register', 'Raise', 'Claim']);
  const names = [...new Set(goal.match(/\b[A-Z][a-z]{2,}\b/g) || [])].filter((w) => !skip.has(w));
  const { directoryUrl } = await getConfig();
  if (!names.length || !directoryUrl) return [];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const people: any[] = await (await fetch(directoryUrl, { credentials: 'include', signal: ctl.signal })).json();
    const found = new Map<string, any>();
    for (const n of names) {
      const q = n.toLowerCase();
      for (const p of people.filter((x) => x?.email && `${x.name || ''} ${x.email}`.toLowerCase().includes(q)).slice(0, 5))
        found.set(p.email, { name: p.name || '', email: p.email });
    }
    return [...found.values()];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- tasks

async function ownTask(taskId: string, u: User): Promise<Task> {
  const t = await store.get<Task>('tasks', taskId);
  if (!t || t.emp_id !== u.emp_id) throw new ApiError(404, 'Task not found');
  return t;
}

route('POST', '/api/tasks', async ({ user, body }) => {
  const taskId = crypto.randomUUID();
  const cfg = await modelCfg(user.emp_id);
  await store.put('tasks', { task_id: taskId, emp_id: user.emp_id, user_name: user.name, prompt: body.prompt, site: hostOf(body.url) || null,
    status: 'running', summary: null, model: cfg.model, model_url: cfg.url, client_ip: null,
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null, steps: 0, started_at: store.now(), ended_at: null } as Task);
  await logEvent(user.emp_id, 'user_message', { prompt: body.prompt, model: cfg.model, model_url: cfg.url }, { task_id: taskId, url: body.url ?? null });
  return { task_id: taskId, model: cfg.name };
});

/** Earlier steps of this task, condensed for the prompt. */
async function historyForModel(taskId: string) {
  const out: any[] = [];
  for (const r of await taskEvents(taskId)) {
    const p = r.payload;
    if (r.event_type === 'model_action') {
      const a = p.action;
      out.push({ did: Object.fromEntries(['action', 'id', 'value', 'url', 'question', 'field', 'fields'].filter((k) => k in a).map((k) => [k, a[k]])),
        on: p.element ?? null });
    } else if (r.event_type === 'action_result') out.push({ result: p });
    else if (r.event_type === 'user_answer') out.push({ user_answered: { field: p.field ?? null, question: p.question ?? null, answer: p.answer ?? null } });
  }
  return out;
}

const isLoginPage = (page: any) => (page.elements || []).some((e: any) => e.type === 'password');

/** The URL that best says where the work is: the main frame of a frameset, else the page. */
function whereAmI(page: any): string {
  for (const f of page.frames || []) {
    const i = f.indexOf(': ');
    const [name, url] = i >= 0 ? [f.slice(0, i), f.slice(i + 2)] : [f, ''];
    if (['main', 'content', 'body', 'workspace'].includes(name)) return url;
  }
  return page.url || '';
}

/** What the user answered and what the assistant typed in this task (for value provenance). */
async function taskValues(taskId: string): Promise<[string[], string[]]> {
  const answers: string[] = [], typed: string[] = [];
  for (const r of await taskEvents(taskId)) {
    const p = r.payload;
    if (r.event_type === 'user_answer') answers.push(String(p.answer ?? ''));
    else if (r.event_type === 'model_action') {
      const a = p.action || {};
      if (a.value) typed.push(String(a.value));
      for (const f of a.fields || []) typed.push(String(f.value));
    }
  }
  return [answers, typed];
}

/** Adds where each value came from and the pre-submit checks to a confirmation. */
async function buildConfirmation(taskId: string, t: Task, page: any, confirm: any, profile: any, today: Date) {
  const [answers, typed] = await taskValues(taskId);
  confirm.fields = agent.provenance(confirm.fields, t.prompt, profile, answers, typed, today);
  confirm.checks = agent.verifySubmission(t.prompt, confirm.fields, today, confirm.row || '', page.text || '');
  confirm.fields = confirm.fields.map((f: any) => Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith('_'))));
  return confirm;
}

/** Submits the user approved in this task, and whether each one went through. One the site rejected (an alert
 *  such as "Please pick the approver", an error message, nothing happened) doesn't count. */
async function approvals(taskId: string): Promise<[string, boolean][]> {
  const rows = (await taskEvents(taskId)).filter((e) => ['confirmation', 'action_result'].includes(e.event_type));
  const out: [string, boolean][] = [];
  rows.forEach((r, i) => {
    const c = r.payload;
    if (r.event_type !== 'confirmation' || !c.approved) return;
    const res = rows.slice(i + 1).find((x) => x.event_type === 'action_result')?.payload;
    const rejected = res != null && (res.dialog?.kind === 'alert' || !res.ok || /errors shown|did not change/.test(res.observed || ''));
    out.push([c.button, !rejected]);   // not reported yet: assume it went through (never do it twice)
  });
  return out;
}
const wentThrough = async (taskId: string) => (await approvals(taskId)).some(([, ok]) => ok);

/** True if the user just approved the previous action AND this click is the site's own confirmation button
 *  for it (e.g. "Place order" then the site's "Yes, place order"). A repeat of the same button always asks again. */
async function justConfirmed(taskId: string, element: any): Promise<boolean> {
  const evs = await taskEvents(taskId);
  const last = [...evs].reverse().find((e) => e.event_type === 'model_action');
  if (!last || !last.payload.needs_confirmation) return false;
  const prev = last.payload.element || {};
  const label = `${element?.text || ''} ${element?.label || ''}`;
  if (((prev.text ?? null) === (element?.text ?? null) && (prev.label ?? null) === (element?.label ?? null)) || !/\b(yes|ok|confirm)\b/i.test(label))
    return false;
  const c = [...evs].reverse().find((e) => e.event_type === 'confirmation');
  return !!(c && c.payload.approved);
}

async function finishInternal(taskId: string, u: User, status: string, summary: string, actOnly = false) {
  const changed = await store.update<Task>('tasks', taskId, (t) => t && t.status === 'running' ? { ...t, status, summary, ended_at: store.now() } : undefined);
  await logEvent(u.emp_id, 'task_finished', { status, summary }, { task_id: taskId });
  if (changed) await recordOutcome(taskId, u, status, summary);
  if (actOnly) return { action: { action: status !== 'completed' ? 'fail' : 'done', summary }, needs_confirmation: false, confirmation: null };
  return undefined;
}

/** Playbook/workflow health, and learning from verified successes. */
async function recordOutcome(taskId: string, u: User, status: string, summary: string) {
  const st = TASK_STATE.get(taskId) || {};
  TASK_STATE.delete(taskId);
  LAST_PAGE_TEXT.delete(taskId);
  const evs = await taskEvents(taskId);
  const source = st.workflow?.source || evs.find((e) => e.event_type === 'workflow_selected')?.payload.source || null;
  await store.put('outcomes', { task_id: taskId, site: await skills.mainSite(taskId), workflow: source, status, summary: (summary || '').slice(0, 300),
    drift: st.drift || 0, ended_at: store.now() });
  if (source && source.startsWith('experience:')) {
    const col = status === 'completed' ? 'successes' : 'failures';
    await store.update('experiences', Number(source.split(':')[1]), (x: any) => x && { ...x, [col]: (x[col] || 0) + 1 });
  }
  const acted = evs.some((e) => e.event_type === 'confirmation' && e.payload.approved === true);
  if (status === 'completed' && acted) {
    const t = await store.get<Task>('tasks', taskId);
    const exp = await skills.learnFromTask(taskId, t!.prompt, store.now());
    if (exp) await logEvent(u.emp_id, 'experience_saved', { experience: exp }, { task_id: taskId });
  }
}

function b64ToBlob(b64: string): Blob {
  const s = atob(b64.split(',').pop()!);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}
/** Screenshots are kept in the browser: store 'files', name "shot:<task>-<8 hex>.png" (lib/api.ts screenshotUrl). */
async function saveShot(taskId: string, b64: string): Promise<string> {
  const hex = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const name = `${taskId}-${hex}.png`;
  await store.put('files', { name: `shot:${name}`, blob: b64ToBlob(b64), created_at: store.now() });
  return name;
}

route('POST', '/api/tasks/:id/step', async ({ user: u, body, params }) => {
  const taskId = params.id;
  const t = await ownTask(taskId, u);
  if (t.status !== 'running') throw new ApiError(409, `Task is ${t.status}`);
  const pol = await getConfig();
  const today = await todayDate();
  if (t.steps >= pol.maxSteps) return finishInternal(taskId, u, 'failed', `Stopped after ${pol.maxSteps} steps.`, true);
  if (!TASK_STATE.has(taskId)) TASK_STATE.set(taskId, { fails: 0 });
  const st = TASK_STATE.get(taskId);
  const page = body.page || {};
  page.elements = page.elements || [];
  for (const el of page.elements) if (el.type === 'password') el.value = '';   // passwords never leave the browser, but be sure
  const evs = await taskEvents(taskId);
  if (body.last_result != null) {
    // Check what the action changed, so the model sees the effect, not just "clicked"
    const res = mask(body.last_result);
    const observed: string[] = [];
    if (whereAmI(page) !== st.last_where) observed.push(`now on ${page.title || ''} ${whereAmI(page)}`.trim());
    if (page.errors?.length) observed.push(('errors shown: ' + page.errors.join(' | ')).slice(0, 300));
    else if (whereAmI(page) === st.last_where) {
      // same page: say what appeared ("Selected seat: C3", "Item added"), so the effect of the action is visible
      const added = agent.textAdded(LAST_PAGE_TEXT.get(taskId) || '', page.text || '');
      if (added) observed.push('the page now shows: ' + added);
    }
    const lastAct = [...evs].reverse().find((e) => e.event_type === 'model_action');
    if (lastAct?.payload.action?.action === 'click' && (page.text || '') === LAST_PAGE_TEXT.get(taskId) && !res.dialog)
      observed.push('the page did not change');   // (typing changes field values, not the page text)
    if (lastAct?.payload.action?.action === 'click_xy' && (page.text || '') === LAST_PAGE_TEXT.get(taskId) && !res.dialog) {
      // a click on a drawing that changed nothing ("Selected seat: none"): the point was a little off. Look again.
      observed.push('the click hit nothing on the drawing (the page did not change)');
      st.missed_xy = true;
    }
    if (observed.length) res.observed = observed.join('; ');
    await logEvent(u.emp_id, 'action_result', res, { task_id: taskId, url: page.url ?? null });
    st.fails = body.last_result.ok && !page.errors?.length ? 0 : st.fails + 1;
  }
  if (body.user_answer) {
    const ans = body.user_answer;
    await logEvent(u.emp_id, 'user_answer', mask(ans), { task_id: taskId, url: page.url ?? null });
    const field = slugOf(ans.field || '');
    if (ans.remember && field && field !== 'user_action' && ans.answer && !NON_ANSWER.test(ans.answer) && !ONE_OFF_FIELD.test(field)) {
      await store.put('profile', { emp_id: u.emp_id, field, value: ans.answer, source: 'learned', updated_at: store.now() });
      await logEvent(u.emp_id, 'profile_learned', mask({ field, value: ans.answer }), { task_id: taskId });
    }
  }
  const shotName = body.screenshot_b64 ? await saveShot(taskId, body.screenshot_b64) : null;
  await logEvent(u.emp_id, 'page_snapshot', {
    title: page.title ?? null, text_excerpt: (page.text || '').slice(0, 600), notices: page.notices ?? null, errors: page.errors ?? null,
    frames: page.frames ?? null, popup: page.popup ?? null,
    elements: page.elements.slice(0, 80).map((e: any) => Object.fromEntries(['id', 'tag', 'type', 'label', 'text', 'value', 'required', 'frame', 'menu', 'row']
      .map((k) => [k, e[k] ?? null]))),
  }, { task_id: taskId, url: page.url ?? null, screenshot: shotName });

  const host = hostOf(page.url);
  const onAllowedSite = pol.allowedSites.some((s) => fnmatch(host, s));
  if (host && !onAllowedSite && t.steps > 0) return finishInternal(taskId, u, 'failed', `Stopped: ${host} is not an allowed site.`, true);
  const all = (await allPlaybooks()).filter((p) => p.status === 'active');
  let playbooks: any[] = all;
  if (all.some((p) => p.source === 'teach')) playbooks = agent.selectPlaybooks(all, t.prompt, host);
  playbooks = playbooks.map((p) => ({ site: p.site, task: p.task, steps: p.steps }));
  for (const link of (await store.all('links', 'emp_id', u.emp_id)).sort((a: any, b: any) => a.id - b.id)) {
    const h = hostOf(link.url);
    if (pol.allowedSites.some((s) => fnmatch(h, s)))
      playbooks.push({ site: h, task: `${link.title} (the user's saved app)`, steps: `Start URL: ${link.url}` });
  }
  const profile: any = await getProfile(u.emp_id);
  const colleagues = await directoryLookup(t.prompt);
  if (colleagues.length) profile.colleagues_from_company_directory = colleagues;
  const cfg = await modelCfg(u.emp_id);
  const extra: string[] = [];

  // Signed out in the middle of a task (session expiry): remember where we were, resume after sign-in
  const sameSite = hostOf(st.last_good) === host;
  if (isLoginPage(page)) {
    if (t.steps > 0 && sameSite && !st.signed_out) {   // bounced to sign-in inside the same site
      st.signed_out = true;
      st.resume_at = st.last_good;
      await logEvent(u.emp_id, 'signed_out_detected', { resume_at: st.resume_at ?? null }, { task_id: taskId });
    }
  } else {
    const was = st.signed_out;
    delete st.signed_out;
    if (was && st.resume_at) st.resume_note = 4;
    st.last_good = whereAmI(page);
  }
  if (st.resume_note) {
    st.resume_note -= 1;
    extra.push('NOTE: the site signed you out during the task and the user signed in again. Continue where you ' +
      `were: ${st.resume_at} (navigate there if needed). Values typed before may be lost: check the form.`);
  }

  // First step: a workflow seen before (taught, or a past success), else a short plan
  if (t.steps === 0 && !('workflow' in st)) {
    st.workflow = pol.agent.workflows ? await skills.pickWorkflow(t.prompt, all) : null;
    if (st.workflow) {
      await logEvent(u.emp_id, 'workflow_selected', { source: st.workflow.source, label: st.workflow.label, steps: st.workflow.steps }, { task_id: taskId });
    } else if (pol.agent.plan) {
      try {
        const planMsgs = agent.buildMessages(t.prompt, profile, playbooks, [], page, today, pol.agent.calendar, cfg.context_tokens);
        planMsgs[0] = { role: 'system', content: agent.PLAN_PROMPT };
        planMsgs[1].content = planMsgs[1].content.replace('Reply with the next action as one JSON object.', 'Reply with the plan as one JSON object.');
        st.plan = agent.parsePlan(await callModel(cfg, planMsgs, { schema: agent.PLAN_SCHEMA }));
        await logEvent(u.emp_id, 'plan', { steps: st.plan }, { task_id: taskId });
      } catch (e: any) {
        await logEvent(u.emp_id, 'plan_skipped', { error: errText(e).slice(0, 200) }, { task_id: taskId });
      }
    }
  }
  if (st.plan?.length) extra.push('PLAN (made at the start; adapt it if the page differs):\n' + st.plan.map((x: string, i: number) => `${i + 1}. ${x}`).join('\n'));

  let wf = st.workflow;
  let macroAct: any = null;
  if (wf && !isLoginPage(page) && !page.errors?.length) {
    let wfHint: string | null;
    [macroAct, wfHint] = skills.suggest(wf, page, host);
    if (wfHint) extra.push(wfHint);
    if ((wf.misses || 0) >= 6) {
      await logEvent(u.emp_id, 'workflow_drift', { source: wf.source, cursor: wf.cursor }, { task_id: taskId });
      st.drift = 1;
      st.workflow = wf = null;
      macroAct = null;
    }
  }
  const visionOk = cfg.vision || pol.agent.vision;
  const image: string | null = body.screenshot_b64 && visionOk ? body.screenshot_b64 : null;
  let messages = agent.buildMessages(t.prompt, profile, playbooks, await historyForModel(taskId), page, today, pol.agent.calendar,
    cfg.context_tokens, extra, image);
  let act: any = null, reply = '', used: Cfg = cfg;
  const fix = st.fix_field;
  if (fix && body.user_answer && body.user_answer.field === fix.field) {
    delete st.fix_field;
    const ans = String(body.user_answer.answer ?? '').trim();
    const target = page.elements.find((e: any) => (e.label || '') === fix.label);
    if (target && ans && !NON_ANSWER.test(ans))
      macroAct = { action: target.tag === 'select' ? 'select' : 'type', id: target.id, value: ans, thought: `Entering the ${fix.label} you gave me.` };
  }
  const drawing = page.elements.find((e: any) => e.type === 'drawing' && e.rect);
  if (st.missed_xy && drawing && !image && visionOk && (st.vision_tries || 0) < 3) {
    st.vision_tries = (st.vision_tries || 0) + 1;
    st.vision_reason = 'drawing';
    st.zoom = 3;   // a different, closer view: the same picture would give the same answer
    macroAct = { action: 'look', thought: 'That click missed: looking at the drawing again, closer.' };
  }
  delete st.missed_xy;
  if (image && drawing) {
    const reason = st.vision_reason;
    delete st.vision_reason;
    if (reason === 'drawing') {
      try {
        let target: string;
        [macroAct, target] = await agent.locateInDrawing(cfg, t.prompt, image, drawing, st.last_target || '', st.zoom || 2);
        await logEvent(u.emp_id, 'vision_locate', { target, action: macroAct }, { task_id: taskId });
        st.last_target = macroAct ? target : st.last_target || '';
      } catch (e: any) {
        await logEvent(u.emp_id, 'model_error', { where: 'vision_locate', error: errText(e).slice(0, 200) }, { task_id: taskId });
      }
    }
  }
  if (macroAct) {
    act = macroAct;
    reply = JSON.stringify(Object.fromEntries(Object.entries(macroAct).filter(([k]) => !k.startsWith('_'))));
  } else {
    try {
      reply = await callModel(cfg, messages);
    } catch (e: any) {
      const fallback = await defaultModelCfg();
      await logEvent(u.emp_id, 'model_error', { model: cfg.model, url: cfg.url, error: errText(e).slice(0, 300),
        fallback: fallback.url !== cfg.url ? fallback.model : null }, { task_id: taskId });
      if (fallback.url === cfg.url) return finishInternal(taskId, u, 'failed', `Model unavailable: ${errText(e)}`, true);
      used = fallback;
      reply = await callModel(used, messages);
    }
    try {
      act = agent.parseAction(reply);
    } catch (e: any) {   // one retry with the error shown to the model
      await logEvent(u.emp_id, 'model_parse_error', { error: errText(e).slice(0, 200), reply: reply.slice(0, 500) }, { task_id: taskId });
      messages = [...messages, { role: 'assistant', content: reply },
        { role: 'user', content: `That was not valid (${errText(e)}). Reply with ONE JSON object only.` }];
      reply = await callModel(used, messages);
      try {
        act = agent.parseAction(reply);
      } catch (e2: any) {
        await logEvent(u.emp_id, 'model_parse_error', { error: errText(e2).slice(0, 200), reply: reply.slice(0, 500) }, { task_id: taskId });
        act = { action: 'fail', summary: FAIL_FIX, thought: '' };
      }
    }
  }

  const correct = async (note: string, event: string) => {
    await logEvent(u.emp_id, event, { action: act, note }, { task_id: taskId });
    messages = [...messages, { role: 'assistant', content: JSON.stringify(Object.fromEntries(Object.entries(act).filter(([k]) => !k.startsWith('_')))) },
      { role: 'user', content: note }];
    try {
      return agent.parseAction(await callModel(used, messages));
    } catch {
      return { action: 'fail', summary: FAIL_FIX, thought: '' };
    }
  };

  const byId = new Map<number, any>(page.elements.map((e: any) => [e.id, e]));

  // Recover from an element number that is not on the page (once), instead of giving up
  if (ID_ACTIONS.includes(act.action) && !byId.has(act.id))
    act = await correct(`Element [${act.id ?? 'None'}] is not on this page. Choose an element from the ELEMENTS list ` +
      '(or navigate / ask_user).', 'element_not_found');
  if (act.action === 'fill_form') {
    act.fields = (act.fields || []).filter((f: any) => byId.has(f.id) && String(f.value ?? '').trim());
    if (!act.fields.length)
      act = await correct('Those element numbers are not on this page or the values are empty. Use element numbers ' +
        "from the ELEMENTS list, or ask_user for values you don't know.", 'element_not_found');
  }
  if (act.action === 'click_xy' && !image)
    act = await correct('click_xy is only possible with a screenshot. Use an element number from the list.', 'element_not_found');

  // Loop guard: the same action again on an unchanged page means the model is stuck
  // Same action on the same element of the same page; element numbers alone are reused across pages
  const sig = (a: any, el: any = null, pageUrl: any = null) => {
    el = el || {};
    return stable({ action: a.action ?? null, value: a.value ?? null, url: a.url ?? null, fields: a.fields ?? null,
      el: [el.tag ?? null, el.text ?? null, el.label ?? null], page: pageUrl ?? null });
  };
  const recent = evs.filter((e) => e.event_type === 'model_action').slice(-2).reverse().map((r) => sig(r.payload.action, r.payload.element, r.url));
  const curSig = (a: any) => sig(a, byId.get(a.id), page.url);
  const pageUnchanged = (page.text || '') === LAST_PAGE_TEXT.get(taskId);   // a real repeat changed nothing
  let looped = false;
  if (!['done', 'fail', 'ask_user'].includes(act.action) && recent.length && recent[0] === curSig(act) && pageUnchanged) {
    looped = true;
    await logEvent(u.emp_id, 'loop_detected', { repeated: act }, { task_id: taskId });
    if (wf) {   // a replayed step that doesn't work: stop replaying, let the model decide
      st.workflow = wf = null;
      st.drift = 1;
    }
    if (recent.length > 1 && recent[1] === curSig(act)) act = { action: 'fail', summary: 'Stopped: the assistant kept repeating the same step.', thought: '' };
    else {
      act = await correct('You already did exactly that in the previous step and the page is as shown. ' +
        'Choose a DIFFERENT action that makes progress (e.g. click a link or fill a field).', 'loop_correction');
      if (curSig(act) === recent[0])   // corrected, yet the same action again: never execute it twice
        act = { action: 'fail', summary: 'Stopped: the assistant kept repeating the same step.', thought: '' };
    }
  }

  // Reality checks: a claimed success must be visible on the page, and forms must be complete
  // before we ask the user to confirm. One correction round each; then report honestly.
  const submittedSomething = await wentThrough(taskId);
  // Claims of having changed something need proof on the page; "find X and tell me" answers don't
  const claimsChange = act.action === 'done' && (submittedSomething || agent.claimsAction(act.summary || ''));
  const prevText = LAST_PAGE_TEXT.get(taskId) || '';
  if (act.action === 'done' && submittedSomething && !agent.pageShowsSuccess(page, prevText)) {
    // It did act (the user confirmed), but the site shows no confirmation. Never push the model to act
    // again here: that can repeat a destructive action. Report honestly and let the person check.
    await logEvent(u.emp_id, 'done_unverified', { action: act }, { task_id: taskId });
    act = { action: 'done', unverified: true, thought: act.thought || '',
      summary: `${act.summary || ''} — note: the site did not show a confirmation message, please check that it went through.` };
  } else if (claimsChange && !agent.pageShowsSuccess(page, prevText)) {
    act = await correct('The current page does NOT show any success message or reference number, so the task is not done. ' +
      'Look at the page again and continue (fill missing fields, then submit).', 'done_rejected');
    if (act.action === 'done' && agent.claimsAction(act.summary || '') && !agent.pageShowsSuccess(page, prevText))
      act = { action: 'fail', summary: 'Could not confirm the task was completed: the site shows no success message. Please check the page.', thought: '' };
  }
  let missing: string[] = [];
  if (agent.needsConfirmation(act, page) && (missing = agent.missingRequired(page)).length) {
    act = await correct(`Do not submit yet. These required fields are still empty: ${missing.join(', ')}. Fill them first, ` +
      "or use ask_user if you don't know the value.", 'submit_blocked_incomplete');
    if (agent.needsConfirmation(act, page) && (missing = agent.missingRequired(page)).length) {
      // Still trying to submit an incomplete form: get the value from the person and fill it in
      // ourselves (the model has shown it won't). Never ask the same question twice.
      const answered: Record<string, any> = {};
      for (const r of await taskEvents(taskId)) if (r.event_type === 'user_answer') answered[r.payload.field] = r.payload.answer;
      const slug = (label: string) => 'fill_' + (label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const fields = agent.missingRequiredFields(page);
      const radios = agent.missingRadioGroups(page);   // e.g. "ID proof": Aadhaar / PAN / Passport
      const known = fields.find((e: any) => answered[slug(e.label)] && !NON_ANSWER.test(answered[slug(e.label)]));
      const norm = (x: string) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const chosen = radios.map((r) => {
        const a = answered[slug(r.group)];
        return a && r.options.find((o) => norm(o.label) && (norm(a) === norm(o.label) || norm(a).includes(norm(o.label))));
      }).find(Boolean);
      const unasked = radios.find((r) => !(slug(r.group) in answered));
      if (known) act = { action: known.tag === 'select' ? 'select' : 'type', id: known.id, value: answered[slug(known.label)], thought: 'Filling in the value you gave me.' };
      else if (fields.length && !(slug(fields[0].label) in answered))
        act = { action: 'ask_user', field: slug(fields[0].label), question: `What should I enter for '${fields[0].label ?? 'None'}'?`, remember: false,
          thought: 'A required field is still empty.' };
      else if (chosen) act = { action: 'click', id: chosen.id, thought: `Choosing "${chosen.label}" as you said.` };
      else if (unasked)
        act = { action: 'ask_user', field: slug(unasked.group), question: `Which one for '${unasked.group}'?`, options: unasked.options.map((o) => o.label),
          remember: false, thought: 'A required choice is still empty.' };
      else act = { action: 'fail', summary: `Could not complete the form: ${missing.join(', ')} still empty.`, thought: '' };
    }
  }
  // Pre-submit verifier: what the request spells out (dates, amounts, IDs) must be on the form. One correction.
  let fixAct: any;
  if (agent.needsConfirmation(act, page) && (fixAct = agent.rowFix(act, page, t.prompt, today))) {
    await logEvent(u.emp_id, 'row_corrected', { from: act, to: fixAct }, { task_id: taskId });
    act = fixAct;
  }
  let c = agent.needsConfirmation(act, page);
  if (c) {
    const [answers, typed] = await taskValues(taskId);
    const prov = agent.provenance(c.fields, t.prompt, profile, answers, typed, today);
    const bad = prov.find((f: any) => f._reference || (f._profile_key && !agent.profileFits(f._profile_key, f.label || '')));
    st.fix_asked = st.fix_asked || new Set<string>();
    if (bad && bad.label && !st.fix_asked.has(bad.label)) {
      // e.g. the user's own phone in "Emergency Contact Number", or "my desk" as a desk number: ask for that value
      st.fix_asked.add(bad.label);
      const field = slug2(bad.label);
      st.fix_field = { field, label: bad.label };
      await logEvent(u.emp_id, 'presubmit_mismatch', { action: act, note: `ask for ${bad.label}` }, { task_id: taskId });
      act = { action: 'ask_user', field, question: `What should I enter for '${bad.label}'?`, remember: !ONE_OFF_FIELD.test(field),
        thought: `"${bad.value}" is not right for ${bad.label}.` };
    }
  }
  if ((c = agent.needsConfirmation(act, page)) && !st.verified_once) {
    let checks: string[] = (await buildConfirmation(taskId, t, page, c, profile, today)).checks.filter((x: string) => !x.includes('myself'));
    if (checks.length && drawing && visionOk && (st.vision_tries || 0) < 3 && checks.some((x) => x.includes('selected'))) {
      // the wrong thing is selected in the drawing (e.g. seat C2 instead of C3): look at it again
      st.vision_tries = (st.vision_tries || 0) + 1;
      st.vision_reason = 'drawing';
      await logEvent(u.emp_id, 'presubmit_mismatch', { action: act, note: checks.join(' ') }, { task_id: taskId });
      act = { action: 'look', thought: 'The page does not show what you asked for yet: looking at the drawing again.' };
      checks = [];
    }
    if (checks.length) {
      st.verified_once = true;
      const fixed = await correct('Before submitting, check the form against the GOAL: ' + checks.join(' ') +
        ' Fix the form (or, if it is right, click the same button again).', 'presubmit_mismatch');
      if (fixed.action !== 'fail') act = fixed;   // no usable fix: the user sees the checks in the confirmation instead
    }
  }

  let element = byId.get(act.id);
  // Mechanical fixes for common slips
  if (act.action === 'click' && element?.type === 'file')
    act = { action: 'upload', id: act.id, thought: act.thought || '', question: `Which file should I attach for '${element.label || 'the file field'}'?` };
  if (act.action === 'upload' && element && (!act.question || /ask the user|which file to/i.test(act.question)))
    act.question = `Which file should I attach for '${element.label || 'the file field'}'?`;
  if (act.action === 'type' && element?.readonly && agent.parseDates(act.value || '', today).size)
    act = { ...act, action: 'pick_date', value: [...agent.parseDates(act.value, today)].sort()[0] };
  else if (act.action === 'type' && element?.readonly) {
    // A read-only box filled by the button next to it ("Cost centre [....] [Lookup...]"): typing can't work, so press the
    // button (the model then picks the value in what opens). Without this, models retry the typing until stopped.
    const els: any[] = page.elements || [];
    const next = els[els.findIndex((e: any) => e.id === element.id) + 1];
    if (next && (next.frame || null) === (element.frame || null) && (next.tag === 'button' || next.tag === 'a' || ['button', 'submit'].includes(next.type))
        && /lookup|select|choose|pick|browse|search|find|\.\.\.|…/i.test(`${next.text || ''} ${next.label || ''}`) && !/submit|save|create|send/i.test(next.text || '')) {
      act = { action: 'click', id: next.id, thought: `'${element.label || 'This field'}' is filled with its '${next.text || next.label}' button.` };
      element = next;
    }
  }
  if (['type', 'select', 'autocomplete', 'pick_date'].includes(act.action) && element && !String(act.value ?? '').trim()) {
    // An empty value means the model doesn't know it: ask the person instead of typing nothing
    const label = element.label || element.text || 'this field';
    const field = slug2(label);
    act = { action: 'ask_user', field, question: `What should I enter for '${label}'?`, remember: !ONE_OFF_FIELD.test(field), thought: "I don't know this value." };
  }
  // Sign-in pages are the person's job (user name too): never fill them in, ask the user to sign in
  if (isLoginPage(page) && (['type', 'fill_form', 'autocomplete'].includes(act.action) || (act.action === 'click' && element?.type === 'submit'))) {
    act = { action: 'ask_user', field: 'user_action', question: 'Please sign in on the page yourself, then press Continue.',
      thought: 'Signing in is done by you; I never type sign-in details.' };
    element = undefined;
  }
  let blocked: string | null = null;
  if (ID_ACTIONS.includes(act.action) && !element) blocked = `element [${act.id ?? 'None'}] is not on the page`;
  else if (act.action === 'type' && element?.type === 'password')
    act = { action: 'ask_user', field: 'user_action', question: 'This page needs your password. Please sign in on the page yourself, then press Continue.',
      thought: 'Assistant never types passwords.' };
  else if (act.action === 'navigate' && !pol.allowedSites.some((s) => fnmatch(hostOf(act.url), s)))
    blocked = `navigation to ${act.url ?? 'None'} is outside the allowed sites`;
  if (blocked) act = { action: 'fail', summary: `Blocked by policy: ${blocked}.`, thought: act.thought || '' };
  // Don't give up on the first obstacle (once per task): wrong page, a widget that needs another approach
  const summ = act.summary || '';
  if (act.action === 'fail' && !/^(Blocked|Stopped|Could not)/.test(summ) && summ !== FAIL_FIX && !st.fail_retry && t.steps < pol.maxSteps - 2) {
    st.fail_retry = true;
    const retry = await correct('Do not give up yet. If this is the wrong page, navigate to the start URL in the SITE PLAYBOOKS. ' +
      'If a field does not work, try another way (pick_date, autocomplete, the button or icon next to it, ' +
      'a pop-up window). Reply fail only if there is really no way.', 'fail_retry');
    if (retry.action !== 'fail') {
      act = retry;
      element = byId.get(act.id);
    }
  }

  // Vision fallback: before giving up, or when the target is a drawing, look at a screenshot (vision models only)
  const wantLook = (act.action === 'fail' && !/^(Blocked|Stopped)/.test(act.summary || '')) || (act.action === 'click' && element?.type === 'drawing');
  if (visionOk && wantLook && !image && (st.vision_tries || 0) < 3) {
    st.vision_tries = (st.vision_tries || 0) + 1;
    if (element?.type === 'drawing' || page.elements.some((e: any) => e.type === 'drawing')) st.vision_reason = 'drawing';
    await logEvent(u.emp_id, 'vision_fallback', { instead_of: mask(act) }, { task_id: taskId });
    act = { action: 'look', thought: 'Taking a screenshot to see the page.' };
    element = undefined;
    st.fails = Math.max(st.fails, 2);
  }

  LAST_PAGE_TEXT.set(taskId, page.text || '');
  st.last_where = whereAmI(page);
  let confirm = agent.needsConfirmation(act, page);
  if (confirm && (await justConfirmed(taskId, element))) confirm = null;   // e.g. "Place order" then the site's own "Yes, place order": ask once
  if (confirm) {
    confirm = await buildConfirmation(taskId, t, page, confirm, profile, today);
    // Doing the same final action twice in one task (a second "Send") is almost always a mistake
    const same = (await approvals(taskId)).filter(([button, ok]) => ok && button === confirm.button).length;
    if (same) confirm.warning = `You already approved "${confirm.button}" ${same} time(s) in this task. ` +
      'Approving again will do it again (for example, send a second email).';
  }
  let fieldsInfo: any[] | null = null;
  if (act.action === 'fill_form') {
    fieldsInfo = act.fields.map((f: any) => {
      const e = byId.get(f.id) || {};
      return { id: f.id, label: e.label || e.text || null, kind: e.tag === 'select' ? 'select' : e.readonly ? 'pick_date' : 'type' };
    });
  }
  const fromWorkflow = '_macro_step' in act;
  if (wf) skills.advance(wf, act, element, fieldsInfo);
  act = Object.fromEntries(Object.entries(act).filter(([k]) => !k.startsWith('_')));
  await store.update<Task>('tasks', taskId, (x) => x && { ...x, steps: x.steps + 1, model: used.model, model_url: used.url });
  await logEvent(u.emp_id, 'model_action', {
    action: mask(act), element: element ? Object.fromEntries(['tag', 'type', 'label', 'text', 'menu', 'row', 'frame', 'readonly', 'href'].map((k) => [k, element[k] ?? null])) : null,
    fields_info: fieldsInfo, source: fromWorkflow ? 'workflow' : 'model', needs_confirmation: !!confirm, model: used.model, model_url: used.url,
  }, { task_id: taskId, url: page.url ?? null });
  if (['done', 'fail'].includes(act.action)) {
    const status = act.action === 'fail' ? 'failed' : act.unverified ? 'unverified' : 'completed';
    await finishInternal(taskId, u, status, act.summary || '');
  }
  // Vision fallback: stuck or failing repeatedly -> ask for a screenshot with numbered boxes next step
  const wantScreenshot = (looped || st.fails >= 2 || act.action === 'look') && !['done', 'fail'].includes(act.action);
  return { action: act, needs_confirmation: !!confirm, confirmation: confirm || null, host, want_screenshot: wantScreenshot };
});

route('POST', '/api/tasks/:id/dialog', async ({ user: u, body, params }) => {
  // The site asked "Are you sure...?" (a native confirm) for an action the user had not approved: build the
  // confirmation to show the user, with the site's own question.
  const t = await ownTask(params.id, u);
  const page = body.page || {};
  const el = (page.elements || []).find((e: any) => e.id === body.id) || {};
  let c = agent.confirmationFor(el, page, body.message);
  c = await buildConfirmation(params.id, t, page, c, await getProfile(u.emp_id), await todayDate());
  await logEvent(u.emp_id, 'site_dialog', { message: body.message, element: { text: el.text ?? null, row: el.row ?? null } },
    { task_id: params.id, url: page.url ?? null });
  return c;
});

route('POST', '/api/tasks/:id/events', async ({ user: u, body, params }) => {
  const t = await ownTask(params.id, u);
  if (!['confirmation', 'screenshot', 'client_error', 'user_cancelled', 'file_chosen'].includes(body.event_type)) throw new ApiError(400, 'Unknown event type');
  const shot = body.screenshot_b64 ? await saveShot(params.id, body.screenshot_b64) : null;
  await logEvent(u.emp_id, body.event_type, mask(body.payload || {}), { task_id: params.id, url: body.url ?? null, screenshot: shot });
  if (['user_cancelled', 'client_error'].includes(body.event_type) && t.status === 'running')
    await finishInternal(params.id, u, body.event_type === 'user_cancelled' ? 'cancelled' : 'failed', (body.payload || {}).reason ?? body.event_type);
  return { ok: true, screenshot: shot };
});

// ---------------------------------------------------------------- teach mode and playbooks

function eventsAsText(events: any[]): string {
  const out: string[] = [];
  for (const e of events) {
    const k = e.kind;
    if (k === 'navigate') out.push(`Opened page "${e.title ?? 'None'}" ${e.url ?? 'None'}`);
    else if (k === 'click')
      out.push(`Clicked ${e.tag === 'a' ? 'link' : 'button'} "${e.text || e.label || 'None'}"` +
        (e.menu ? ` in the "${e.menu}" menu (opens on hover)` : '') + (e.row ? ` in the table row "${e.row.slice(0, 60)}"` : ''));
    else if (k === 'fill' && e.autocomplete) out.push(`Typed into "${e.label ?? 'None'}" and picked "${e.value ?? 'None'}" from the suggestions`);
    else if (k === 'fill') out.push(`${e.readonly ? 'A pop-up filled' : 'Typed'} "${e.value ?? 'None'}" into field "${e.label ?? 'None'}"`);
    else if (k === 'date') out.push(`Picked the date "${e.value ?? 'None'}" for "${e.label ?? 'None'}" in the calendar`);
    else if (k === 'upload') out.push(`Attached a file ("${e.value ?? 'None'}") to "${e.label ?? 'None'}"`);
    else if (k === 'choose') out.push(`Chose "${e.value ?? 'None'}" for "${e.label ?? 'None'}"`);
  }
  return out.map((x, i) => `${i + 1}. ${x}`).join('\n');
}

route('POST', '/api/teach/draft', async ({ user: u, body }) => {
  const events = (body.events || []).filter((e: any) => e.value !== '(hidden)');   // never pass on passwords
  const recording = eventsAsText(events);
  await logEvent(u.emp_id, 'teach_recorded', { name: body.name, site: body.site, steps: events.length, recording: recording.slice(0, 4000) });
  const cfg = await modelCfg(u.emp_id);
  let steps: string;
  try {
    steps = agent.parsePlaybook(await callModel(cfg, [{ role: 'system', content: agent.TEACH_PROMPT },
      { role: 'user', content: `Workflow name: ${body.name}\n\nRECORDING:\n${recording}` }], { schema: agent.PLAYBOOK_SCHEMA }));
  } catch (e: any) {
    steps = `Start URL: ${events.length ? events[0].url : ''}\n` + recording;   // fall back to the raw recording
    await logEvent(u.emp_id, 'model_error', { where: 'teach_draft', error: errText(e).slice(0, 200) });
  }
  return { steps, recording };
});

route('GET', '/api/playbooks', async () => (await allPlaybooks()).sort((a, b) => b.id - a.id));

route('POST', '/api/playbooks', async ({ user: u, body }) => {
  // There is no central server to approve it: a taught playbook works at once in this browser. To share it with
  // everyone, an admin adds it to the "playbooks" browser policy.
  const status = 'active';
  const events = body.events || [];   // structure only: macroFromTeach keeps labels/buttons, drops sign-in and values
  const macro = events.length ? JSON.stringify(skills.macroFromTeach(events)) : null;
  const id = await store.tx('playbooks', 'readwrite', async (tr) => {
    const s = tr.objectStore('playbooks');
    const last = await store.req(s.openCursor(null, 'prev'));
    const next = Math.max(1000, last ? Number(last.key) + 1 : 1000);   // taught ones from 1000: never clash with shared ones
    await store.req(s.add({ id: next, site: body.site, task: body.task, steps: body.steps, updated_by: u.emp_id, updated_at: store.now(),
      status, source: 'teach', macro }));
    return next;
  });
  await logEvent(u.emp_id, 'playbook_created', { id, site: body.site, task: body.task, status, steps: body.steps });
  return { id, status };
});

route('POST', '/api/playbooks/:id/approve', async ({ user: u, params }) => {
  requireRole(u, 'admin');
  const id = Number(params.id);
  const p = (await allPlaybooks()).find((x) => x.id === id);
  if (p) await store.put('playbooks', { ...p, status: 'active', updated_at: store.now() });
  await logEvent(u.emp_id, 'playbook_approved', { id });
  return { ok: true };
});

route('GET', '/api/admin/playbooks', () => allPlaybooks());

route('PUT', '/api/admin/playbooks/:id', async ({ user: u, params, body }) => {
  requireRole(u, 'admin');
  const id = Number(params.id);
  const p = (await allPlaybooks()).find((x) => x.id === id);
  if (p) await store.put('playbooks', { ...p, steps: body.steps, updated_by: u.emp_id, updated_at: store.now() });
  await logEvent(u.emp_id, 'playbook_changed', { id, steps: body.steps });
  return allPlaybooks();
});

route('GET', '/api/admin/playbook-health', async ({ user: u }) => {
  // How each site and each replayed workflow has been doing (auditors and admins)
  if (!u.roles.some((r) => ['auditor', 'admin'].includes(r))) throw new ApiError(403, 'Auditors and admins only');
  const names = new Map<string, string>();
  for (const p of await allPlaybooks()) names.set(`playbook:${p.id}`, `taught: ${p.task}`);
  for (const e of await store.all('experiences')) names.set(`experience:${e.id}`, `learned: ${e.goal.slice(0, 60)}`);
  return (await skills.health()).map((h) => ({ ...h, name: names.get(h.key) || h.key }));
});

route('GET', '/api/admin/experiences', async ({ user: u }) => {
  requireRole(u, 'admin');
  return (await store.all('experiences')).sort((a: any, b: any) => b.id - a.id);
});

route('DELETE', '/api/admin/experiences/:id', async ({ user: u, params }) => {
  requireRole(u, 'admin');
  await store.del('experiences', Number(params.id));
  await logEvent(u.emp_id, 'experience_deleted', { id: Number(params.id) });
  return { ok: true };
});
