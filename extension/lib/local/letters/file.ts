// Filing a letter: what it is, where it goes, kept once. No pdf.js here (the caller gives the text), so the Chrome
// background service worker can use this too.
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { ApiError } from '../../errors';
import { logEvent } from '../audit';
import { iso, today } from '../identity';
import * as store from '../store';
import { asks, classify, correspondent, fileName, INTENT_LABELS, parse, type Fields } from './read';
import { optionsFor } from './reply';

export interface LetterRow {
  id?: number; emp_id: string; sha256: string; source: string; source_url: string; original_name: string; fields: Fields;
  intent: string; deadline: string | null; folder: string; file_name: string; status: string; draft: any; created_at: string;
}

export function record(row: LetterRow) {
  const f = row.fields;
  return { id: row.id, folder: row.folder, file_name: row.file_name, intent: row.intent,
    intent_label: INTENT_LABELS[row.intent] ?? row.intent, deadline: row.deadline, status: row.status,
    source_url: row.source_url, original_name: row.original_name, received: row.created_at,
    format: f.format, file_no: f.file_no ?? null, date: f.date ?? null, subject: f.subject ?? null,
    from: row.folder, signatory: f.signatory ?? null, designation: f.designation ?? null, asks: f.asks ?? '',
    options: optionsFor(row.intent), draft: row.draft ?? null };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The inward register, one row per letter received */
export function registerCsv(rows: ReturnType<typeof record>[]): string {
  const out: unknown[][] = [['Received', 'Letter date', 'File No.', 'From', 'Type', 'Subject', 'What it asks', 'Reply due', 'Status', 'Filed as']];
  for (const r of rows) out.push([r.received, r.date, r.file_no, r.folder, r.intent_label, r.subject, r.asks, r.deadline || '', r.status,
    `${r.folder}/${r.file_name}`]);
  return out.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export async function blobToB64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** File a downloaded letter once (the same PDF twice is the same letter): read its text, remember where it goes. */
export async function fileLetter(emp_id: string, pdf: Uint8Array, text: string, source: string, url: string, originalName: string) {
  const sha = bytesToHex(sha256(pdf));
  const existing = await store.one<LetterRow>('letters', 'sha', [emp_id, sha]);
  if (existing) return { ...record(existing), new: false };
  const day = iso(await today());
  const f = parse(text, day);
  const [intent, why] = classify(f);
  f.intent_why = why;
  f.asks = asks(f);
  await store.put('files', { name: `letter:${sha}`, blob: new Blob([pdf as BlobPart], { type: 'application/pdf' }) });
  const row: LetterRow = { emp_id, sha256: sha, source: source.slice(0, 100), source_url: url.slice(0, 500),
    original_name: originalName.slice(0, 200), fields: f, intent, deadline: f.deadline ?? null, folder: correspondent(f),
    file_name: fileName(f), status: 'new', draft: null, created_at: day };
  try {
    row.id = await store.add('letters', row);
  } catch {   // the same letter filed at the same moment from another page
    const again = await store.one<LetterRow>('letters', 'sha', [emp_id, sha]);
    if (again) return { ...record(again), new: false };
    throw new ApiError(500, 'could not file the letter');
  }
  const rec = record(row);
  await logEvent(emp_id, 'letter_filed', { letter: rec.id, from: rec.folder, file: rec.file_name, intent: rec.intent, url: url.slice(0, 300) });
  return { ...rec, new: true };
}
