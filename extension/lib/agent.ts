// The agent loop: read page -> ask backend (which asks the model and logs everything) -> act.
import { browser, type Browser } from 'wxt/browser';
import { api } from './api';
import { act, ActionResult, snapshot } from './page';

export interface AgentAction {
  action: 'click' | 'type' | 'select' | 'navigate' | 'ask_user' | 'done' | 'fail';
  id?: number;
  value?: string;
  url?: string;
  question?: string;
  field?: string;
  options?: string[];
  remember?: boolean;
  summary?: string;
  thought?: string;
}

export interface Confirmation {
  button: string;
  fields: { label: string; value: string }[];
  warning?: string;
}

export interface AgentUI {
  step(text: string, kind?: 'info' | 'action' | 'ok' | 'error'): void;
  ask(question: string, options?: string[], isUserAction?: boolean): Promise<string | null>;
  confirm(c: Confirmation): Promise<boolean>;
  isStopped(): boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForLoad(tabId: number, timeoutMs = 15000) {
  await sleep(300);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === 'complete') return;
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

function describe(a: AgentAction): string {
  switch (a.action) {
    case 'click': return `Click element [${a.id}]`;
    case 'type': return `Type "${a.value}" into [${a.id}]`;
    case 'select': return `Choose "${a.value}" in [${a.id}]`;
    case 'navigate': return `Open ${a.url}`;
    default: return a.action;
  }
}

export async function runTask(prompt: string, ui: AgentUI): Promise<{ status: string; summary: string; taskId?: string }> {
  let tab = await targetTab();
  if (!tab?.id) {
    await browser.tabs.create({ url: 'about:blank' });
    tab = await targetTab();
  }
  const tabId = tab!.id!;
  const { task_id: taskId, model } = await api('/api/tasks', 'POST', { prompt, url: tab!.url });
  ui.step(`Task started · model: ${model}`, 'info');
  const post = (event_type: string, payload: object, extra: object = {}) =>
    api(`/api/tasks/${taskId}/events`, 'POST', { event_type, payload, ...extra });

  let lastResult: ActionResult | null = null;
  let answer: object | null = null;
  let submitted = false;
  try {
    for (let i = 0; i < 40; i++) {
      if (ui.isStopped()) {
        await post('user_cancelled', { reason: 'Stopped by user' });
        return { status: 'cancelled', summary: 'Stopped by user', taskId };
      }
      await waitForLoad(tabId);
      const page = await snapshot(tabId);
      const res = await api(`/api/tasks/${taskId}/step`, 'POST', { page, last_result: lastResult, user_answer: answer });
      const a: AgentAction = res.action;
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
        return { status, summary: a.summary || '', taskId };
      }

      if (a.action === 'ask_user') {
        const isUserAction = a.field === 'user_action';
        const reply = await ui.ask(a.question || 'Please answer', a.options, isUserAction);
        if (reply === null) {
          await post('user_cancelled', { reason: 'User cancelled at question', question: a.question });
          return { status: 'cancelled', summary: 'Cancelled', taskId };
        }
        answer = { field: a.field, question: a.question, answer: reply, remember: !!a.remember };
        continue;
      }

      if (a.action === 'navigate') {
        ui.step(describe(a), 'action');
        await browser.tabs.update(tabId, { url: a.url });
        lastResult = { ok: true, detail: `navigated to ${a.url}` };
        continue;
      }

      if (res.needs_confirmation) {
        const shot = await screenshot(tab!);
        await post('screenshot', { moment: 'before_submit' }, { url: page.url, screenshot_b64: shot });
        const ok = await ui.confirm(res.confirmation as Confirmation);
        await post('confirmation', { approved: ok, button: res.confirmation.button, fields: res.confirmation.fields,
                                     warning: res.confirmation.warning }, { url: page.url });
        if (!ok) {
          await post('user_cancelled', { reason: 'User declined the final submit' });
          ui.step('Not submitted. Nothing was sent.', 'error');
          return { status: 'cancelled', summary: 'User declined the final submit', taskId };
        }
        submitted = true;
      }

      ui.step(describe(a), 'action');
      lastResult = await act(tabId, a);
      if (!lastResult.ok) ui.step(lastResult.error || 'Action failed', 'error');
      await sleep(250);
    }
    await post('client_error', { reason: 'Too many steps' });
    return { status: 'failed', summary: 'Too many steps', taskId };
  } catch (e: any) {
    await post('client_error', { reason: String(e?.message || e) }).catch(() => {});
    ui.step(`Error: ${e?.message || e}`, 'error');
    return { status: 'failed', summary: String(e?.message || e), taskId };
  }
}
