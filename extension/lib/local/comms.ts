// Communications: the user's letters, notes, circulars and e-mails from office apps, sorted into folders and
// searchable in plain words ("letters I sent to Priya about leave last month").
// Items are read from the office app as the user (with their own session) and kept per user in the browser.
// Folders, the query parser and the search are plain rules: fast, offline, no model needed.
import * as store from './store';

// Topic folders, first match wins (the type "Circular" gets its own folder)
const FOLDERS: [string, RegExp][] = [
  ['Leave & HR', /\b(leave|holiday|attendance|hr department|appraisal|salary|payslip)\b/],
  ['IT', /\b(laptop|vpn|e-?mail server|it service|software|password|network|lt-\d+)\b/],
  ['Purchase & Finance', /\b(purchase|po-\d+|pr-\d+|reimburse\w*|budget|invoice|finance|claim|vendor)\b/],
  ['Travel', /\b(travel|trip|advance|visit to)\b/],
  ['Meetings', /\b(meeting|minutes|agenda)\b/],
  ['Projects', /\b(project|prj-\d+|milestone|status report)\b/],
  ['Admin', /\b(fire drill|desk|admin|facility|parking)\b/],
];
export const FOLDER_NAMES = ['Circulars', ...FOLDERS.map(([f]) => f), 'Other'];

export interface Comm {
  id?: number; emp_id: string; source: string; ext_id: string; direction: string; type: string; ref: string; date: string;
  sender: string; recipients: string; cc: string; subject: string; body: string; attachments: string[]; url: string; folder: string;
}

export function folderFor(item: any): string {
  if ((item.type || '').toLowerCase() === 'circular') return 'Circulars';
  const text = `${item.subject || ''} ${item.body || ''} ${item.sender || ''} ${item.recipients || ''}`.toLowerCase();
  return FOLDERS.find(([, rx]) => rx.test(text))?.[0] || 'Other';
}

