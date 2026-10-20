// Workflows the assistant has seen work: taught demonstrations and its own successful runs ("experiences").
//
// A workflow is a list of steps. Steps that are the same every time (open a menu, click "Travel Request",
// click "Submit") are replayed directly, without asking the model; steps whose value depends on the request
// (type the destination, pick the dates) are left to the model, with the workflow shown as a hint. Any step
// that can't be found on the page hands control back to the model, so a changed site degrades to the normal
// agent instead of breaking. The final submit still goes through the usual confirmation.
import { stable, taskEvents } from './audit';
import * as store from './store';
import { hostOf, similarity } from './text';

export { similarity, words } from './text';

const VALUE_ACTIONS = new Set(['type', 'select', 'pick_date', 'autocomplete', 'upload']);
const FIXED_ACTIONS = new Set(['click', 'hover']);

export interface Step { action: string; url?: string; host?: string; text?: string; label?: string; menu?: string | null; param?: boolean }
export interface WorkflowState { steps: Step[]; cursor: number; label: string; source?: string; misses?: number }

const norm = (s: any) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Clicks that depend on the request: calendar days and arrows, a specific table row, a value that was typed or
 *  that comes from the request (a suggestion "Priya Sharma (Engineering)", a lookup entry "Engineering - Bangalore"). */
export function isParamClick(text: string, row: string | null | undefined, demoValues: Set<string>, goal = '', el: any = null): boolean {
  const t = norm(text);
  if (!!row || !t || /^(\d{1,2}|[<>‹›«»]+|next|prev|previous)$/.test((text || '').trim().toLowerCase())) return true;
  if (demoValues.has(t) || [...demoValues].some((v) => v.length >= 3 && t.includes(v))) return true;
  el = el || {};
  const href = (el.href || '').trim();
  const navigation = el.menu || el.tag === 'button' || ['submit', 'button'].includes(el.type) ||
    (href && !href.endsWith('#') && !href.toLowerCase().startsWith('javascript:')) || (el.tag === 'a' && !('href' in el));
  return !navigation && t.length >= 5 && norm(goal).includes(t);
}

export function stepText(st: Step): string {
  if (st.action === 'navigate') return `open ${st.url}`;
  const target = st.text || st.label || '?';
  const where = st.menu ? ` (in menu ${st.menu})` : '';
  if (VALUE_ACTIONS.has(st.action)) return `${st.action} '${st.label || target}' <value from the request>`;
  if (st.param) return `click the right '${target}' for this request${where}`;
  return `${st.action} '${target}'${where}`;
}

const sameStep = (a: Step, b: Step) => stable(a) === stable(b);

// ---------------------------------------------------------------- building workflows

/** Recorder events -> workflow steps. */
export function macroFromTeach(events: any[]): Step[] {
  const steps: Step[] = [];
  const demo = new Set(events.filter((e) => ['fill', 'choose'].includes(e.kind) && e.value).map((e) => norm(e.value)));
  // signing in is always done by the person: leave out what was typed on sign-in pages
  const loginUrls = new Set(events.filter((e) => e.kind === 'fill' && e.value === '(hidden)').map((e) => e.url));
  for (const e of events) {
    if (loginUrls.has(e.url) && e.kind !== 'navigate') continue;
    const k = e.kind;
    if (k === 'navigate' && !steps.length) steps.push({ action: 'navigate', url: e.url, host: hostOf(e.url) || undefined });
    else if (k === 'click') {
      if (e.readonly) continue;   // clicked a read-only box: a picker follows, the "date" event covers it
      const text = e.text || e.label || '';
      steps.push({ action: 'click', text, menu: e.menu ?? null, param: isParamClick(text, e.row, demo) });
    } else if (['fill', 'choose', 'date', 'upload'].includes(k)) {
      let action = ({ fill: 'type', choose: 'select', date: 'pick_date', upload: 'upload' } as any)[k];
      if (e.autocomplete) action = 'autocomplete';
      steps.push({ action, label: e.label ?? null, param: true });
    }
  }
  // pick_date covers the calendar: drop the clicks that opened it and picked the day/month around a date step
  // (the date of a picker is often reported a step late, so drop every calendar click once there is a date step)
  const calendarish = (st: Step) => st.action === 'click' && (
    /^(\d{1,2}|[<>‹›«»]+|next|prev|previous|today)$/.test((st.text || '').trim().toLowerCase()) ||
    /\b(pick|calendar|date)\b/.test((st.text || '').toLowerCase()));
  const hasDates = steps.some((st) => st.action === 'pick_date');
  const out: Step[] = [];
  steps.forEach((st) => {
    if ((hasDates && calendarish(st)) || (out.length && sameStep(out[out.length - 1], st))) return;
    out.push(st);
  });
  return out;
}

