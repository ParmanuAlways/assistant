// Text of a PDF, line by line, read in the browser with pdf.js. The parser works on lines, so the text pieces are
// put back into lines by their position on the page (top to bottom, left to right).
import * as pdfjs from 'pdfjs-dist';
// pdf.js runs its "worker" on this thread: no worker file to ship, and it works the same in every extension page
// and in Node (the tests). Letters are small, so this is quick.
import * as pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs';

(globalThis as any).pdfjsWorker = pdfWorker;

interface Piece { str: string; x: number; y: number; w: number }

export async function pdfText(data: Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.slice(0));
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
    verbosity: 0 } as any).promise;
  const pages: string[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const items = (await page.getTextContent()).items as any[];
      const pieces: Piece[] = items.filter((it) => typeof it.str === 'string' && it.str.trim())
        .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width }));
      pieces.sort((a, b) => b.y - a.y || a.x - b.x);
      const lines: Piece[][] = [];
      for (const p of pieces) {
        const line = lines[lines.length - 1];
        if (line && Math.abs(line[0].y - p.y) <= 2) line.push(p);
        else lines.push([p]);
      }
      pages.push(lines.map((l) => l.sort((a, b) => a.x - b.x).reduce((s, p, i) => {
        if (!i) return p.str;
        const prev = l[i - 1];
        return s + (p.x - (prev.x + prev.w) > 1 ? ' ' : '') + p.str;
      }, '')).join('\n'));
    }
  } finally {
    await doc.destroy();
  }
  return pages.join('\n');
}