/** Insert or update the items of one source. Direction: what the user sent vs. received. */
export async function sync(emp_id: string, source: string, items: any[], me_hint = ''): Promise<number> {
  const existing = new Map<string, number>();
  for (const r of await store.all<Comm>('comms', 'emp_id', emp_id)) if (r.source === source) existing.set(r.ext_id, r.id!);
  let n = 0;
  await store.tx('comms', 'readwrite', async (t) => {
    const s = t.objectStore('comms');
    for (const it of items) {
      const sender = String(it.from ?? it.sender ?? ''), recipients = String(it.to ?? it.recipients ?? '');
      const direction = it.direction || (it.box === 'out' || (me_hint && sender.toLowerCase().includes(me_hint.toLowerCase())) ? 'sent' : 'received');
      const row: Comm = { emp_id, source, ext_id: String(it.id), direction, type: it.type || 'E-mail', ref: it.ref || '',
        date: String(it.date || '').slice(0, 10), sender, recipients, cc: it.cc || '', subject: it.subject || '', body: it.body || '',
        attachments: it.attachments || [], url: it.url || '', folder: '' };
      row.folder = folderFor(row);
      const id = existing.get(row.ext_id);
      if (id !== undefined) row.id = id;
      await store.req(s.put(row));
      n++;
    }
  });
  return n;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON3 = MONTHS.map((m) => m.slice(0, 3));
const STOP = new Set(['find', 'show', 'me', 'my', 'the', 'a', 'an', 'all', 'any', 'about', 'regarding', 'on', 'of', 'for', 'with', 'i', 'what',
  'which', 'where', 'is', 'are', 'was', 'did', 'that', 'those', 'these', 'please', 'list', 'get', 'search', 'communication',
  'communications', 'letter', 'letters', 'note', 'notes', 'circular', 'circulars', 'mail', 'mails', 'email', 'emails',
  'e-mail', 'e-mails', 'memo', 'memos', 'sent', 'send', 'received', 'got', 'inward', 'outward', 'have', 'has', 'in', 'and',
  'or', 'last', 'this', 'week', 'month', 'year', 'today', 'yesterday', 'from', 'to', 'by', 'since', 'before', 'after']);

const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const escRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Query { terms: string[]; direction?: string; type?: string; to?: string; from?: string; after?: string; before?: string }

/** Plain words -> filters + search terms. "letters I sent to Priya about leave last month" ->
 *  direction=sent, to=priya, type=Letter, after/before = last month, terms=[leave]. */
export function parseQuery(q: string, today: Date): Query {
  const ql = ` ${(q || '').toLowerCase()} `;
  const f: Query = { terms: [] };
  if (/\b(i sent|i have sent|i send|did i send|i wrote|did i write|sent by me|my sent|outward|outgoing|i replied)\b/.test(ql) || /\bsent\b/.test(ql))
    f.direction = 'sent';
  if (/\b(received|inward|incoming|i got|sent to me|came to me)\b/.test(ql)) f.direction = 'received';
  for (const [word, typ] of [['letter', 'Letter'], ['note', 'Note'], ['circular', 'Circular'], ['memo', 'Note'], ['e-?mails?|mails?', 'E-mail']]) {
    if (new RegExp(`\\b(${word})s?\\b`).test(ql)) { f.type = typ; break; }
  }
  const name = '([a-z][a-z.]+(?:\\s+(?!about|on|in|last|this|regarding|for|since|before|after|from|to)[a-z][a-z.]+)?)';
  let m = ql.match(new RegExp('\\bto\\s+' + name));
  if (m && !['me', 'all', 'the'].includes(m[1])) f.to = m[1].trim();
  m = ql.match(new RegExp('\\bfrom\\s+' + name));
  if (m && !['me', 'the'].includes(m[1])) f.from = m[1].trim();
  // dates (weeks start on Monday, like Python's weekday())
  const wd = (today.getDay() + 6) % 7;
  if (ql.includes('last week')) {
    const start = addDays(today, -(wd + 7));
    f.after = isoDate(start); f.before = isoDate(addDays(start, 6));
  } else if (ql.includes('this week')) {
    f.after = isoDate(addDays(today, -wd));
  } else if (ql.includes('last month')) {
    const prevEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    f.after = isoDate(new Date(prevEnd.getFullYear(), prevEnd.getMonth(), 1)); f.before = isoDate(prevEnd);
  } else if (ql.includes('this month')) {
    f.after = isoDate(new Date(today.getFullYear(), today.getMonth(), 1));
  } else if (ql.includes('yesterday')) {
    f.after = f.before = isoDate(addDays(today, -1));
  } else if (ql.includes('today')) {
    f.after = f.before = isoDate(today);
  } else if ((m = ql.match(new RegExp(`\\b(?:in|during)\\s+(${MONTHS.join('|')}|${MON3.join('|')})\\b(?:\\s+(\\d{4}))?`)))) {
    const mon = MON3.indexOf(m[1].slice(0, 3)) + 1;
    const year = m[2] ? Number(m[2]) : (mon <= today.getMonth() + 1 ? today.getFullYear() : today.getFullYear() - 1);
    f.after = isoDate(new Date(year, mon - 1, 1)); f.before = isoDate(new Date(year, mon, 0));
  }
  // the rest are words to look for (references like PO-1234 kept whole)
  let rest = ql;
  for (const k of ['to', 'from'] as const) if (f[k]) rest = rest.replace(new RegExp(`\\b${k}\\s+${escRx(f[k]!)}\\b`), ' ');
  for (const tok of rest.match(/[a-z]{2,}-?\d+|[a-z0-9]+/g) || []) {
    if (!STOP.has(tok) && !/^\d+$/.test(tok) && !MONTHS.includes(tok) && !MON3.includes(tok)) f.terms.push(tok);
  }
  return f;
}

// ---------------------------------------------------------------- full-text matching (what SQLite FTS5 + porter did)

/** A light Porter-style stemmer: enough that "holidays" finds "holiday" and "travelling" finds "travel". */
export function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  let s = w;
  if (s.endsWith('sses')) s = s.slice(0, -2);
  else if (s.endsWith('ies')) s = s.slice(0, -3) + 'i';
  else if (s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us')) s = s.slice(0, -1);
  if (s.endsWith('eed')) { /* keep */ } else if (/[aeiou].*(ed|ing)$/.test(s)) {
    s = s.replace(/(ed|ing)$/, '');
    if (/(at|bl|iz)$/.test(s)) s += 'e';
    else if (/([^aeiouslz])\1$/.test(s)) s = s.slice(0, -1);
  }
  if (/[aeiou].*y$/.test(s)) s = s.slice(0, -1) + 'i';
  for (const [a, b] of [['ational', 'ate'], ['tional', 'tion'], ['ization', 'ize'], ['fulness', 'ful'], ['ousness', 'ous'], ['iveness', 'ive'], ['ement', ''], ['ment', ''], ['ness', '']] as const)
    if (s.endsWith(a) && s.length - a.length >= 3) { s = s.slice(0, -a.length) + b; break; }
  return s;
}

const tokens = (text: string) => (text || '').toLowerCase().match(/[a-z0-9]+/g) || [];

interface Indexed { row: Comm; fields: { name: string; weight: number; toks: string[]; stems: string[]; text: string }[] }

function indexRow(row: Comm): Indexed {
  const f = (name: string, weight: number, text: string) => {
    const toks = tokens(text);
    return { name, weight, toks, stems: toks.map(stem), text: text.toLowerCase() };
  };
  return { row, fields: [f('subject', 3, row.subject), f('body', 1, row.body), f('people', 2, `${row.sender} ${row.recipients} ${row.cc}`), f('ref', 2, row.ref)] };
}

/** How often a search term occurs, weighted by where (0 = not at all). Words match as prefixes of the stem
 *  ("hol" finds "holiday", as `hol*` did); references with a hyphen match as a phrase ("pr-1234"). */
function termScore(ix: Indexed, term: string): number {
  let score = 0;
  if (term.includes('-')) {
    for (const f of ix.fields) if (f.text.includes(term)) score += f.weight;
    return score;
  }
  const st = stem(term);
  for (const f of ix.fields)
    for (let i = 0; i < f.toks.length; i++)
      if (f.toks[i].startsWith(term) || f.stems[i].startsWith(st)) score += f.weight;
  return score;
}

/** About 14 words of the body around the first match, with the matches in <mark>…</mark>. */
function snippet(body: string, terms: string[]): string {
  if (!terms.length) return '';
  const parts = (body || '').split(/(\s+)/);
  const words = parts.filter((_, i) => i % 2 === 0);
  const hit = (w: string) => {
    const lw = w.toLowerCase().replace(/[^a-z0-9-]/g, '');
    return !!lw && terms.some((t) => t.includes('-') ? lw.includes(t) : lw.startsWith(t) || stem(lw.replace(/-/g, '')).startsWith(stem(t)));
  };
  const first = words.findIndex(hit);
  if (first < 0) return '';
  const start = Math.max(0, first - 4), end = Math.min(words.length, start + 14);
  const out = words.slice(start, end).map((w) => {
    if (!hit(w)) return w;
    const m = w.match(/^(\W*)(.*?)(\W*)$/)!;
    return `${m[1]}<mark>${m[2]}</mark>${m[3]}`;
  });
  return (start > 0 ? '…' : '') + out.join(' ') + (end < words.length ? '…' : '');
}

export async function search(emp_id: string, q = '', folder = '', direction = '', today: Date = new Date(), limit = 30) {
  const all = await store.all<Comm>('comms', 'emp_id', emp_id);
  const f: Query = q ? parseQuery(q, today) : { terms: [] };
  if (direction) f.direction = direction;
  // "to Pune" is a place, not a person: a name only filters if it is one of the user's correspondents
  for (const k of ['to', 'from'] as const) {
    const name = f[k];
    if (name && !all.some((r) => (k === 'to' ? `${r.recipients} ${r.cc}` : r.sender).toLowerCase().includes(name))) {
      f.terms.push(...name.split(/\s+/));
      delete f[k];
    }
  }
  // "letters" is what people call any communication: letters come first, but notes and e-mails count too
  const softType = f.type === 'Letter';
  let dated = true;
  const passes = (r: Comm) => {
    if (folder && FOLDER_NAMES.includes(folder) && r.folder !== folder) return false;
    if (f.direction && r.direction !== f.direction) return false;
    if (f.type && !softType && r.type !== f.type) return false;
    if (f.to && !`${r.recipients} ${r.cc}`.toLowerCase().includes(f.to)) return false;
    if (f.from && !r.sender.toLowerCase().includes(f.from)) return false;
    if (dated && f.after && r.date < f.after) return false;
    if (dated && f.before && r.date > f.before) return false;
    return true;
  };
  const terms = f.terms.map((t) => t.replace(/[^\w-]/g, '')).filter(Boolean);
  // names as whole words: "Priya" is not "Priyanka"
  const nameRx = (['to', 'from'] as const).filter((k) => f[k]).map((k) => [k, new RegExp(`\\b${escRx(f[k]!)}\\b`, 'i')] as const);
  const toRx = nameRx.find(([k]) => k === 'to')?.[1];
  const byDate = (a: Comm, b: Comm) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

  const run = (mode: 'and' | 'or' | null) => {
    let scored: { r: Comm; score: number }[] = [];
    for (const r of all) {
      if (!passes(r)) continue;
      if (!mode) { scored.push({ r, score: 0 }); continue; }
      const ix = indexRow(r);
      const per = terms.map((t) => termScore(ix, t));
      if (mode === 'and' ? per.every((s) => s > 0) : per.some((s) => s > 0)) scored.push({ r, score: per.reduce((a, b) => a + b, 0) });
    }
    scored.sort((a, b) => b.score - a.score || byDate(a.r, b.r));
    for (const [k, rx] of nameRx) scored = scored.filter(({ r }) => rx.test(k === 'from' ? r.sender : `${r.recipients} ${r.cc}`));
    // sent to them directly before only copied to them; then letters before other kinds (stable: keeps relevance)
    const key = (r: Comm) => (toRx && !toRx.test(r.recipients) ? 2 : 0) + (softType && r.type !== 'Letter' ? 1 : 0);
    scored.sort((a, b) => key(a.r) - key(b.r));
    return scored.slice(0, limit).map((x) => x.r);
  };

  let rows: Comm[];
  let mode = 'all words';
  if (terms.length) {
    rows = run('and');
    if (!rows.length) { rows = run('or'); mode = 'any word'; }   // be forgiving: any of the words
  } else rows = run(null);
  let relaxed: string | null = null;
  if (!rows.length && (f.after || f.before)) {
    // nothing in that period: show the same search on any date, and say so
    dated = false;
    rows = terms.length ? run('or') : run(null);
    relaxed = 'dates';
  }
  const results = rows.map((r) => ({ ...r, snip: snippet(r.body, terms) || (r.body || '').slice(0, 140), score: 0 }));
  const folders: Record<string, number> = Object.fromEntries(FOLDER_NAMES.map((n) => [n, 0]));
  let sent = 0, received = 0;
  for (const r of all) {
    folders[r.folder] = (folders[r.folder] || 0) + 1;
    if (r.direction === 'sent') sent++;
    else if (r.direction === 'received') received++;
  }
  return { query: f, match: mode, relaxed, results, folders, sent, received };
}

/** A chat message that is a search of the user's communications rather than a task to do. */
export function looksLikeSearch(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return /^\s*(find|search|show|look up|where is|list|which)\b/.test(p) &&
    /\b(letters?|notes?|circulars?|e-?mails?|mails?|memos?|communications?|sent|received)\b/.test(p);
}
