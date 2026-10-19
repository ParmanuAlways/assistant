// Reading and operating the web page. These functions are injected into the tab with
// browser.scripting.executeScript, so each one must be self-contained (no outside references).
import { browser } from 'wxt/browser';

export interface PageElement {
  id: number;
  tag: string;
  type?: string;
  label?: string;
  text?: string;
  value?: string;
  required?: boolean;
  options?: string[];
  href?: string;
  group?: string;
  pressed?: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
  notices?: string[]; // pop-up messages (toasts/alerts) seen recently, even if already gone
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  detail?: string;
}

function snapshotInPage(): PageSnapshot {
  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el: HTMLElement) => {
    const id = el.getAttribute('id');
    const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((i) => document.getElementById(i)?.textContent || '').join(' ');
    // Last resort for custom widgets (e.g. webmail recipient boxes): the label of the same form row
    const rowLabel = () => {
      let row: HTMLElement | null = el.parentElement;
      for (let i = 0; row && i < 6; i++, row = row.parentElement) {
        const l = row.querySelector('label');
        if (l && !l.contains(el) && row.querySelectorAll('input, select, textarea').length <= 3) return l.textContent;
      }
      return '';
    };
    const text =
      el.getAttribute('aria-label') ||
      labelledBy.trim() ||
      (forLabel && forLabel.textContent) ||
      (el.closest('label') && el.closest('label')!.textContent) ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      rowLabel() ||
      el.getAttribute('name') ||
      '';
    return clean(text).replace(/\s*\*$/, '');
  };

  // Remember toasts/alerts as they appear: many apps show "Message sent" for a second only
  const w = window as any;
  if (!w.__agentNotices) {
    w.__agentNotices = [] as { t: number; text: string }[];
    const sel = '[role=alert], [role=status], [aria-live], .toast, .notification, .alert, #messagestack, .messagestack';
    new MutationObserver((muts) => {
      for (const m of muts) {
        const target = m.target instanceof Element ? m.target : m.target.parentElement;
        const box = target?.closest(sel) || (target?.matches?.(sel) ? target : null);
        const text = clean(box?.textContent);
        if (box && text && text.length < 300) w.__agentNotices.push({ t: Date.now(), text });
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }
  // (normally already started at page load by entrypoints/notices.content.ts)
  const notices = [...new Set((w.__agentNotices as { t: number; text: string }[])
    .filter((n) => Date.now() - n.t < 15000).map((n) => n.text))].slice(-5);

  document.querySelectorAll('[data-agent-id]').forEach((el) => el.removeAttribute('data-agent-id'));
  const nodes = document.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]',
  );
  const elements: PageElement[] = [];
  let n = 1;
  nodes.forEach((el) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'hidden' || !visible(el) || (el as HTMLInputElement).disabled) return;
    const tag = el.tagName.toLowerCase();
    const item: PageElement = { id: n, tag };
    if (type) item.type = type;
    if (tag === 'button' && !type) item.type = 'submit';
    if (['input', 'select', 'textarea'].includes(tag)) {
      item.label = labelOf(el);
      item.required = (el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true';
      // Never read passwords
      item.value = type === 'password' ? '' : clean((el as HTMLInputElement).value);
      if (tag === 'select') {
        const sel = el as HTMLSelectElement;
        item.options = Array.from(sel.options).map((o) => clean(o.text));
        item.value = sel.selectedIndex >= 0 && sel.value ? clean(sel.options[sel.selectedIndex].text) : '';
      }
      if (type === 'checkbox' || type === 'radio') {
        item.value = (el as HTMLInputElement).checked ? 'checked' : '';
        const legend = el.closest('fieldset')?.querySelector('legend');
        if (legend) item.group = clean(legend.textContent).replace(/\s*\*$/, '');
      }
    } else {
      item.text = clean(el.innerText || (el as HTMLInputElement).value).slice(0, 100);
      const aria = clean(el.getAttribute('aria-label'));
      if (aria && aria !== item.text) item.label = aria;
      if (el.getAttribute('aria-pressed') === 'true') item.pressed = true;
      if (tag === 'a') item.href = (el as HTMLAnchorElement).href;
    }
    el.setAttribute('data-agent-id', String(n));
    elements.push(item);
    n++;
  });
  return { url: location.href, title: document.title, text: clean(document.body.innerText).slice(0, 4000), elements, notices };
}

function actInPage(action: { action: string; id?: number; value?: string }): ActionResult {
  try {
    return actInPageUnsafe(action);
  } catch (e) {
    return { ok: false, error: `Could not ${action.action} element ${action.id}: ${(e as Error).message}` };
  }

  function actInPageUnsafe(action: { action: string; id?: number; value?: string }): ActionResult {
  const el = document.querySelector<HTMLElement>(`[data-agent-id="${action.id}"]`);
  if (!el) return { ok: false, error: `Element ${action.id} not found` };
  el.scrollIntoView({ block: 'center' });
  // Show the user what the assistant is touching
  const old = el.style.outline;
  el.style.outline = '3px solid #f59e0b';
  setTimeout(() => (el.style.outline = old), 1200);

  if (action.action === 'click') {
    el.click();
    return { ok: true, detail: 'clicked' };
  }
  if (action.action === 'type') {
    if (el.isContentEditable) {
      // Rich-text editors (e.g. Outlook on the web, TinyMCE): replace the text the way typing would
      el.focus();
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, action.value ?? '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, detail: `typed "${(action.value ?? '').slice(0, 60)}"` };
    }
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      return { ok: false, error: `Element ${action.id} is not a text field` };
    }
    const input = el as HTMLInputElement;
    if (input.type === 'password') return { ok: false, error: 'Refusing to type into a password field' };
    input.focus();
    // Native setter so React/Vue/Angular forms notice the change
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, action.value ?? '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    const ok = input.value === (action.value ?? '');
    return ok ? { ok: true, detail: `typed "${input.value}"` } : { ok: false, error: `Field kept value "${input.value}"` };
  }
  if (action.action === 'select') {
    if (!(el instanceof HTMLSelectElement)) return { ok: false, error: `Element ${action.id} is not a dropdown` };
    const sel = el;
    const want = (action.value || '').toLowerCase().trim();
    const opt =
      Array.from(sel.options).find((o) => o.text.toLowerCase().trim() === want || o.value.toLowerCase() === want) ||
      Array.from(sel.options).find((o) => o.text.toLowerCase().includes(want));
    if (!opt) return { ok: false, error: `No option "${action.value}"` };
    sel.value = opt.value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, detail: `selected "${opt.text}"` };
  }
  return { ok: false, error: `Unsupported action ${action.action}` };
  }
}

function waitForStableInPage(): Promise<boolean> {
  // Single-page apps keep rendering after "load" (mail lists, grids): wait until the DOM is quiet
  return new Promise((resolve) => {
    let timer = setTimeout(done, 500);
    const stop = setTimeout(done, 5000);
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, 500);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    function done() {
      obs.disconnect();
      clearTimeout(stop);
      resolve(true);
    }
  });
}

export async function snapshot(tabId: number): Promise<PageSnapshot> {
  await browser.scripting.executeScript({ target: { tabId }, func: waitForStableInPage }).catch(() => {});
  const [res] = await browser.scripting.executeScript({ target: { tabId }, func: snapshotInPage });
  return res.result as PageSnapshot;
}

export async function act(tabId: number, action: { action: string; id?: number; value?: string }): Promise<ActionResult> {
  const [res] = await browser.scripting.executeScript({ target: { tabId }, func: actInPage, args: [action] });
  return (res?.result as ActionResult) ?? { ok: false, error: 'The page did not respond' };
}
