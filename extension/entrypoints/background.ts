import { browser } from 'wxt/browser';
import { getConfig } from '../lib/config';
import { downloadsPath, fetchAsUser, ingest, isLetterDownload } from '../lib/letters';

export default defineBackground(() => {
  // Clicking the toolbar icon opens the side panel (Chrome). Firefox uses sidebar_action instead.
  (browser as any).sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  // A letter downloaded from e-Office is saved straight into its correspondent's folder:
  // Downloads/eOffice/<Ministry - Department>/<2026-10-12 - OM - Subject - File No>.pdf  (Chrome; Firefox uses "File my downloads")
  const downloads = (globalThis as any).chrome?.downloads;
  downloads?.onDeterminingFilename?.addListener((item: any, suggest: (s?: any) => void) => {
    (async () => {
      if (item.byExtensionId === browser.runtime.id) {
        // our own saves (reply drafts, filed copies): Chrome drops the name given to downloads.download while
        // this listener exists, so give it again
        const key = `savingAs:${item.url}`;
        const filename = ((await browser.storage.session.get(key)) as any)[key];
        await browser.storage.session.remove(key);
        return suggest(filename ? { filename, conflictAction: 'overwrite' } : undefined);
      }
      const cfg = await getConfig();
      if (!isLetterDownload(item, cfg)) return suggest();
      try {
        const buf = await fetchAsUser(item.finalUrl || item.url);
        if (!buf) return suggest();
        const f = await ingest(buf, item.finalUrl || item.url, item.filename);
        suggest({ filename: await downloadsPath(f), conflictAction: 'uniquify' });
        const { filedDownloads = {} } = await browser.storage.local.get('filedDownloads') as any;
        filedDownloads[item.id] = f.id;
        await browser.storage.local.set({ filedDownloads });
        browser.runtime.sendMessage({ type: 'letter-filed', letter: f }).catch(() => {});
      } catch {
        suggest();   // not signed in, backend down...: the download goes through as normal
      }
    })();
    return true;   // we answer asynchronously
  });
});
