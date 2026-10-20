// The agent loop: read page -> decide the next step (lib/local: asks the model, logs everything) -> act.
import { browser, type Browser } from 'wxt/browser';
import { api } from './api';
import { act, ActionResult, endTask, forBackend, PageSnapshot, showWorking, snapshot } from './page';

export interface AgentAction {
  action: 'click' | 'type' | 'select' | 'navigate' | 'ask_user' | 'done' | 'fail' | 'hover' | 'pick_date' | 'autocomplete'
    | 'fill_form' | 'upload' | 'click_xy' | 'look';
  id?: number;
  value?: string;
  url?: string;
  question?: string;
  field?: string;
  options?: string[];
  remember?: boolean;
  summary?: string;
  thought?: string;
  fields?: { id: number; value: string }[];
  x?: number;
  y?: number;
}

export interface Confirmation {
  button: string;
  fields: { label: string; value: string; source?: string; guess?: boolean }[];
  warning?: string;
  checks?: string[];   // pre-submit verifier findings
}

export interface PickedFile {
  name: string;
  type: string;
  data: string; // base64
}

export interface AgentUI {
  step(text: string, kind?: 'info' | 'action' | 'ok' | 'error'): void;
  ask(question: string, options?: string[], isUserAction?: boolean): Promise<string | null>;
  askFile(question: string): Promise<PickedFile | null>;
  confirm(c: Confirmation): Promise<boolean>;
  isStopped(): boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForLoad(tabId: number, timeoutMs = 15000) {
  await sleep(300);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === 'complete') return;
    await sleep(150);
  }
}

