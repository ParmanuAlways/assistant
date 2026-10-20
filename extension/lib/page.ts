// Reading and operating the web page. These functions are injected into the tab with
// browser.scripting.executeScript, so each one must be self-contained (no outside references).
// Every frame of the page is read (framesets, iframes), including open Shadow DOM.
import { browser } from 'wxt/browser';

// Firefox never settles an injected call whose page navigates away while it runs: give up waiting after a while
const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);

export interface PageElement {
  id: number;
  tag: string;
  type?: string;
  label?: string;
  text?: string;
  value?: string;
  required?: boolean;
  readonly?: boolean;
  options?: string[];
  href?: string;
  group?: string;
  pressed?: boolean;
  row?: string;        // text of the table row the element belongs to ("PO-1077 Globex 72,000 Pending")
  rect?: { x: number; y: number; w: number; h: number }; // drawings: where they are on the screen (screenshot px)
  menu?: string;       // link inside a menu that only opens on hover
  frame?: string;      // name of the frame the element is in (top page = no frame)
  _frameId?: number;   // where to act (extension only)
  _local?: number;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
  notices?: string[]; // pop-up messages (toasts/alerts/dialogs) seen recently, even if already gone
  errors?: string[];  // validation/error messages currently shown
  frames?: string[];  // "main: http://.../travel"
  popup?: boolean;    // the assistant is working in a pop-up window opened by the page
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  detail?: string;
  dialog?: { kind: string; text: string; answer?: string }; // native alert/confirm the action triggered
  needsApproval?: boolean;  // the site asked confirm() and the user has not approved this action yet
}

export interface PageAction {
  action: string;
  id?: number;
  value?: string;
  approved?: boolean;
  file?: { name: string; type: string; data: string };
}

interface FrameSnapshot extends PageSnapshot {
  frameName: string;
  visible: boolean;
}

// Native alert()/confirm()/prompt() would block the page and the assistant. This hook runs in the page's own
// JavaScript world from document_start (Chrome: entrypoints/dialogs.content.ts; Firefox: a script tag from
// entrypoints/notices.content.ts). It only acts while a task is running: alerts are recorded, confirm()
// returns OK only for an action the user approved (else Cancel), prompt() is cancelled.
export function installDialogHook() {
  const w = window as any;
  if (w.__oaDialogHook) return;
  w.__oaDialogHook = 1;
  const A = '__officeAssistantActive', D = '__officeAssistantDialogs', P = '__officeAssistantApproved';
  const g = (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } };
  const active = () => Date.now() - (Number(g(A)) || 0) < 300000;
  const log = (kind: string, msg: unknown, answer?: string) => {
    try {
      const l = JSON.parse(g(D) || '[]');
      l.push({ t: Date.now(), kind, text: String(msg ?? '').slice(0, 300), answer });
      sessionStorage.setItem(D, JSON.stringify(l.slice(-10)));
    } catch {}
  };
  const oa = window.alert, oc = window.confirm, op = window.prompt;
  window.alert = function (m?: any) { if (!active()) return oa.call(window, m); log('alert', m); };
  window.confirm = function (m?: string) {
    if (!active()) return oc.call(window, m);
    const ok = Date.now() - (Number(g(P)) || 0) < 15000;
    log('confirm', m, ok ? 'OK' : 'Cancel');
    return ok;
  };
  window.prompt = function (m?: string, d?: string) { if (!active()) return op.call(window, m, d); log('prompt', m, 'Cancel'); return null; };
}

