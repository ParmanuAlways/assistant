// Chrome only: a hidden page where the background reads the text of downloaded PDFs (pdf.js can't run in the
// background service worker). It only turns PDF bytes into text; filing happens in the background.
import { browser } from 'wxt/browser';
import { pdfText } from '../../lib/local/letters/pdf';
import { fromB64 } from '../../lib/letters';

browser.runtime.onMessage.addListener((m: any, _sender: unknown, reply: (r: unknown) => void) => {
  if (m?.type !== 'pdf-text' || m.target !== 'offscreen') return;
  pdfText(fromB64(m.pdf_b64)).then((text) => reply({ text }), (e) => reply({ error: String(e?.message || e) }));
  return true;   // answered asynchronously
});
