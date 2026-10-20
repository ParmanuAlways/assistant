// Letters received through e-Office: read once, filed per sender, replies drafted. All in the browser.
import { ApiError } from '../../errors';
import { logEvent } from '../audit';
import { getProfile, iso, today } from '../identity';
import * as L from '../letters';
import { b64ToBytes, blobToB64, fileLetter, type LetterRow, record, registerCsv } from '../letters/file';
import { route } from '../router';
import * as store from '../store';

async function own(emp_id: string, id: string): Promise<LetterRow> {
  const row = await store.get<LetterRow>('letters', Number(id));
  if (!row || row.emp_id !== emp_id) throw new ApiError(404, 'no such letter');
  return row;
}

route('POST', '/api/letters/ingest', async ({ user, body }) => {
  let pdf: Uint8Array;
  try {
    pdf = b64ToBytes(body.pdf_b64 || '');
  } catch {
    throw new ApiError(400, 'not base64');
  }
  if (String.fromCharCode(...pdf.subarray(0, 4)) !== '%PDF' || pdf.length > 20_000_000) throw new ApiError(400, 'not a PDF');
  return fileLetter(user.emp_id, pdf, await L.pdfText(pdf), body.source || 'e-Office', body.url || '', body.original_name || '');
});

route('GET', '/api/letters', async ({ user }) => {
  const rows = await store.all<LetterRow>('letters', 'emp_id', user.emp_id);
  rows.sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || a.id! - b.id!);
  return rows.map(record);
});

route('GET', '/api/letters/register.csv', async ({ user }) => {
  const rows = (await store.all<LetterRow>('letters', 'emp_id', user.emp_id)).sort((a, b) => a.id! - b.id!);
  return new Blob([registerCsv(rows.map(record))], { type: 'text/csv' });
});

route('GET', '/api/letters/:id', async ({ user, params }) => {
  const row = await own(user.emp_id, params.id);
  return { ...record(row), body: row.fields.body || '' };
});

route('GET', '/api/letters/:id/pdf', async ({ user, params }) => {
  const row = await own(user.emp_id, params.id);
  const f = await store.get('files', `letter:${row.sha256}`);
  if (!f) throw new ApiError(404, 'the PDF is no longer kept');
  return f.blob as Blob;
});

route('POST', '/api/letters/:id/draft', async ({ user, params, body }) => {
  const row = await own(user.emp_id, params.id);
  const f = row.fields;
  const option = String(body.option || '');
  if (!L.OPTIONS[row.intent].some((o) => o[0] === option)) throw new ApiError(400, 'unknown option');
  const base = row.file_name.replace(/\.pdf$/, '');
  if (option === 'none') {
    await store.put('letters', { ...row, status: 'filed', draft: null });
    await logEvent(user.emp_id, 'letter_closed', { letter: row.id, option: 'none' });
    return { letter: false, status: 'filed' };
  }
  const prof = await getProfile(user.emp_id);
  const me = { name: user.name, designation: prof.designation || 'Deputy Secretary' };
  const day = iso(await today());
  const ourNo = `A-11013/${row.id}/${day.slice(0, 4)}-Admn (${L.OUR_OFFICE.short})`;
  const notes = String(body.notes || '').slice(0, 3000);
  const d = L.draftReply(f, row.intent, option, notes, me, day, ourNo);
  let lines = d.lines, aiUsed = false;
  if (body.ai) {
    const paras = lines.filter(([s]) => s === 'p').map(([, t]) => t);
    try {
      const { callModel, modelCfg } = await import('../model');
      const out = JSON.parse(await callModel(await modelCfg(user.emp_id), [
        { role: 'system', content: L.AI_PROMPT },
        { role: 'user', content: `LETTER RECEIVED (subject): ${f.subject || ''}\n\nDRAFT PARAGRAPHS:\n${JSON.stringify(paras)}` }],
      { schema: L.AI_SCHEMA, timeout: 300 }));
      const next = L.applyParas(lines, out.paras || []);
      aiUsed = next !== lines;
      lines = next;
    } catch (e: any) {
      await logEvent(user.emp_id, 'model_error', { where: 'letter_draft', error: String(e?.message || e).slice(0, 200) });
    }
  }
  const draft = { option, notes, kind: d.kind, text: L.linesToText(lines), lines, ai: aiUsed };
  await store.put('letters', { ...row, status: 'drafted', draft });
  await logEvent(user.emp_id, 'reply_drafted', { letter: row.id, option, kind: d.kind, ai: aiUsed });
  return { letter: true, ...draft, status: 'drafted', filename: `${base} - REPLY DRAFT.docx`, docx_b64: await blobToB64(await L.toDocx(lines)) };
});