function snapshotInPage(): FrameSnapshot {
  try {
    sessionStorage.setItem('__officeAssistantActive', String(Date.now()));
  } catch {}
  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
  // parent that also steps out of a shadow root to its host
  const up = (el: Element): Element | null => el.parentElement || ((el.getRootNode() as ShadowRoot).host ?? null);
  const closestDeep = (el: Element | null, sel: string): Element | null => {
    for (let e: Element | null = el; e; e = up(e)) if (e.matches(sel)) return e;
    return null;
  };
  const labelOf = (el: HTMLElement) => {
    const root = el.getRootNode() as Document | ShadowRoot;
    const id = el.getAttribute('id');
    const forLabel = id ? root.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((i) => (i && (root as Document).getElementById?.(i)?.textContent) || '').join(' ');
    // Last resort for custom widgets (e.g. webmail recipient boxes): the label of the same form row
    const rowLabel = () => {
      let row: HTMLElement | null = el.parentElement;
      for (let i = 0; row && i < 6; i++, row = row.parentElement) {
        const l = row.querySelector('label');
        if (l && !l.contains(el) && row.querySelectorAll('input, select, textarea').length <= 3) return l.textContent;
      }
      return '';
    };
    // Old-style forms: <tr><td>Destination city</td><td><input></td></tr>
    const cellLabel = () => {
      const td = el.closest('td, dd');
      const prev = td?.previousElementSibling;
      if (prev && /^(TD|TH|DT)$/.test(prev.tagName) && !prev.querySelector('input, select, textarea')) return prev.textContent;
      return '';
    };
    const text =
      el.getAttribute('aria-label') ||
      labelledBy.trim() ||
      (forLabel && forLabel.textContent) ||
      (el.closest('label') && el.closest('label')!.textContent) ||
      cellLabel() ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      rowLabel() ||
      el.getAttribute('name') ||
      '';
    return clean(text).replace(/\s*[*:]$/, '');
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
  let dialogs: { t: number; kind: string; text: string; answer?: string }[] = [];
  try {
    dialogs = JSON.parse(sessionStorage.getItem('__officeAssistantDialogs') || '[]');
  } catch {}
  const notices = [...new Set([
    ...(w.__agentNotices as { t: number; text: string }[]).filter((n) => Date.now() - n.t < 15000).map((n) => n.text),
    ...dialogs.filter((d) => Date.now() - d.t < 20000)
      .map((d) => `site pop-up (${d.kind}): "${d.text}"${d.answer ? ` → ${d.answer}` : ''}`),
  ])].slice(-6);

  // Walk the whole tree, including open shadow roots, in document order
  const all: HTMLElement[] = [];
  const walk = (root: Document | ShadowRoot | Element) => {
    for (const el of Array.from(root.children) as HTMLElement[]) {
      if (el.id === '__oa_working') continue;   // our own "assistant is working" overlay
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
      walk(el);
    }
  };
  walk(document);
  all.forEach((el) => el.removeAttribute('data-agent-id'));

  const STANDARD = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], ' +
    '[role="option"], [role="tab"], [contenteditable="true"]';
  const INTERACTIVE = `${STANDARD}, [onclick]`;
  const chosen = new Set<HTMLElement>();
  const picked: { el: HTMLElement; menu?: string }[] = [];
  for (const el of all) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (!el.matches(INTERACTIVE) || type === 'hidden' || (el as HTMLInputElement).disabled) continue;
    // onclick on a container (a table row, a div around a button): use the inner controls instead
    if (!el.matches(STANDARD) && (closestDeep(up(el), INTERACTIVE) || el.querySelector(STANDARD))) continue;
    if (visible(el)) {
      picked.push({ el });
      chosen.add(el);
      continue;
    }
    // A link hidden in a hover/drop-down menu: clickable anyway; tell the model which menu it is under
    if (el.tagName === 'A') {
      const list = el.closest('ul, ol, nav, [role=menu]');
      const item = list?.parentElement?.closest('li, [role=menuitem]') || null;
      const head = item ? clean((item.firstElementChild as HTMLElement | null)?.innerText || '') : '';
      if (list && head && item && visible(item)) {
        picked.push({ el, menu: head.replace(/[▸▶►›»]/g, '').trim() });
        chosen.add(el);
      }
    }
  }
  // Home-made widgets: anything with a pointer cursor and its own text (calendar days, suggestion lists,
  // clickable table cells/images) that is not inside or around an element we already have
  const SKIP = ['HTML', 'BODY', 'FORM', 'TABLE', 'TBODY', 'TR', 'UL', 'OL', 'SCRIPT', 'STYLE', 'LABEL', 'FRAMESET', 'FRAME', 'IFRAME'];
  for (const el of all) {
    if (chosen.has(el) || SKIP.includes(el.tagName) || !visible(el)) continue;
    if (getComputedStyle(el).cursor !== 'pointer') continue;
    const parent = up(el) as HTMLElement | null;
    if (parent && parent.nodeType === 1 && getComputedStyle(parent).cursor === 'pointer') continue;   // only the outermost
    if (closestDeep(el, INTERACTIVE) || el.querySelector(INTERACTIVE)) continue;
    const text = clean(el.innerText || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('aria-label'));
    if (!text || text.length > 120) continue;
    picked.push({ el });
    chosen.add(el);
  }
  // Drawings (charts, seat maps, diagrams) have nothing inside to read: list them so the model knows to look
  for (const el of all) {
    if (el.tagName === 'CANVAS' && !chosen.has(el) && visible(el) && el.getBoundingClientRect().width > 60) {
      picked.push({ el });
      chosen.add(el);
    }
  }
  const order = new Map(all.map((e, i) => [e, i]));
  picked.sort((a, b) => order.get(a.el)! - order.get(b.el)!);

  const elements: PageElement[] = [];
  let n = 1;
  for (const { el, menu } of picked) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const tag = el.tagName.toLowerCase();
    const item: PageElement = { id: n, tag };
    if (type) item.type = type;
    if (tag === 'button' && !type) item.type = 'submit';
    if (['input', 'select', 'textarea'].includes(tag) && !['submit', 'button', 'reset', 'image'].includes(type)) {
      item.label = labelOf(el);
      item.required = (el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true';
      if ((el as HTMLInputElement).readOnly) item.readonly = true;
      // Never read passwords
      item.value = type === 'password' ? '' : clean((el as HTMLInputElement).value);
      if (type === 'file') item.value = Array.from((el as HTMLInputElement).files || []).map((f) => f.name).join(', ');
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
      item.text = clean(el.innerText || (el as HTMLInputElement).value || el.getAttribute('alt') || el.getAttribute('title') ||
        (menu ? el.textContent : '')).slice(0, 100);
      const aria = clean(el.getAttribute('aria-label') || (item.text ? '' : el.getAttribute('title')));
      if (aria && aria !== item.text) item.label = aria;
      if (el.getAttribute('aria-pressed') === 'true') item.pressed = true;
      if (tag === 'a') item.href = (el as HTMLAnchorElement).href;
      if (!el.matches(STANDARD)) item.type = 'clickable';
      if (tag === 'canvas') {
        // position on the whole screen (through the frames), so a screenshot can be cropped to it
        const r = el.getBoundingClientRect();
        let ox = 0;
        let oy = 0;
        try {
          for (let fw: Window = window; fw !== fw.top && fw.frameElement; fw = fw.parent) {
            const fr = fw.frameElement.getBoundingClientRect();
            ox += fr.left;
            oy += fr.top;
          }
        } catch {}
        const k = window.devicePixelRatio || 1;
        item.rect = { x: Math.round((r.left + ox) * k), y: Math.round((r.top + oy) * k), w: Math.round(r.width * k), h: Math.round(r.height * k) };
        item.type = 'drawing';
        item.text = clean(el.getAttribute('aria-label') || el.getAttribute('title')) || 'a drawing; its contents can only be seen on a screenshot';
      }
      // Which row a button/link belongs to: "Approve" alone is ambiguous in a table of 10 orders
      const row = closestDeep(el, 'tr, [role=row]') as HTMLElement | null;
      const rowText = row ? clean(row.innerText).slice(0, 110) : '';
      if (row && rowText && rowText !== item.text && row.querySelectorAll('td, [role=cell], [role=gridcell]').length > 2) item.row = rowText;
    }
    if (menu) item.menu = menu;
    el.setAttribute('data-agent-id', String(n));
    elements.push(item);
    n++;
  }
  const errSel = '.err, .error, .errors, .error-message, .validation-summary-errors, .field-validation-error, .invalid-feedback, ' +
    '.alert-danger, .alert-error, .text-danger';
  const errors = [...new Set(Array.from(document.querySelectorAll<HTMLElement>(errSel))
    .filter((e) => visible(e)).map((e) => clean(e.innerText)).filter((t) => t && t.length < 250))].slice(0, 5);
  let frameName = '';
  try {
    frameName = window.frameElement?.getAttribute('name') || window.frameElement?.getAttribute('id') || (window !== window.top ? 'frame' : '');
  } catch {
    frameName = window !== window.top ? 'frame' : '';
  }
  return {
    url: location.href, title: document.title, text: clean(document.body?.innerText).slice(0, 4000), elements, notices, errors,
    frameName, visible: window === window.top || (window.innerWidth > 20 && window.innerHeight > 20),
  };
}

