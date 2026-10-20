import { browser } from 'wxt/browser';
import { getConfig } from '../lib/config';
import { downloadsPath, fetchAsUser, isLetterDownload, toB64 } from '../lib/letters';
import { currentUser } from '../lib/local/identity';
import { fileLetter } from '../lib/local/letters/file';

/** Text of a PDF, read in the offscreen page (pdf.js can't run in this service worker). Chrome only: Firefox has no
 *  way to rename a download as it starts, so there the panel's "File my downloads" files letters. */
async function pdfText(buf: ArrayBuffer): Promise<string> {
  const off = (globalThis as any).chrome.offscreen;
  try {
    await off.createDocument({ url: browser.runtime.getURL('/offscreen.html'), reasons: ['DOM_PARSER'],
      justification: 'Read the text of letters downloaded from e-Office (PDF) to file them' });
  } catch {}   // already open
  const r: any = await browser.runtime.sendMessage({ type: 'pdf-text', target: 'offscreen', pdf_b64: toB64(buf) });
  if (!r || r.error) throw new Error(r?.error || 'could not read the PDF');
  return r.text;
}

export default defineBackground(() => {
  // Clicking the toolbar icon opens the side panel (Chrome). Firefox uses sidebar_action instead.
  (browser as any).sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  // A letter downloaded from e-Office is saved straight into its correspondent's folder:
  // Downloads/eOffice/<Ministry - Department>/<2026-10-12 - OM - Subject - File No>.pdf  (Chrome; Firefox uses "File my downloads")
  // Read and filed here, in the browser: nothing is sent anywhere.
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
        const user = await currentUser();   // not signed in: the download goes through as normal
        const url = item.finalUrl || item.url;
        const buf = await fetchAsUser(url);
        if (!buf) return suggest();
        const f = await fileLetter(user.emp_id, new Uint8Array(buf), await pdfText(buf), 'e-Office', url, item.filename);
        suggest({ filename: await downloadsPath(f), conflictAction: 'uniquify' });
        const { filedDownloads = {} } = await browser.storage.local.get('filedDownloads') as any;
        filedDownloads[item.id] = f.id;
        await browser.storage.local.set({ filedDownloads });
        browser.runtime.sendMessage({ type: 'letter-filed', letter: f }).catch(() => {});
      } catch {
        suggest();
      }
    })();
    return true;   // we answer asynchronously
  });
});
