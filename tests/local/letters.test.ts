// Letters, read and answered entirely in the browser: the 100 dummy e-Office letters are rendered to PDF (by the
// generator in portal/govletters.py), read back with pdf.js, and checked against what the generator says they are.
// Run: tests/local/run.sh tests/local/letters.test.ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signIn } from './browser-shim';
import { check, summary } from './check';
import truth from '../fixtures/letters-truth.json';
import * as L from '../../extension/lib/local/letters';
import { api } from '../../extension/lib/api';

// run from the repository root (as run.sh is)
const REPO = process.cwd();
const T = '2026-10-19';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letters-'));
execFileSync('python3', ['-c', `import sys; sys.path.insert(0, '${REPO}/portal'); import govletters
for L in govletters.generate(100): open(f"${dir}/{L['id']}.pdf", 'wb').write(govletters.render_pdf(L))`]);
const pdfOf = (id: number) => new Uint8Array(fs.readFileSync(path.join(dir, `${id}.pdf`)));

// ---- reading all 100
const got: Record<string, number> = { intent: 0, file_no: 0, date: 0, subject: 0, sender_parent: 0, sender_office: 0, signatory: 0, format: 0, deadline: 0 };
const misses: string[] = [];
const parsed: Record<number, L.Fields> = {};
for (const t of truth as any[]) {
  const f = L.parse(await L.pdfText(pdfOf(t.id)), T);
  parsed[t.id] = f;
  const ok: Record<string, boolean> = {
    intent: L.classify(f)[0] === t.intent,
    file_no: (f.file_no || '') === t.file_no.replace(/^(F\.)?No\./, ''),
    date: f.date === t.date, subject: (f.subject || '').toLowerCase() === t.subject.toLowerCase(),
    sender_parent: f.sender_parent === t.sender_parent, sender_office: f.sender_office === t.sender_office,
    signatory: f.signatory === t.signatory, format: f.format === t.format, deadline: (f.deadline ?? null) === t.deadline,
  };
  for (const [k, v] of Object.entries(ok)) {
    got[k] += +v;
    if (!v && misses.length < 12) misses.push(`${t.id} ${k}: want ${JSON.stringify((t as any)[k === 'intent' ? 'intent' : k])} got ${JSON.stringify(k === 'intent' ? L.classify(f)[0] : (f as any)[k])}`);
  }
}
console.log('read from 100 PDFs:', JSON.stringify(got));
if (misses.length) console.log(misses.join('\n'));
check('letters: what it asks, 100/100', got.intent === 100, got.intent);
for (const k of ['file_no', 'date', 'subject', 'sender_parent', 'sender_office', 'signatory', 'format', 'deadline'])
  check(`letters: ${k} 100/100`, got[k] === 100, got[k]);

// ---- rules
check("letters: 'latest by' wins over 'within six weeks'",
  L.deadline('Replies may be furnished within six weeks, latest by 30.11.2026.', T) === '2026-11-30');
check("letters: 'within a fortnight'", L.deadline('reply within a fortnight', T) === '2026-11-02');
const f0: L.Fields = { sender_parent: 'Ministry of Finance', sender_office: 'Department of Expenditure', date: '2026-10-01', format: 'Office Memorandum',
  subject: 'Rationalisation of: expenditure / economy?', file_no: '7(2)/E.Coord-I/2026' };
check('letters: folder per correspondent', L.correspondent(f0) === 'Ministry of Finance - Department of Expenditure');
check('letters: safe file name', L.fileName(f0) === '2026-10-01 - OM - Rationalisation of- expenditure - economy - 7(2)-E.Coord-I-2026.pdf', L.fileName(f0));

// ---- through the local API, as the panel uses it
signIn({ preferred_username: 'ravi', name: 'Ravi Kumar', emp_id: 'EMP1042', realm_access: { roles: ['employee'] } });
const meeting = (truth as any[]).find((x) => x.intent === 'meeting' && x.format === 'Office Memorandum');
const b64 = Buffer.from(pdfOf(meeting.id)).toString('base64');
const r1 = await api('/api/letters/ingest', 'POST', { pdf_b64: b64, url: 'http://e/1', original_name: '1.pdf' });
const r2 = await api('/api/letters/ingest', 'POST', { pdf_b64: b64, url: 'http://e/1', original_name: '1.pdf' });
check('letters: same PDF filed once', r1.new && !r2.new && r1.id === r2.id);
check('letters: options, recommended first, a polite regret', r1.options[0].recommended && r1.options.some((o: any) => o.id === 'regret'));
const d = await api(`/api/letters/${r1.id}/draft`, 'POST', { option: 'regret', notes: '' });
const theirNo = meeting.file_no.replace(/^(F\.)?No\./, '');
check('letters: OM answered with an OM that cites it', d.kind === 'OM' && d.text.includes('OFFICE MEMORANDUM') && d.text.includes(theirNo)
  && d.text.includes('prior official engagements'), d.text.slice(0, 300));
const docx = Buffer.from(d.docx_b64, 'base64');
check('letters: Word file', docx.subarray(0, 2).toString() === 'PK' && d.filename.endsWith(' - REPLY DRAFT.docx'));
const DO = (truth as any[]).find((x) => x.format === 'D.O. letter');
const fd = parsed[DO.id];
const it = L.classify(fd)[0];
const dd = L.draftReply(fd, it, L.OPTIONS[it][0][0], '', { name: 'Ravi Kumar' }, T, 'A-2/2026');
check('letters: D.O. answered with a D.O. (Dear .., Yours sincerely)', dd.kind === 'DO' && dd.text.includes('Yours sincerely')
  && dd.text.split('Dear ').length === 2);
const list = await api('/api/letters');
check('letters: listed, drafted', list.length === 1 && list[0].status === 'drafted');
const pdfBlob = await api(`/api/letters/${r1.id}/pdf`);
check('letters: the PDF is kept', pdfBlob instanceof Blob && (await pdfBlob.size) === pdfOf(meeting.id).length);
const csv = await (await api('/api/letters/register.csv') as Blob).text();
check('letters: register CSV', csv.includes('What it asks') && csv.includes(r1.folder), csv.slice(0, 200));
const circ = (truth as any[]).find((x) => x.intent === 'circular_info');
const rc = await api('/api/letters/ingest', 'POST', { pdf_b64: Buffer.from(pdfOf(circ.id)).toString('base64') });
const none = await api(`/api/letters/${rc.id}/draft`, 'POST', { option: 'none' });
check('letters: a circular is filed with no reply', !none.letter && none.status === 'filed');
let status = 0;
try { await api('/api/letters/ingest', 'POST', { pdf_b64: Buffer.from('hello').toString('base64') }); } catch (e: any) { status = e.status; }
check('letters: not a PDF is refused', status === 400);
fs.rmSync(dir, { recursive: true, force: true });
summary();
