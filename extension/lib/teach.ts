// Teach mode: record a person doing a workflow once (clicks, field values, pages) so the assistant can
// turn it into a playbook and a replayable workflow. The recorder runs in every frame of the page; it never
// records password values.
import { browser } from 'wxt/browser';

export interface TeachEvent {
  kind: 'click' | 'fill' | 'choose' | 'navigate' | 'date' | 'upload';
  tag?: string;
  type?: string;
  label?: string;
  text?: string;
  value?: string;
  row?: string;           // table row of the clicked button
  menu?: string;          // hover menu the clicked link is in
  readonly?: boolean;     // a read-only box (filled by a picker)
  autocomplete?: boolean; // the value was picked from suggestions
  url: string;
  title: string;
}

export function recorderInPage() {
  const w = window as any;
  if (w.__officeAssistantRecorder) return;
  w.__officeAssistantRecorder = true;
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const labelOf = (el: HTMLElement) => {
    const id = el.getAttribute('id');
    const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const td = el.closest('td, dd');
    const prev = td?.previousElementSibling;
    const cell = prev && /^(TD|TH|DT)$/.test(prev.tagName) && !prev.querySelector('input, select, textarea') ? prev.textContent : '';
    const text =
      el.getAttribute('aria-label') ||
      (forLabel && forLabel.textContent) ||
      (el.closest('label') && el.closest('label')!.textContent) ||
      cell ||
      el.getAttribute('placeholder') ||
      el.getAttribute('name') ||
      '';
    return clean(text).replace(/\s*[*:]$/, '');
  };
  const send = (event: Record<string, unknown>) => {
    try {
      (globalThis as any).chrome.runtime.sendMessage({ type: 'teach-event', event: { ...event, url: location.href, title: document.title } });
    } catch {
      // extension reloaded; ignore
    }
  };
  const up = (el: Element): Element | null => el.parentElement || ((el.getRootNode() as ShadowRoot).host ?? null);
  // Read-only boxes are filled by pickers (calendars, lookups) without any event: compare their values at every
  // click, shortly after it, and when the page goes away (a fast submit right after picking a date)
  const known = new Map(Array.from(document.querySelectorAll<HTMLInputElement>('input[readonly]')).map((i) => [i, i.value]));
  const flushReadonly = () => {
    for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('input[readonly]'))) {
      const old = known.get(input) ?? '';
      known.set(input, input.value);
      if (input.value && input.value !== old) {
        const isDate = /\d{1,4}[-/. ][a-z0-9]{1,3}[-/. ]\d{2,4}/i.test(input.value);
        send({ kind: isDate ? 'date' : 'fill', tag: 'input', label: labelOf(input), value: clean(input.value), readonly: true });
      }
    }
  };
  window.addEventListener('pagehide', flushReadonly);
  document.addEventListener('submit', flushReadonly, true);
  let lastTyped: { el: HTMLInputElement; t: number } | null = null;

  document.addEventListener('input', (e) => {
    const el = e.composedPath()[0] as HTMLInputElement;
    if (el?.tagName === 'INPUT' && !['checkbox', 'radio', 'file', 'password'].includes(el.type)) lastTyped = { el, t: Date.now() };
  }, true);

  document.addEventListener(
    'click',
    (e) => {
      const target = e.composedPath()[0] as HTMLElement;
      if (!(target instanceof Element)) return;
      const std = target.closest<HTMLElement>(
        'a[href], button, input[type=submit], input[type=button], input[type=image], [role=button], [role=link], [onclick]',
      );
      let el = std;
      if (!el && getComputedStyle(target).cursor === 'pointer') {   // home-made widgets: the outermost pointer element
        el = target;
        for (let p = up(el); p && p !== document.body && getComputedStyle(p).cursor === 'pointer'; p = up(p)) el = p as HTMLElement;
      }
      if (!el && target.tagName === 'INPUT' && (target as HTMLInputElement).readOnly) el = target;
      flushReadonly();   // what earlier clicks picked
      if (!el) return;
      const typed = lastTyped && Date.now() - lastTyped.t < 8000 ? { el: lastTyped.el, value: lastTyped.el.value } : null;
      const visible = clean(el.innerText || (el as HTMLInputElement).value || el.getAttribute('alt'));
      const aria = clean(el.getAttribute('aria-label') || el.getAttribute('title'));
      // Icon/symbol buttons ("+", "×", "⋮") are only meaningful through their accessible name
      const text = aria && !/[a-z0-9]{2,}/i.test(visible) ? aria : visible || aria;
      let row = '';
      for (let p: Element | null = el; p; p = up(p)) {
        if (p.tagName === 'TR') {
          if (p.querySelectorAll('td').length > 2) row = clean((p as HTMLElement).innerText);
          break;
        }
      }
      const list = el.closest('ul, ol, nav, [role=menu]');
      const item = list?.parentElement?.closest('li') || null;
      const menu = item ? clean((item.firstElementChild as HTMLElement | null)?.innerText).replace(/[▸▶►›»]/g, '').trim() : '';
      const isReadonly = el.tagName === 'INPUT' && (el as HTMLInputElement).readOnly;
      const click = { kind: 'click', tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', text, label: aria,
                      row: row || undefined, menu: menu || undefined, readonly: isReadonly || undefined };
      // Send at once: a click that navigates (a link, a postback) would lose a delayed message.
      // Only a click on a home-made widget right after typing waits, in case it picks a suggestion.
      const maybeSuggestion = !!typed && !std;
      if (!maybeSuggestion) send(click);
      setTimeout(() => {
        if (maybeSuggestion) {
          if (typed!.el.value !== typed!.value) {
            send({ kind: 'fill', tag: 'input', label: labelOf(typed!.el), value: clean(typed!.el.value), autocomplete: true });
            lastTyped = null;
          } else {
            send(click);
          }
        }
        flushReadonly();   // what this click picked
      }, 400);
    },
    true,
  );
  document.addEventListener(
    'change',
    (e) => {
      const el = e.composedPath()[0] as HTMLInputElement;
      const tag = el.tagName?.toLowerCase();
      if (!['input', 'select', 'textarea'].includes(tag)) return;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'file') {
        send({ kind: 'upload', tag, type, label: labelOf(el), value: Array.from(el.files || []).map((f) => f.name).join(', ') });
      } else if (type === 'radio' || type === 'checkbox') {
        const legend = el.closest('fieldset')?.querySelector('legend');
        send({ kind: 'choose', tag, type, label: clean(legend?.textContent).replace(/\s*\*$/, '') || labelOf(el),
               value: el.checked ? labelOf(el) : `(unchecked) ${labelOf(el)}` });
      } else if (tag === 'select') {
        const sel = el as unknown as HTMLSelectElement;
        send({ kind: 'choose', tag, label: labelOf(el), value: clean(sel.options[sel.selectedIndex]?.text) });
      } else {
        send({ kind: 'fill', tag, type, label: labelOf(el), value: type === 'password' ? '(hidden)' : clean(el.value) });
      }
    },
    true,
  );
}

