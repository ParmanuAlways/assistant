// Records pop-up messages (toasts, alerts, status lines) from the moment a page starts loading, so the
// assistant can see confirmations like "Message sent successfully" even after they fade away.
// Shares the extension's isolated world with the page reader (lib/page.ts reads window.__agentNotices).
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  main() {
    const w = window as any;
    if (w.__agentNotices) return;
    // Keep recent messages across page loads in this tab: many apps show "Message sent" on the page that
    // is just being left (e.g. a compose form that closes after sending)
    const KEY = '__officeAssistantNotices';
    let saved: { t: number; text: string }[] = [];
    try {
      saved = JSON.parse(sessionStorage.getItem(KEY) || '[]').filter((n: any) => Date.now() - n.t < 15000);
    } catch {}
    w.__agentNotices = saved;
    const persist = () => {
      try {
        sessionStorage.setItem(KEY, JSON.stringify(w.__agentNotices.slice(-10)));
      } catch {}
    };
    const sel = '[role=alert], [role=status], [aria-live], .toast, .notification, .alert, #messagestack, .messagestack';
    const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
    new MutationObserver((muts) => {
      for (const m of muts) {
        const target = m.target instanceof Element ? m.target : m.target.parentElement;
        const box = target?.closest(sel) || (target?.matches?.(sel) ? target : null);
        const text = clean(box?.textContent);
        if (box && text && text.length < 300) {
          w.__agentNotices.push({ t: Date.now(), text });
          persist();
        }
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  },
});