/** The web page the assistant works on: the active http(s) tab, else the most recently used one. */
export async function targetTab(): Promise<Browser.tabs.Tab | undefined> {
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  const active = tabs.filter((t) => t.active).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  if (active.length) return active[0];
  return tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

async function screenshot(tab: Browser.tabs.Tab): Promise<string | undefined> {
  try {
    return await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch {
    return undefined;
  }
}

// Numbered boxes over the elements (set-of-marks), so a vision model can refer to them by number
function markInPage(marks: [number, number][]) {
  document.querySelectorAll('.__oa_mark').forEach((m) => m.remove());
  const deep = (root: Document | ShadowRoot, id: number): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-agent-id="${id}"]`) ||
    Array.from(root.querySelectorAll('*')).reduce<HTMLElement | null>((f, h) => f || (h.shadowRoot ? deep(h.shadowRoot, id) : null), null);
  for (const [local, global] of marks) {
    const el = deep(document, local);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > innerHeight) continue;
    const m = document.createElement('div');
    m.className = '__oa_mark';
    m.textContent = String(global);
    m.style.cssText = `position:fixed;left:${r.left}px;top:${Math.max(0, r.top - 12)}px;z-index:2147483647;background:#e11d48;` +
      'color:#fff;font:bold 11px sans-serif;padding:0 3px;border-radius:3px;pointer-events:none';
    const box = document.createElement('div');
    box.className = '__oa_mark';
    box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;` +
      'outline:2px solid #e11d48;z-index:2147483646;pointer-events:none';
    document.body.append(box, m);
  }
}

function clearMarksInPage() {
  document.querySelectorAll('.__oa_mark').forEach((m) => m.remove());
}

async function markedScreenshot(tab: Browser.tabs.Tab, page: PageSnapshot): Promise<string | undefined> {
  const byFrame = new Map<number, [number, number][]>();
  for (const e of page.elements) {
    if (!byFrame.has(e._frameId ?? 0)) byFrame.set(e._frameId ?? 0, []);
    byFrame.get(e._frameId ?? 0)!.push([e._local ?? e.id, e.id]);
  }
  for (const [frameId, marks] of byFrame) {
    await browser.scripting.executeScript({ target: { tabId: tab.id!, frameIds: [frameId] }, func: markInPage, args: [marks] })
      .catch(() => {});
  }
  await showWorking(tab.id!, null);   // the model should see the page, not our overlay
  await sleep(100);
  const shot = await screenshot(tab);
  await browser.scripting.executeScript({ target: { tabId: tab.id!, allFrames: true }, func: clearMarksInPage }).catch(() => {});
  return shot;
}

// Runs in every frame: the frame that contains the screen point (and no deeper frame there) clicks it
function clickAtInPage(x: number, y: number) {
  let ox = 0;
  let oy = 0;
  try {
    for (let w: Window = window; w !== w.top && w.frameElement; w = w.parent) {
      const r = w.frameElement.getBoundingClientRect();
      ox += r.left;
      oy += r.top;
    }
  } catch {
    return null;
  }
  const lx = x - ox;
  const ly = y - oy;
  if (lx < 0 || ly < 0 || lx > innerWidth || ly > innerHeight) return null;
  const el = document.elementFromPoint(lx, ly) as HTMLElement | null;
  if (!el || el.tagName === 'FRAME' || el.tagName === 'IFRAME' || el.tagName === 'FRAMESET') return null;
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: lx, clientY: ly, view: window }));
  }
  return { ok: true, detail: `clicked at ${x},${y} (${el.tagName.toLowerCase()} "${(el.innerText || '').trim().slice(0, 40)}")` };
}

// What the user sees for each step: names from the page, not element numbers
function describe(a: AgentAction, page?: PageSnapshot): string {
  const name = (id?: number) => {
    const el = page?.elements.find((e) => e.id === id);
    const n = (el?.label || el?.text || '').trim();
    return n ? `“${n.length > 40 ? n.slice(0, 40) + '…' : n}”` : id !== undefined ? `item ${id}` : '';
  };
  switch (a.action) {
    case 'click': return `Click ${name(a.id)}`;
    case 'type': return `Type “${a.value}” into ${name(a.id)}`;
    case 'select': return `Choose “${a.value}” for ${name(a.id)}`;
    case 'navigate': return `Open ${a.url}`;
    case 'hover': return `Open the menu ${name(a.id)}`;
    case 'pick_date': return `Pick ${a.value} for ${name(a.id)}`;
    case 'autocomplete': return `Find “${a.value}” in ${name(a.id)}`;
    case 'fill_form': return `Fill in ${(a.fields || []).map((f) => `${name(f.id)} = “${f.value}”`).join(', ')}`;
    case 'upload': return `Attach a file to ${name(a.id)}`;
    case 'click_xy': return `Click at ${a.x},${a.y} on the screen`;
    default: return a.action;
  }
}

export async function runTask(prompt: string, ui: AgentUI): Promise<{ status: string; summary: string; taskId?: string }> {
  let tab = await targetTab();
  if (!tab?.id) {
    await browser.tabs.create({ url: 'about:blank' });
    tab = await targetTab();
  }
  let tabId = tab!.id!;
  const mainTabId = tabId;
  const { task_id: taskId, model } = await api('/api/tasks', 'POST', { prompt, url: tab!.url });
  ui.step(`Task started · model: ${model}`, 'info');
  const post = (event_type: string, payload: object, extra: object = {}) =>
    api(`/api/tasks/${taskId}/events`, 'POST', { event_type, payload, ...extra });

  // Pop-up windows the page opens (lookups, pickers): work in them, and come back when they close
  // (window.open pop-ups do not always say which tab opened them: a tab appearing right after our action counts)
  let lastActAt = 0;
  const onCreated = (t: Browser.tabs.Tab) => {
    if (t.id && (t.openerTabId === tabId || Date.now() - lastActAt < 5000)) {
      tabId = t.id;
      tab = t;
    }
  };
  const onRemoved = async (id: number) => {
    if (id === tabId && id !== mainTabId) {
      tabId = mainTabId;
      tab = (await browser.tabs.get(mainTabId).catch(() => null)) ?? tab;
    }
  };
  browser.tabs.onCreated.addListener(onCreated);
  browser.tabs.onRemoved.addListener(onRemoved);

  let lastResult: ActionResult | null = null;
  let answer: object | null = null;
  let submitted = false;
  let wantShot = false;
  const finish = async (r: { status: string; summary: string; taskId?: string }) => {
    browser.tabs.onCreated.removeListener(onCreated);
    browser.tabs.onRemoved.removeListener(onRemoved);
    await endTask(mainTabId);
    return r;
  };
  const askApproval = async (c: Confirmation, url: string, extra: object = {}) => {
    const shot = await screenshot(tab!);
    await post('screenshot', { moment: 'before_submit' }, { url, screenshot_b64: shot });
    const ok = await ui.confirm(c);
    await post('confirmation', { approved: ok, button: c.button, fields: c.fields, warning: c.warning, checks: c.checks, ...extra },
               { url });
    if (!ok) {
      await post('user_cancelled', { reason: 'User declined the final submit' });
      ui.step('Not submitted. Nothing was sent.', 'error');
    }
    return ok;
  };
  try {
    for (let i = 0; i < 50; i++) {
      if (ui.isStopped()) {
        await post('user_cancelled', { reason: 'Stopped by user' });
        return finish({ status: 'cancelled', summary: 'Stopped by user', taskId });
      }
      await waitForLoad(tabId);
      const page = await snapshot(tabId);
      if (tabId !== mainTabId) page.popup = true;
      showWorking(tabId, 'thinking about the next step…');
      const body: any = { page: forBackend(page), last_result: lastResult, user_answer: answer };
      if (wantShot) body.screenshot_b64 = await markedScreenshot(tab!, page);
      const res = await api(`/api/tasks/${taskId}/step`, 'POST', body);
      const a: AgentAction = res.action;
      wantShot = !!res.want_screenshot;
      lastResult = null;
      answer = null;
      if (a.thought) ui.step(a.thought, 'info');

      if (a.action === 'done' || a.action === 'fail') {
        if (submitted) {
          const shot = await screenshot(tab!);
          await post('screenshot', { moment: 'after_submit' }, { url: page.url, screenshot_b64: shot });
        }
        const unverified = a.action === 'done' && (a as any).unverified;
        ui.step(a.summary || a.action, a.action === 'done' && !unverified ? 'ok' : 'error');
        const status = a.action === 'fail' ? 'failed' : unverified ? 'unverified' : 'completed';
        return finish({ status, summary: a.summary || '', taskId });
      }

      if (a.action === 'ask_user') {
        showWorking(tabId, 'waiting for your answer in the side panel');
        const isUserAction = a.field === 'user_action';
        const reply = await ui.ask(a.question || 'Please answer', a.options, isUserAction);
        if (reply === null) {
          await post('user_cancelled', { reason: 'User cancelled at question', question: a.question });
          return finish({ status: 'cancelled', summary: 'Cancelled', taskId });
        }
        answer = { field: a.field, question: a.question, answer: reply, remember: !!a.remember };
        continue;
      }

      if (a.action === 'look') {   // the assistant wants a screenshot before deciding (vision fallback)
        continue;
      }

      if (a.action === 'navigate') {
        ui.step(describe(a, page), 'action');
        await browser.tabs.update(tabId, { url: a.url });
        lastResult = { ok: true, detail: `navigated to ${a.url}` };
        continue;
      }

      let approved = false;
      if (res.needs_confirmation) {
        showWorking(tabId, 'waiting for your OK in the side panel');
        if (!(await askApproval(res.confirmation as Confirmation, page.url))) {
          return finish({ status: 'cancelled', summary: 'User declined the final submit', taskId });
        }
        submitted = approved = true;
      }

      ui.step(describe(a, page), 'action');
      await showWorking(tabId, describe(a, page));
      lastActAt = Date.now();
      if (a.action === 'upload') {
        const file = await ui.askFile(a.question || 'Which file should I attach?');
        if (!file) {
          lastResult = { ok: false, error: 'The user did not choose a file' };
          continue;
        }
        await post('file_chosen', { name: file.name, type: file.type, bytes: Math.round(file.data.length * 0.75) });
        lastResult = await act(tabId, page, { action: 'upload', id: a.id, file });
      } else if (a.action === 'fill_form') {
        const ok: string[] = [];
        const failed: string[] = [];
        for (const f of a.fields || []) {
          const el = page.elements.find((e) => e.id === f.id);
          const kind = el?.tag === 'select' ? 'select' : el?.type === 'checkbox' || el?.type === 'radio' ? 'click'
            : el?.readonly && /^\d{4}-\d{2}-\d{2}$/.test(f.value) ? 'pick_date' : 'type';
          if (kind === 'click' && (el?.value === 'checked') === !/^(no|false|unchecked|0)$/i.test(f.value)) continue;
          const r = await act(tabId, page, { action: kind, id: f.id, value: f.value });
          (r.ok ? ok : failed).push(`[${f.id}] ${r.ok ? r.detail : r.error}`);
        }
        lastResult = { ok: failed.length === 0, detail: ok.join('; '), error: failed.length ? failed.join('; ') : undefined };
      } else if (a.action === 'click_xy') {
        // screenshot pixels -> page pixels
        const k = (await browser.scripting.executeScript({ target: { tabId }, func: () => window.devicePixelRatio || 1 }))[0]?.result ?? 1;
        const rs = await browser.scripting.executeScript({ target: { tabId, allFrames: true }, func: clickAtInPage,
                                                         args: [(a.x ?? 0) / k, (a.y ?? 0) / k] });
        lastResult = (rs.find((r) => r.result)?.result as ActionResult) ?? { ok: false, error: `Nothing to click at ${a.x},${a.y}` };
      } else {
        lastResult = await act(tabId, page, { action: a.action, id: a.id, value: a.value, approved });
      }
      if (lastResult.needsApproval && lastResult.dialog) {
        // The site asked "Are you sure...?" for an action the user had not approved yet: ask the user now
        const c: Confirmation = await api(`/api/tasks/${taskId}/dialog`, 'POST',
          { page: forBackend(page), id: a.id, message: lastResult.dialog.text });
        if (!(await askApproval(c, page.url, { site_dialog: lastResult.dialog.text }))) {
          return finish({ status: 'cancelled', summary: 'User declined the final submit', taskId });
        }
        submitted = true;
        ui.step(`Site asked: "${lastResult.dialog.text}" → OK`, 'action');
        lastResult = await act(tabId, page, { action: a.action, id: a.id, value: a.value, approved: true });
      }
      if (!lastResult.ok) ui.step(lastResult.error || 'Action failed', 'error');
      await sleep(250);
    }
    await post('client_error', { reason: 'Too many steps' });
    return finish({ status: 'failed', summary: 'Too many steps', taskId });
  } catch (e: any) {
    await post('client_error', { reason: String(e?.message || e) }).catch(() => {});
    ui.step(`Error: ${e?.message || e}`, 'error');
    return finish({ status: 'failed', summary: String(e?.message || e), taskId });
  }
}