/** The model actions of a successful task -> workflow steps (only actions that worked and the site accepted). */
export async function macroFromRun(taskId: string, goal = ''): Promise<Step[]> {
  const rows = (await taskEvents(taskId)).filter((e) => ['model_action', 'action_result'].includes(e.event_type));
  const steps: Step[] = [];
  let pending: any = null;
  const demo = new Set<string>();
  for (const r of rows) {
    let p = r.payload;
    if (r.event_type === 'model_action') {
      pending = p;
      const a = p.action;
      if (VALUE_ACTIONS.has(a.action) && a.value) demo.add(norm(a.value));
      for (const f of a.fields || []) demo.add(norm(f.value));
      continue;
    }
    if (!pending) continue;
    const rejected = p.dialog?.kind === 'alert' || (p.observed || '').includes('errors shown');
    const ok = p.ok && !rejected;
    p = pending;
    pending = null;
    const a = p.action, el = p.element || {};
    if (!ok || ['ask_user', 'done', 'fail', 'click_xy', 'look'].includes(a.action)) continue;
    if (a.action === 'navigate') continue;
    if (a.action === 'fill_form') {
      for (const f of p.fields_info || []) steps.push({ action: f.kind || 'type', label: f.label, param: true });
      continue;
    }
    if (VALUE_ACTIONS.has(a.action)) {
      steps.push({ action: a.action, label: el.label || el.text, param: true });
      continue;
    }
    const text = el.text || el.label || '';
    steps.push({ action: a.action, text, menu: el.menu ?? null, param: isParamClick(text, el.row, demo, goal, el) });
  }
  const out: Step[] = [];
  for (const st of steps) if (!out.length || !sameStep(out[out.length - 1], st)) out.push(st);
  return out;
}

// ---------------------------------------------------------------- replay

function find(st: Step, page: any) {
  const want = norm(st.text || st.label);
  if (!want) return null;
  for (const el of page.elements || []) {
    if (['input', 'select', 'textarea'].includes(el.tag) && !['submit', 'button'].includes(el.type)) continue;
    if (norm(el.text) === want || norm(el.label) === want) {
      if (st.menu && el.menu && norm(el.menu) !== norm(st.menu)) continue;
      return el;
    }
  }
  return null;
}

function fieldMatches(st: Step, el: any): boolean {
  const want = norm(st.label);
  const have = el ? [norm(el.label), norm(el.text)] : [];
  // the same field reached through its icon counts too ("To date" / "Pick to date")
  return !!want && have.some((h) => h && (h === want || (want.length >= 4 && h.includes(want))));
}

/** Next step of the workflow: [action to execute directly, or null; hint for the model]. */
export function suggest(state: WorkflowState, page: any, host: string): [any, string | null] {
  const { steps } = state;
  const i = state.cursor;
  if (i >= steps.length) return [null, null];
  const st = steps[i];
  if (st.action === 'navigate') {
    state.cursor = i + 1;
    if (host && st.host && host !== st.host)
      return [{ action: 'navigate', url: st.url, thought: `Following the ${state.label}: open the site.` }, null];
    return suggest(state, page, host);
  }
  // a value step whose field is not on this page (already done, or the site skipped it): look a few steps ahead
  const onPage = (x: Step) => FIXED_ACTIONS.has(x.action) ? find(x, page) : (page.elements || []).find((e: any) => fieldMatches(x, e)) || null;
  if ((VALUE_ACTIONS.has(st.action) || st.param) && !onPage(st)) {
    for (let j = i + 1; j < Math.min(i + 4, steps.length); j++) {
      if (steps[j].action !== 'navigate' && onPage(steps[j])) {
        state.cursor = j;
        return suggest(state, page, host);
      }
    }
  }
  if (FIXED_ACTIONS.has(st.action) && !st.param) {
    // this step, or one of the next two fixed steps if the page skipped ahead (e.g. already on the form)
    for (let j = i; j < Math.min(i + 3, steps.length); j++) {
      const sj = steps[j];
      if (VALUE_ACTIONS.has(sj.action) || sj.param) break;
      const el = find(sj, page);
      if (el) return [{ action: sj.action, id: el.id, _macro_step: j, thought: `Following the ${state.label}: ${stepText(sj)}.` }, null];
    }
    state.misses = (state.misses || 0) + 1;
  }
  return [null, hint(state)];
}

export function hint(state: WorkflowState): string {
  const { steps, cursor: i } = state;
  const lines: string[] = [];
  steps.forEach((st, j) => {
    if (st.action === 'navigate') return;
    const mark = j < i ? 'done' : j === i ? 'NEXT' : '';
    lines.push(`${j < i ? '✓' : j === i ? '→' : ' '} ${stepText(st)}` + (mark ? `   (${mark})` : ''));
  });
  return `WORKFLOW THAT WORKED BEFORE (${state.label}; the values must come from the GOAL, not from here):\n` + lines.join('\n');
}