let recording: { tabId: number; onUpdated: (id: number, info: any, tab: any) => void; onMessage: (m: any) => any } | null = null;

export async function startRecording(tabId: number, onEvent: (e: TeachEvent) => void) {
  await stopRecording();
  const inject = () => browser.scripting.executeScript({ target: { tabId, allFrames: true }, func: recorderInPage }).catch(() => {});
  const onUpdated = (id: number, info: any, tab: any) => {
    if (id !== tabId || info.status !== 'complete') return;
    onEvent({ kind: 'navigate', url: tab.url, title: tab.title || '' });
    inject(); // a new page needs the recorder again
  };
  // Frames that load later (a frameset's main frame changing page) ask whether a recording is on
  const onMessage = (m: any) => (m?.type === 'teach-ping' ? Promise.resolve({ recording: true }) : undefined);
  browser.tabs.onUpdated.addListener(onUpdated);
  browser.runtime.onMessage.addListener(onMessage);
  recording = { tabId, onUpdated, onMessage };
  const tab = await browser.tabs.get(tabId);
  onEvent({ kind: 'navigate', url: tab.url || '', title: tab.title || '' });
  await inject();
}

export async function stopRecording() {
  if (!recording) return;
  browser.tabs.onUpdated.removeListener(recording.onUpdated);
  browser.runtime.onMessage.removeListener(recording.onMessage);
  recording = null;
}

export function describeEvent(e: TeachEvent): string {
  switch (e.kind) {
    case 'navigate': return `Opened "${e.title}" (${e.url})`;
    case 'click': return `Clicked ${e.tag === 'a' ? 'link' : 'button'} "${e.text || e.label}"` +
      (e.menu ? ` in menu "${e.menu}"` : '') + (e.row ? ` in row "${e.row.slice(0, 40)}"` : '');
    case 'fill': return `${e.autocomplete ? 'Picked' : 'Typed'} "${e.value}" ${e.autocomplete ? 'for' : 'into'} "${e.label}"`;
    case 'choose': return `Chose "${e.value}" for "${e.label}"`;
    case 'date': return `Picked date "${e.value}" for "${e.label}"`;
    case 'upload': return `Attached "${e.value}" to "${e.label}"`;
  }
}
