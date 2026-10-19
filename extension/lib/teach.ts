// Teach mode: record a person doing a workflow once (clicks, field values, pages) so the backend can
// turn it into a playbook. The recorder is injected into the page; it never records password values.
import { browser } from 'wxt/browser';

export interface TeachEvent {
  kind: 'click' | 'fill' | 'choose' | 'navigate';
  tag?: string;
  type?: string;
  label?: string;
  text?: string;
  value?: string;
  url: string;
  title: string;
}

function recorderInPage() {
  const w = window as any;
  if (w.__officeAssistantRecorder) return;
  w.__officeAssistantRecorder = true;
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const labelOf = (el: HTMLElement) => {
    const id = el.getAttribute('id');
    const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const text =
      el.getAttribute('aria-label') ||
      (forLabel && forLabel.textContent) ||
      (el.closest('label') && el.closest('label')!.textContent) ||
      el.getAttribute('placeholder') ||
      el.getAttribute('name') ||
      '';
    return clean(text).replace(/\s*\*$/, '');
  };
  const send = (event: Record<string, unknown>) => {
    try {
      (globalThis as any).chrome.runtime.sendMessage({ type: "teach-event", event: { ...event, url: location.href, title: document.title } });
    } catch {
      // extension reloaded; ignore
    }
  };

  document.addEventListener(
    'click',
    (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>(
        'a[href], button, input[type=submit], input[type=button], [role=button], [role=link]',
      );
      if (!el) return;
      const visible = clean(el.innerText || (el as HTMLInputElement).value);
      const aria = clean(el.getAttribute('aria-label') || el.getAttribute('title'));
      // Icon/symbol buttons ("+", "×", "⋮") are only meaningful through their accessible name
      const text = aria && !/[a-z0-9]{2,}/i.test(visible) ? aria : visible || aria;
      send({ kind: 'click', tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', text, label: aria });
    },
    true,
  );
  document.addEventListener(
    'change',
    (e) => {
      const el = e.target as HTMLInputElement;
      const tag = el.tagName.toLowerCase();
      if (!['input', 'select', 'textarea'].includes(tag)) return;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'radio' || type === 'checkbox') {
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

let recording: { tabId: number; onUpdated: (id: number, info: any, tab: any) => void } | null = null;

export async function startRecording(tabId: number, onEvent: (e: TeachEvent) => void) {
  await stopRecording();
  const inject = () => browser.scripting.executeScript({ target: { tabId }, func: recorderInPage }).catch(() => {});
  const onUpdated = (id: number, info: any, tab: any) => {
    if (id !== tabId || info.status !== 'complete') return;
    onEvent({ kind: 'navigate', url: tab.url, title: tab.title || '' });
    inject(); // a new page needs the recorder again
  };
  browser.tabs.onUpdated.addListener(onUpdated);
  recording = { tabId, onUpdated };
  const tab = await browser.tabs.get(tabId);
  onEvent({ kind: 'navigate', url: tab.url || '', title: tab.title || '' });
  await inject();
}

export async function stopRecording() {
  if (!recording) return;
  browser.tabs.onUpdated.removeListener(recording.onUpdated);
  recording = null;
}

export function describeEvent(e: TeachEvent): string {
  switch (e.kind) {
    case 'navigate': return `Opened "${e.title}" (${e.url})`;
    case 'click': return `Clicked ${e.tag === 'a' ? 'link' : 'button'} "${e.text || e.label}"`;
    case 'fill': return `Typed "${e.value}" into "${e.label}"`;
    case 'choose': return `Chose "${e.value}" for "${e.label}"`;
  }
}