/** Move the cursor past the steps the latest action covered. */
export function advance(state: WorkflowState, act: any, element: any, fieldsInfo: any[] | null = null) {
  const { steps } = state;
  if ('_macro_step' in act) {
    state.cursor = act._macro_step + 1;
    return;
  }
  const targets: [string, any][] = act.action === 'fill_form' ? (fieldsInfo || []).map((f) => [f.kind, { label: f.label }]) : [[act.action, element]];
  for (const [kind, el] of targets) {
    for (let j = state.cursor; j < Math.min(state.cursor + 6, steps.length); j++) {
      const st = steps[j];
      const sameKind = (VALUE_ACTIONS.has(st.action) && VALUE_ACTIONS.has(kind)) || st.action === kind;
      if (sameKind && (fieldMatches(st, el) || (el && norm(st.text) && norm(st.text) === norm(el.text)))) {
        state.cursor = j + 1;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- choosing a workflow for a new task

/** A taught workflow for a matching playbook, else the closest successful run (experience). */
export async function pickWorkflow(goal: string, playbooks: any[]): Promise<WorkflowState | null> {
  let best: [number, WorkflowState] | null = null;
  for (const p of playbooks) {
    if (!p.macro) continue;
    const s = similarity(goal, `${p.task} ${p.steps}`);
    if (s >= 0.3 && (!best || s > best[0]))
      best = [s, { steps: typeof p.macro === 'string' ? JSON.parse(p.macro) : p.macro, cursor: 0, label: `taught workflow '${p.task}'`,
        source: `playbook:${p.id}` }];
  }
  if (best) return best[1];
  const exps = (await store.all('experiences')).sort((a: any, b: any) => b.successes - a.successes || b.id - a.id).slice(0, 200);
  for (const r of exps) {
    const s = similarity(goal, r.goal);
    if (s >= 0.6 && (!best || s > best[0]))
      best = [s, { steps: r.steps, cursor: 0, label: `successful run for '${r.goal.slice(0, 60)}'`, source: `experience:${r.id}` }];
  }
  return best ? best[1] : null;
}

export async function mainSite(taskId: string): Promise<string> {
  const hosts = new Map<string, number>();
  for (const e of await taskEvents(taskId)) {
    if (e.event_type !== 'model_action') continue;
    const h = hostOf(e.url);
    if (h) hosts.set(h, (hosts.get(h) || 0) + 1);
  }
  hosts.delete('intranet.office.local');
  let best = '', n = 0;
  for (const [h, c] of hosts) if (c > n) { best = h; n = c; }
  return best;
}

/** After a verified success: remember how it was done (structure only: labels and buttons, never values). */
export async function learnFromTask(taskId: string, goal: string, now: string): Promise<number | null> {
  const steps = await macroFromRun(taskId, goal);
  if (steps.filter((s) => s.action !== 'navigate').length < 2) return null;
  const site = await mainSite(taskId);
  const sig = stable(steps);
  for (const r of await store.all('experiences')) {
    if (r.site === site && stable(r.steps) === sig) {
      await store.update('experiences', r.id, (x: any) => ({ ...x, successes: x.successes + 1, last_used: now }));
      return r.id;
    }
  }
  return store.add('experiences', { site, goal, steps, task_id: taskId, successes: 1, failures: 0, created_at: now, last_used: now });
}

/** Per site and per workflow: how recent tasks went. Flags workflows that stopped matching the site. */
export async function health(): Promise<any[]> {
  const out = new Map<string, any>();
  const rows = (await store.all('outcomes')).sort((a: any, b: any) => (a.ended_at < b.ended_at ? -1 : a.ended_at > b.ended_at ? 1 : 0));
  for (const r of rows) {
    for (const key of [r.site && `site:${r.site}`, r.workflow].filter(Boolean)) {
      if (!out.has(key)) out.set(key, { key, runs: 0, completed: 0, unverified: 0, failed: 0, cancelled: 0, drift: 0, recent: [], last_problem: null });
      const h = out.get(key);
      h.runs++;
      h[['completed', 'unverified', 'failed', 'cancelled'].includes(r.status) ? r.status : 'failed']++;
      h.drift += r.drift || 0;
      h.recent = [...h.recent, r.status].slice(-5);
      if (r.status !== 'completed') h.last_problem = { when: r.ended_at, status: r.status, summary: r.summary };
    }
  }
  for (const h of out.values()) {
    const recentFail = h.recent.filter((s: string) => ['failed', 'unverified'].includes(s));
    const last3 = h.recent.slice(-3);
    h.status = last3.length && last3.every((s: string) => s === 'failed') && h.recent.length >= 3 ? 'broken'
      : recentFail.length >= 2 || h.drift >= 2 ? 'needs attention' : 'ok';
    h.success_rate = h.runs ? Math.round((h.completed / h.runs) * 100) / 100 : null;
  }
  return [...out.values()].sort((a, b) => Number(a.status === 'ok') - Number(b.status === 'ok') || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
