// Letters tab: letters received through e-Office, filed per correspondent, with a reply drafted for the option the user picks.
import { browser } from 'wxt/browser';
import { api } from '../../lib/api';
import { getAccessToken } from '../../lib/auth';
import { getConfig } from '../../lib/config';
import { downloadsPath, fetchAsUser, fromB64, ingest, isLetterDownload } from '../../lib/letters';
import { esc } from '../../lib/timeline';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const st = { rows: [] as any[], q: '', s: '', current: null as any, option: '', draft: null as any };
const DAY = 86400000;

// ---------------------------------------------------------------- the folder the user chose (File System Access, Chrome)

function idb(): Promise<IDBDatabase> {
  return new Promise((ok, bad) => {
    const r = indexedDB.open('office-assistant', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
}
async function kv(key: string, value?: any): Promise<any> {
  const db = await idb();
  return new Promise((ok, bad) => {
    const tx = db.transaction('kv', value === undefined ? 'readonly' : 'readwrite');
    const r = value === undefined ? tx.objectStore('kv').get(key) : tx.objectStore('kv').put(value, key);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
}

/** The chosen folder if we may write to it (asking only when the user just clicked something). */
async function folder(ask = false): Promise<any | null> {
  const h = await kv('letterDir').catch(() => null);
  if (!h) return null;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return h;
  if (ask && (await h.requestPermission({ mode: 'readwrite' })) === 'granted') return h;
  return null;
}

async function writeTo(dir: any, sub: string, name: string, data: Blob | string, overwrite = true): Promise<boolean> {
  const d = sub ? await dir.getDirectoryHandle(sub, { create: true }) : dir;
  if (!overwrite) {
    try { await d.getFileHandle(name); return false; } catch {}
  }
  const w = await (await d.getFileHandle(name, { create: true })).createWritable();
  await w.write(data);
  await w.close();
  return true;
}

async function apiBlob(path: string): Promise<Blob> {
  const { apiUrl } = await getConfig();
  const r = await fetch(apiUrl + path, { headers: { Authorization: `Bearer ${await getAccessToken()}` } });
  if (!r.ok) throw new Error(r.statusText);
  return r.blob();
}

/** Save into the chosen folder, else into Downloads/eOffice/<Correspondent>/ */
async function save(sub: string, name: string, blob: Blob): Promise<string> {
  const dir = await folder();
  if (dir) {
    await writeTo(dir, sub, name, blob);
    return `${dir.name}/${sub}/${name}`;
  }
  const url = URL.createObjectURL(blob);
  const path = await downloadsPath({ folder: sub, file_name: name });
  await browser.storage.session.set({ [`savingAs:${url}`]: path });   // see background.ts
  await browser.downloads.download({ url, filename: path, conflictAction: 'overwrite', saveAs: false });
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return `Downloads/${path}`;
}

/** Copy every filed letter (and the register) into the chosen folder: one sub-folder per correspondent. */
async function syncToFolder(dir: any) {
  let n = 0;
  for (const r of st.rows) {
    const d = await dir.getDirectoryHandle(r.folder, { create: true });
    try { await d.getFileHandle(r.file_name); continue; } catch {}
    await writeTo(dir, r.folder, r.file_name, await apiBlob(`/api/letters/${r.id}/pdf`));
    n++;
  }
  await writeTo(dir, '', 'Register of letters.csv', await apiBlob('/api/letters/register.csv'));
  return n;
}

async function showWhere() {
  const dir = await kv('letterDir').catch(() => null);
  const granted = await folder();
  const root = (await getConfig()).letterFolder;
  $('lt-where').innerHTML = granted ? `Filed in your folder <b>${esc(granted.name)}</b>, one folder per sender`
    : dir ? `Folder <b>${esc(dir.name)}</b> needs your OK again — <button class="link tiny" id="lt-reconnect">reconnect</button>`
    : `Filed in <b>Downloads/${esc(root)}</b>, one folder per sender`;
  const re = document.getElementById('lt-reconnect');
  if (re) re.onclick = async () => { if (await folder(true)) { await syncToFolder(await folder()); showWhere(); } };
}

// ---------------------------------------------------------------- list

function dueChip(r: any) {
  if (r.status === 'filed') return '<span class="chip2 done">Filed - no reply needed</span>';
  if (r.status === 'drafted') return '<span class="chip2 done">Reply drafted</span>';
  if (!r.deadline) return '';
  const days = Math.round((new Date(r.deadline).getTime() - new Date(new Date().toDateString()).getTime()) / DAY);
  const when = new Date(r.deadline).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  if (days < 0) return `<span class="chip2 late">Overdue · was due ${when}</span>`;
  return `<span class="chip2 due">Reply by ${when}${days <= 7 ? ` · ${days === 0 ? 'today' : `${days} day${days > 1 ? 's' : ''}`}` : ''}</span>`;
}

function card(r: any) {
  return `<div class="comm letter" data-id="${r.id}"><div class="l1"><span class="ty">${esc(r.format || 'Letter')}</span>` +
    `<span>${esc(r.file_no || '')}</span><span class="dt">${r.date ? new Date(r.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''}</span></div>` +
    `<div class="sj">${esc(r.subject || r.original_name)}</div>` +
    `<div class="chips2"><span class="chip2">${esc(r.intent_label)}</span>${dueChip(r)}</div></div>`;
}

const todo = (r: any) => r.status === 'new';

function render() {
  const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (r: any) => words.every((w) => `${r.subject} ${r.folder} ${r.intent_label} ${r.file_no} ${r.asks}`.toLowerCase().includes(w));
  const byStatus = (r: any) => !st.s || (st.s === 'todo' ? todo(r) : r.status === st.s);
  const rows = st.rows.filter((r) => match(r) && byStatus(r));
  $('lt-count').textContent = st.rows.length ? `· ${st.rows.length} received, ${st.rows.filter(todo).length} to reply` : '';
  $('n-todo').textContent = String(st.rows.filter(todo).length);
  $('n-drafted').textContent = String(st.rows.filter((r) => r.status === 'drafted').length);
  $('n-filed').textContent = String(st.rows.filter((r) => r.status === 'filed').length);
  if (!st.rows.length) {
    $('lt-list').innerHTML = '<div class="empty">📨<br>No letters yet.<br><span class="small">Download letters from e-Office as usual — ' +
      'each one is filed in its sender\'s folder and shows up here.</span></div>';
    return;
  }
  // letters still to answer first, soonest due first; senders in the order of their most urgent letter
  const urgency = (r: any) => (todo(r) ? '0' : '1') + (r.deadline || '9999');
  rows.sort((a, b) => urgency(a).localeCompare(urgency(b)));
  const groups = new Map<string, any[]>();
  for (const r of rows) groups.set(r.folder, [...(groups.get(r.folder) || []), r]);
  const order = [...groups.entries()];
  $('lt-list').innerHTML = order.map(([f, rs]) => `<div class="lt-group">📁 ${esc(f)} <b>${rs.length}</b></div>` + rs.map(card).join('')).join('')
    || '<div class="empty">Nothing matches.</div>';
  $('lt-list').querySelectorAll<HTMLElement>('.letter').forEach((el) => (el.onclick = () => openLetter(Number(el.dataset.id))));
}

export async function loadLetters() {
  st.rows = await api<any[]>('/api/letters');
  render();
  showWhere();
}

// ---------------------------------------------------------------- one letter

async function openLetter(id: number) {
  const r = await api<any>(`/api/letters/${id}`);
  st.current = r;
  st.draft = r.draft;
  st.option = r.draft?.option || r.options[0].id;
  $('lt-list').hidden = true;
  $('lt-info').hidden = true;
  $('lt-detail').hidden = false;
  $('lt-meta').innerHTML = `<div class="lt-meta"><div class="sj">${esc(r.subject)}</div><table>` +
    `<tr><td>From</td><td>${esc(r.signatory || '')}${r.designation ? `, ${esc(r.designation)}` : ''}<br>${esc(r.folder)}</td></tr>` +
    `<tr><td>Ref.</td><td>${esc(r.format)} No. ${esc(r.file_no || '')} dated ${esc(r.date || '')}</td></tr>` +
    `<tr><td>Kind</td><td>${esc(r.intent_label)} ${dueChip(r)}</td></tr>` +
    `<tr><td>Filed as</td><td class="tiny">${esc(r.folder)}/${esc(r.file_name)} · <button class="link tiny" id="lt-pdf">open the letter</button></td></tr></table></div>`;
  $('lt-asks').textContent = r.asks || '—';
  $<HTMLTextAreaElement>('lt-notes').value = r.draft?.notes || '';
  $('lt-pdf').onclick = async () => browser.tabs.create({ url: URL.createObjectURL(await apiBlob(`/api/letters/${id}/pdf`)) });
  renderOptions();
  showDraft();
  $('lt-detail').scrollIntoView();
}

function renderOptions() {
  const r = st.current;
  $('lt-options').innerHTML = r.options.map((o: any) => `<button type="button" data-o="${o.id}" class="${o.id === st.option ? 'on' : ''}">` +
    `${esc(o.label)}${o.recommended ? '<span class="rec">usual</span>' : ''}</button>`).join('');
  $('lt-options').querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => {
    st.option = b.dataset.o!;
    renderOptions();
  }));
  const letter = r.options.find((o: any) => o.id === st.option)?.letter;
  $('lt-generate').textContent = letter ? 'Generate reply' : 'File it (no reply)';
  $('lt-notes').hidden = !letter;
  $('lt-ai').parentElement!.hidden = !letter;
}

function showDraft() {
  const d = st.draft;
  $('lt-draft').hidden = !d;
  if (!d) return;
  $('lt-preview').innerHTML = (d.lines || []).map(([s, t]: [string, string]) => `<div class="${s}">${esc(t)}</div>`).join('');
  $('lt-saved').textContent = d.ai ? 'Wording polished by the AI model — please read it before use.' : '';
}

async function generate(r = st.current, option = st.option, notes = $<HTMLTextAreaElement>('lt-notes').value, ai = $<HTMLInputElement>('lt-ai').checked) {
  const d = await api<any>(`/api/letters/${r.id}/draft`, 'POST', { option, notes, ai });
  let where = '';
  if (d.letter) where = await save(r.folder, d.filename, new Blob([fromB64(d.docx_b64) as BlobPart],
    { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
  return { ...d, where };
}

$('lt-generate').onclick = async () => {
  const b = $<HTMLButtonElement>('lt-generate');
  b.disabled = true;
  const label = b.textContent;
  b.textContent = $<HTMLInputElement>('lt-ai').checked ? 'Writing with the AI model…' : 'Writing…';
  try {
    const d = await generate();
    st.draft = d.letter ? d : null;
    showDraft();
    if (d.letter) $('lt-saved').textContent = `Saved to ${d.where}` + (d.ai ? ' · wording polished by the AI model, please read it.' : '');
    else { $('lt-draft').hidden = false; $('lt-preview').innerHTML = '<div>Marked as filed — no reply needed.</div>'; }
    const row = st.rows.find((x) => x.id === st.current.id);
    if (row) row.status = d.status;
    render();
    $('lt-draft').scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch (e: any) {
    $('lt-saved').textContent = `Could not draft: ${e.message}`;
  } finally {
    b.disabled = false;
    b.textContent = label;
  }
};
$('lt-save').onclick = async () => {
  const d = await generate(st.current, st.option, $<HTMLTextAreaElement>('lt-notes').value, false);
  $('lt-saved').textContent = `Saved to ${d.where}`;
};
$('lt-copy').onclick = async () => {
  await navigator.clipboard.writeText(st.draft?.text || '');
  $('lt-saved').textContent = 'Copied.';
};
$('lt-back').onclick = () => {
  $('lt-detail').hidden = true;
  $('lt-list').hidden = false;
  $('lt-info').hidden = false;
  render();
};

// ---------------------------------------------------------------- filing

/** Letters downloaded before (or in Firefox): read each again as the user, file a copy in its sender's folder, drop the loose copy. */
async function fileMyDownloads() {
  const cfg = await getConfig();
  const { filedDownloads = {} } = await browser.storage.local.get('filedDownloads') as any;
  const items = (await browser.downloads.search({ orderBy: ['-startTime'], limit: 1000 } as any))
    .filter((d: any) => d.state === 'complete' && !filedDownloads[d.id] && d.byExtensionId !== browser.runtime.id && isLetterDownload(d, cfg));
  let filed = 0, failed = 0;
  for (const d of items) {
    $('lt-info').textContent = `Filing ${filed + failed + 1} of ${items.length}…`;
    try {
      const buf = await fetchAsUser(d.finalUrl || d.url);
      if (!buf) { failed++; continue; }
      const f = await ingest(buf, d.finalUrl || d.url, d.filename.split(/[\\/]/).pop() || '');
      await save(f.folder, f.file_name, new Blob([buf], { type: 'application/pdf' }));
      filedDownloads[d.id] = f.id;
      if (d.exists !== false) await browser.downloads.removeFile(d.id).catch(() => {});   // the filed copy replaces it
      await browser.downloads.erase({ id: d.id }).catch(() => {});
      filed++;
    } catch {
      failed++;
    }
  }
  await browser.storage.local.set({ filedDownloads });
  await loadLetters();
  $('lt-info').textContent = items.length ? `Filed ${filed} letter${filed === 1 ? '' : 's'} from your downloads` +
    (failed ? ` · ${failed} could not be read (sign in to e-Office and try again)` : '') : 'No new e-Office downloads to file.';
}

/** A folder full of loose letters: read each PDF, move it into a folder per sender. */
async function tidyFolder() {
  const dir = await (window as any).showDirectoryPicker({ mode: 'readwrite', id: 'letters-tidy' });
  let moved = 0, skipped = 0;
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== 'file' || !/\.pdf$/i.test(name)) continue;
    $('lt-info').textContent = `Reading ${name}…`;
    try {
      const buf = await (await h.getFile()).arrayBuffer();
      const f: any = await ingest(buf, '', name);
      if (!f.subject && !f.file_no) { skipped++; continue; }   // not a letter
      await writeTo(dir, f.folder, f.file_name, new Blob([buf], { type: 'application/pdf' }));
      await dir.removeEntry(name);
      moved++;
    } catch {
      skipped++;
    }
  }
  await writeTo(dir, '', 'Register of letters.csv', await apiBlob('/api/letters/register.csv'));
  await loadLetters();
  $('lt-info').textContent = `Sorted ${moved} letter${moved === 1 ? '' : 's'} in ${dir.name} into one folder per sender` +
    (skipped ? ` · left ${skipped} other PDF${skipped === 1 ? '' : 's'} as they were` : '');
}

async function draftAll() {
  const pending = st.rows.filter(todo);
  let n = 0;
  for (const r of pending) {
    $('lt-info').textContent = `Drafting ${++n} of ${pending.length}: ${r.subject?.slice(0, 50)}…`;
    try {
      const d = await generate(r, r.options[0].id, '', false);
      r.status = d.status;
    } catch {}
    render();
  }
  const drafted = pending.filter((r) => r.status === 'drafted').length;
  $('lt-info').textContent = `Drafted ${drafted} repl${drafted === 1 ? 'y' : 'ies'} with the usual option` +
    ` and filed ${pending.filter((r) => r.status === 'filed').length} that need none. Open a letter to choose a different reply.`;
}

$('lt-file').onclick = () => fileMyDownloads().catch((e) => ($('lt-info').textContent = e.message));
$('lt-all').onclick = () => draftAll();
$('lt-choose').onclick = async () => {
  if (!('showDirectoryPicker' in window)) { $('lt-info').textContent = 'This browser files letters in Downloads only.'; return; }
  try {
    const dir = await (window as any).showDirectoryPicker({ mode: 'readwrite', id: 'letters' });
    await kv('letterDir', dir);
    $('lt-info').textContent = 'Copying your letters into the folder…';
    const n = await syncToFolder(dir);
    $('lt-info').textContent = `Your folder ${dir.name} now has every letter, one folder per sender (${n} copied) and the register.`;
    showWhere();
  } catch (e: any) {
    if (e.name !== 'AbortError') $('lt-info').textContent = e.message;
  }
};
$('lt-tidy').onclick = () => {
  if (!('showDirectoryPicker' in window)) { $('lt-info').textContent = 'Not available in this browser — use “File my downloads”.'; return; }
  tidyFolder().catch((e) => { if (e.name !== 'AbortError') $('lt-info').textContent = e.message; });
};
$('lt-register').onclick = async () => {
  $('lt-info').textContent = `Register saved to ${await save('', 'Register of letters.csv', await apiBlob('/api/letters/register.csv'))}`;
};
$('lt-q').addEventListener('input', () => { st.q = $<HTMLInputElement>('lt-q').value.trim(); render(); });
$('lt-status').querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => {
  st.s = b.dataset.s || '';
  $('lt-status').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  render();
}));

// a letter was just downloaded from e-Office and filed by the background
browser.runtime.onMessage.addListener(async (m: any) => {
  if (m?.type !== 'letter-filed') return;
  const dir = await folder();
  if (dir) await writeTo(dir, m.letter.folder, m.letter.file_name, await apiBlob(`/api/letters/${m.letter.id}/pdf`)).catch(() => {});
  if (!$('tab-letters').hidden && $('lt-detail').hidden) {
    await loadLetters();
    $('lt-info').textContent = `Filed: ${m.letter.subject?.slice(0, 60)} → 📁 ${m.letter.folder}`;
  }
});