async function actInPage(action: PageAction): Promise<ActionResult> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
  const t0 = Date.now();
  try {
    sessionStorage.setItem('__officeAssistantActive', String(Date.now()));
    if (action.approved) sessionStorage.setItem('__officeAssistantApproved', String(Date.now()));
    else sessionStorage.removeItem('__officeAssistantApproved');
  } catch {}
  let result: ActionResult;
  try {
    result = await run();
  } catch (e) {
    result = { ok: false, error: `Could not ${action.action} element ${action.id}: ${(e as Error).message}` };
  }
  // Native pop-ups the action caused (answered by the dialog hook). javascript: links and timers run a moment
  // later, so give them a little time. The approval itself expires by itself after 15 seconds.
  try {
    let ds: any[] = [];
    for (let i = 0; i < 4 && !ds.length && ['click', 'pick_date', 'autocomplete'].includes(action.action); i++) {
      await sleep(150);
      ds = JSON.parse(sessionStorage.getItem('__officeAssistantDialogs') || '[]').filter((d: any) => d.t >= t0);
    }
    const d = ds[ds.length - 1];
    if (d) {
      result.dialog = { kind: d.kind, text: d.text, answer: d.answer };
      result.detail = `${result.detail || ''}; the site showed a pop-up (${d.kind}): "${d.text}"${d.answer ? ` → answered ${d.answer}` : ''}`;
      if (d.kind === 'confirm' && d.answer === 'Cancel' && !action.approved) result.needsApproval = true;
    }
  } catch {}
  return result;

  function find(id?: number): HTMLElement | null {
    const deep = (root: Document | ShadowRoot): HTMLElement | null => {
      const hit = root.querySelector<HTMLElement>(`[data-agent-id="${id}"]`);
      if (hit) return hit;
      for (const host of Array.from(root.querySelectorAll('*'))) {
        if (host.shadowRoot) {
          const h = deep(host.shadowRoot);
          if (h) return h;
        }
      }
      return null;
    };
    return deep(document);
  }

  function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string, blur = true) {
    input.focus();
    // Native setter so React/Vue/Angular forms notice the change, plus key events for keyup-driven scripts
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const key = value.slice(-1) || 'Backspace';
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    if (blur) {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
    }
  }

  function visible(el: Element) {
    const r = (el as HTMLElement).getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }

  function realClick(el: HTMLElement) {
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, composed: true, view: window }));
    }
    el.click();
  }

  async function run(): Promise<ActionResult> {
    const el = find(action.id);
    if (!el) return { ok: false, error: `Element ${action.id} not found` };
    if (visible(el)) el.scrollIntoView({ block: 'center' });
    // Show the user what the assistant is touching
    const old = el.style.outline;
    el.style.outline = '3px solid #f59e0b';
    setTimeout(() => (el.style.outline = old), 1200);
    const value = action.value ?? '';

    if (action.action === 'click') {
      if (el instanceof HTMLInputElement && el.type === 'file') return { ok: false, error: 'This is a file field: use upload' };
      realClick(el);
      return { ok: true, detail: 'clicked' };
    }
    if (action.action === 'hover') {
      for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
        el.dispatchEvent(new MouseEvent(t, { bubbles: !t.endsWith('enter'), composed: true, view: window }));
      }
      await sleep(300);
      return { ok: true, detail: 'hovered' };
    }
    if (action.action === 'upload') {
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') return { ok: false, error: `Element ${action.id} is not a file field` };
      if (!action.file) return { ok: false, error: 'No file given' };
      const bytes = Uint8Array.from(atob(action.file.data), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], action.file.name, { type: action.file.type || 'application/octet-stream' }));
      el.files = dt.files;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, detail: `attached "${action.file.name}"` };
    }
    if (action.action === 'type' || action.action === 'autocomplete') {
      if (el.isContentEditable) {
        // Rich-text editors (e.g. Outlook on the web, TinyMCE): replace the text the way typing would
        el.focus();
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, detail: `typed "${value.slice(0, 60)}"` };
      }
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
        return { ok: false, error: `Element ${action.id} is not a text field` };
      }
      const input = el as HTMLInputElement;
      if (input.type === 'password') return { ok: false, error: 'Refusing to type into a password field' };
      if (input.type === 'file') return { ok: false, error: 'This is a file field: use upload' };
      if (input.readOnly) {
        return { ok: false, error: 'This field is read-only (a picker fills it): use pick_date for dates, or click the button next to it' };
      }
      if (action.action === 'autocomplete') return autocomplete(input, value);
      const shown = new Set(Array.from(document.querySelectorAll('body *')).filter(visible));
      typeInto(input, value);
      // A suggestion list that appears while typing usually has to be clicked for the value to count
      let suggestions: string[] = [];
      if (input.type !== 'date' && value.length >= 2) {
        await sleep(600);
        const first = value.toLowerCase().split(' ')[0];
        suggestions = Array.from(document.querySelectorAll<HTMLElement>('body *'))
          .filter((e) => !shown.has(e) && visible(e) && e.children.length === 0 && clean(e.innerText).toLowerCase().includes(first))
          .map((e) => clean(e.innerText)).slice(0, 5);
      }
      const hint = suggestions.length ? `; suggestions appeared: ${suggestions.map((x) => `"${x}"`).join(', ')} — click the right one (or use autocomplete)` : '';
      if (input.value === value) return { ok: true, detail: `typed "${input.value}"${hint}` };
      // Masked fields reformat what you type ("8500" -> "8,500", "9123400000" -> "91234-00000"): same characters is fine
      const core = (s: string) => s.replace(/[^0-9a-z]/gi, '').toLowerCase();
      if (core(input.value) === core(value)) return { ok: true, detail: `typed "${value}" (the field shows it as "${input.value}")` };
      return { ok: false, error: `Field kept value "${input.value}"` };
    }
    if (action.action === 'select') {
      if (!(el instanceof HTMLSelectElement)) return { ok: false, error: `Element ${action.id} is not a dropdown` };
      const sel = el;
      const want = value.toLowerCase().trim();
      const opt =
        Array.from(sel.options).find((o) => o.text.toLowerCase().trim() === want || o.value.toLowerCase() === want) ||
        Array.from(sel.options).find((o) => want && o.text.toLowerCase().includes(want));
      if (!opt) return { ok: false, error: `No option "${value}"` };
      sel.value = opt.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, detail: `selected "${opt.text}"` };
    }
    if (action.action === 'pick_date') return pickDate(el, value);
    return { ok: false, error: `Unsupported action ${action.action}` };
  }

  // Type, wait for the suggestion list, click the matching suggestion (a typed name alone often doesn't count)
  async function autocomplete(input: HTMLInputElement, value: string): Promise<ActionResult> {
    const before = new Set(Array.from(document.querySelectorAll('body *')).filter(visible));
    const want = clean(value).toLowerCase();
    const first = want.split(' ')[0];
    const attempts = [value, value.split(/\s+/)[0], value.slice(0, 3)].filter((v, i, a) => v && a.indexOf(v) === i);
    for (const q of attempts) {
      typeInto(input, q, false);
      for (let i = 0; i < 15; i++) {
        await sleep(200);
        const fresh = Array.from(document.querySelectorAll<HTMLElement>('body *'))
          .filter((e) => !before.has(e) && e !== input && visible(e) && !e.querySelector('input'))
          .filter((e) => clean(e.innerText).toLowerCase().includes(first));
        if (!fresh.length) continue;
        // the smallest new element whose text best matches what we want
        const score = (e: HTMLElement) => (clean(e.innerText).toLowerCase().includes(want) ? 0 : 1000) + clean(e.innerText).length;
        const best = fresh.sort((a, b) => score(a) - score(b))[0];
        const text = clean(best.innerText);
        realClick(best);
        await sleep(300);
        return { ok: true, detail: `typed "${q}" and picked the suggestion "${text}"; the field now shows "${input.value}"` };
      }
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: false, error: `No suggestion matching "${value}" appeared; the field shows "${input.value}"` };
  }

  // Date fields: native date inputs, plain text boxes, and read-only boxes filled by a pop-up calendar
  async function pickDate(el: HTMLElement, iso: string): Promise<ActionResult> {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return { ok: false, error: 'pick_date needs the date as YYYY-MM-DD' };
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const input = el as HTMLInputElement;
    if (input instanceof HTMLInputElement && !input.readOnly) {
      typeInto(input, iso);
      if (input.type === 'date') return input.value === iso ? { ok: true, detail: `set date ${iso}` } : { ok: false, error: 'date not accepted' };
      return { ok: true, detail: `typed "${iso}"; the field shows "${input.value}"` };
    }
    const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    // the model may point at the calendar icon instead of the box: check the box next to it
    const box0 = el instanceof HTMLInputElement ? el
      : (el.closest('td, div, span, p, label')?.querySelector<HTMLInputElement>('input:not([type=hidden])') ?? null);
    const before = box0?.value ?? '';
    const isDay = (e: Element) => /^\d{1,2}$/.test(clean((e as HTMLElement).innerText));
    const header = (): { el: HTMLElement; y: number; m: number } | null => {
      const re = new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{4})\\b`, 'i');
      for (const e of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        if (e.children.length > 2 || !visible(e)) continue;
        const t = clean(e.innerText);
        const h = t.length < 30 && t.match(re);
        if (h) return { el: e, y: Number(h[2]), m: MONTHS.indexOf(h[1].slice(0, 3).toLowerCase()) + 1 };
      }
      return null;
    };
    const boxOf = (start: HTMLElement) => {
      let box: HTMLElement | null = start;
      while (box && Array.from(box.querySelectorAll('td, button, a, div, span')).filter(isDay).length < 28) box = box.parentElement;
      return box;
    };
    // open the calendar: the field itself, else the clickable icon/button next to it
    let h = header();
    if (!h) {
      realClick(el);
      await sleep(300);
      h = header();
    }
    if (!h) {
      const cell = el.closest('td, div, span, p') || el.parentElement;
      const trigger = Array.from(cell?.querySelectorAll<HTMLElement>('img, button, a, span, i, input[type=button]') || [])
        .find((e) => e !== el && visible(e) && (getComputedStyle(e).cursor === 'pointer' || e.tagName === 'BUTTON' || !!e.getAttribute('onclick')));
      if (trigger) {
        realClick(trigger);
        await sleep(300);
        h = header();
      }
    }
    if (!h) return { ok: false, error: 'No calendar opened for this field' };
    let box = boxOf(h.el);
    if (!box) return { ok: false, error: 'Could not read the calendar' };
    for (let i = 0; i < 36 && h && (h.y !== y || h.m !== mo); i++) {
      const forward = h.y * 12 + h.m < y * 12 + mo;
      const pick = Array.from(box.querySelectorAll<HTMLElement>('td, th, a, button, span, div')).find((e) => {
        if (!visible(e) || (e.children.length > 0 && !['A', 'BUTTON'].includes(e.tagName))) return false;
        const t = clean(e.innerText || e.getAttribute('title') || e.getAttribute('aria-label')).toLowerCase();
        return forward ? /^(>|›|»|>>|next( month)?|→)$/.test(t) : /^(<|‹|«|<<|prev(ious)?( month)?|←)$/.test(t);
      });
      if (!pick) return { ok: false, error: 'Could not find the calendar next/previous month buttons' };
      realClick(pick);
      await sleep(200);
      h = header();
      box = h ? boxOf(h.el) : null;
      if (!box) return { ok: false, error: 'Could not read the calendar' };
    }
    if (!h || h.y !== y || h.m !== mo) return { ok: false, error: `Could not reach ${iso} in the calendar` };
    const day = Array.from(box!.querySelectorAll<HTMLElement>('td, button, a, div, span'))
      .filter((e) => visible(e) && isDay(e) && Number(clean(e.innerText)) === d)
      .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
    if (!day) return { ok: false, error: `Day ${d} not found in the calendar` };
    realClick(day);
    await sleep(300);
    const now = box0?.value ?? '';
    return box0 && now !== before
      ? { ok: true, detail: `picked ${iso} in the calendar; the field shows "${now}"` }
      : { ok: false, error: `Clicked day ${d} but the field still shows "${now}"` };
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

// A soft glow around the page and a pill saying what the assistant is doing (top frame only; in a shadow root so
// the page's own styles can't break it and the page reader never sees it)
function workingInPage(text: string | null) {
  let host = document.getElementById('__oa_working');
  if (!text) {
    host?.remove();
    return;
  }
  if (!host) {
    host = document.createElement('div');
    host.id = '__oa_working';
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .glow{position:fixed;inset:0;border-radius:6px;box-shadow:inset 0 0 0 2px rgba(124,58,237,.55),inset 0 0 28px rgba(124,58,237,.35);
        animation:b 2.4s ease-in-out infinite}
      @keyframes b{50%{box-shadow:inset 0 0 0 2px rgba(99,102,241,.35),inset 0 0 16px rgba(168,85,247,.2)}}
      .pill{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;max-width:70vw;
        padding:8px 14px 8px 8px;border-radius:999px;background:rgba(22,24,36,.92);color:#fff;font:500 13px/1.3 Inter,system-ui,sans-serif;
        box-shadow:0 8px 30px rgba(0,0,0,.25)}
      .m{width:22px;height:22px;border-radius:7px;background:conic-gradient(from 200deg,#6366f1,#a855f7,#ec4899,#6366f1);display:grid;
        place-items:center;font-size:12px;flex:none;animation:h 2.4s linear infinite}
      @keyframes h{to{filter:hue-rotate(360deg)}}
      .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.n{opacity:.6;margin-right:4px}</style>
      <div class="glow"></div><div class="pill"><span class="m">✦</span><span class="t"><span class="n">Office Assistant</span><span id="s"></span></span></div>`;
    (document.body || document.documentElement).appendChild(host);
  }
  host.shadowRoot!.getElementById('s')!.textContent = text;
}

