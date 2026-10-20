// The reply as a Word file: Times New Roman 12, A4 margins as in office drafts.
import { AlignmentType, Document, Packer, Paragraph, Tab, TextRun } from 'docx';
import type { Line } from './reply';

const cm = (n: number) => Math.round((n / 2.54) * 1440);   // twips
const pt = (n: number) => n * 20;

const ALIGN: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  c: AlignmentType.CENTER, cb: AlignmentType.CENTER, r: AlignmentType.RIGHT, p: AlignmentType.JUSTIFIED, b: AlignmentType.LEFT, l: AlignmentType.LEFT,
};

export async function toDocx(L: Line[]): Promise<Blob> {
  const paragraphs = L.map(([style, t]) => {
    const bold = style === 'cb' || style === 'b';
    const font = { font: 'Times New Roman', size: 24, bold };
    // a line indented with spaces ("    The Director...") gets a tab, like the Python version
    const parts = style === 'l' ? t.split('    ') : [t.trim()];
    const children = parts.flatMap((s, i) => [...(i ? [new TextRun({ children: [new Tab()], ...font })] : []),
      ...(s ? [new TextRun({ text: s, ...font })] : [])]);
    return new Paragraph({
      alignment: ALIGN[style],
      children,
      spacing: { after: pt(['c', 'cb', 'l'].includes(style) ? 2 : 6), ...(style === 'p' ? { before: pt(6) } : {}) },
      ...(style === 'p' ? { indent: { firstLine: cm(1.27) } } : {}),
    });
  });
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Times New Roman', size: 24 } } } },
    sections: [{ properties: { page: { margin: { left: cm(2.5), right: cm(2), top: cm(2) } } }, children: paragraphs }],
  });
  return Packer.toBlob(doc);
}