export async function showWorking(tabId: number, text: string | null) {
  await browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: workingInPage, args: [text] }).catch(() => {});
}

function endTaskInPage() {
  try {
    sessionStorage.removeItem('__officeAssistantActive');
    sessionStorage.removeItem('__officeAssistantApproved');
  } catch {}
}

/** Reads every frame of the tab and merges them into one numbered list of elements. */
export async function snapshot(tabId: number): Promise<PageSnapshot> {
  await withTimeout(browser.scripting.executeScript({ target: { tabId, allFrames: true }, func: waitForStableInPage }), 8000)
    .catch(() => {});
  const res = await withTimeout(browser.scripting.executeScript({ target: { tabId, allFrames: true }, func: snapshotInPage }), 15000);
  const frames = res.filter((r) => r.result).sort((a, b) => (a.frameId ?? 0) - (b.frameId ?? 0));
  const top = frames.find((r) => (r.frameId ?? 0) === 0)?.result as FrameSnapshot | undefined;
  const out: PageSnapshot = { url: top?.url || '', title: top?.title || '', text: '', elements: [], notices: [], errors: [], frames: [] };
  const texts: string[] = [];
  let n = 1;
  for (const r of frames) {
    const f = r.result as FrameSnapshot;
    if (!f.visible) continue;
    const sub = (r.frameId ?? 0) !== 0;
    if (sub) out.frames!.push(`${f.frameName}: ${f.url}`);
    if (f.text) texts.push(sub ? `[${f.frameName} frame] ${f.text}` : f.text);
    for (const el of f.elements) {
      out.elements.push({ ...el, id: n++, _local: el.id, _frameId: r.frameId ?? 0, ...(sub ? { frame: f.frameName } : {}) });
    }
    out.notices!.push(...(f.notices || []));
    out.errors!.push(...(f.errors || []));
  }
  out.text = texts.join('\n').slice(0, 4000);
  out.notices = [...new Set(out.notices)];
  if (!out.frames!.length) delete out.frames;
  return out;
}

export async function act(tabId: number, page: PageSnapshot | null, action: PageAction): Promise<ActionResult> {
  const el = page?.elements.find((e) => e.id === action.id);
  const frameId = el?._frameId ?? 0;
  const local = { ...action, id: el?._local ?? action.id };
  // javascript: links (ASP.NET-style postbacks) only run when clicked from the page's own world
  const world = action.action === 'click' && /^javascript:/i.test(el?.href || '') ? 'MAIN' : 'ISOLATED';
  try {
    const run = (w: string) => withTimeout(browser.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: actInPage,
                                                                             args: [local], world: w } as any), 20000);
    const [res] = await run(world).catch((e) => (world === 'MAIN' ? run('ISOLATED') : Promise.reject(e)));
    return (res?.result as ActionResult) ?? { ok: true, detail: `${action.action} done; the page reloaded` };
  } catch (e) {
    // the frame navigated away while acting (e.g. a postback): the action itself went through
    return { ok: true, detail: `${action.action} done; the page reloaded` };
  }
}

export async function endTask(tabId: number) {
  await browser.scripting.executeScript({ target: { tabId, allFrames: true }, func: endTaskInPage }).catch(() => {});
  await showWorking(tabId, null);
}

/** Strips extension-only fields before the snapshot is passed to the model and the audit log. */
export function forBackend(page: PageSnapshot): PageSnapshot {
  return { ...page, elements: page.elements.map(({ _frameId, _local, ...e }) => e) };
}
