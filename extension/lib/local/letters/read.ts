// Government correspondence (e-Office receipts): read the letter, work out who it is from, what it asks for and
// when the reply is due, and where to file it (a folder per correspondent).
// Rules, not AI: instant, offline and predictable.

/** A date as YYYY-MM-DD */
export type ISODate = string;

export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON3 = MONTHS.map((m) => m.slice(0, 3));
const WORDNUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fifteen: 15, thirty: 30, a: 1 };

export function isoOf(y: number, m: number, d: number): ISODate | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export function addDays(iso: ISODate, n: number): ISODate {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** "17.09.2026", "17/09/2026", "7th September, 2026" */
export function parseDate(s: string): ISODate | null {
  s = s.trim().toLowerCase();
  let m = s.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (m) return isoOf(+m[3], +m[2], +m[1]);
  m = s.match(new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON3.join('|')})[a-z]*,?\\s+(\\d{4})`));
  if (m) return isoOf(+m[3], MON3.indexOf(m[2]) + 1, +m[1]);
  return null;
}

const ORG = /\b(ministry|department|government|secretariat|commission|office of|aayog|institute|division|section|branch|directorate|board|authority|council|cell|wing|unit)\b/i;
const FORMATS: [string, string][] = [['OFFICE MEMORANDUM', 'Office Memorandum'], ['OFFICE ORDER', 'Office Order'], ['CIRCULAR', 'Circular'],
  ['NOTICE', 'Notice'], ['REMINDER', 'Reminder']];

export interface Fields {
  format: string;
  file_no?: string;
  date?: ISODate;
  subject?: string;
  sender_parent?: string;
  sender_office?: string;
  sender_address?: string;
  signatory?: string;
  designation?: string;
  body?: string;
  reference?: string;
  deadline?: ISODate | null;
  event_date?: ISODate;
  intent_why?: string;
  asks?: string;
}

/** The parts of a service-format letter: file no., date, sender, signatory, subject, body, references, deadline. */
export function parse(text: string, today: ISODate): Fields {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.toUpperCase().startsWith('DUMMY'));
  const joined = lines.join('\n');
  const f: Fields = { format: 'Letter' };
  if (/\bD\.\s?O\.\s*(No|Letter)/i.test(joined)) f.format = 'D.O. letter';
  for (const [marker, fmt] of FORMATS) {
    if (lines.slice(0, 25).some((l) => l.toUpperCase() === marker)) {
      f.format = fmt;
      break;
    }
  }
  // file number: a short line near the top with slashes (F.No. 7(2)/E.Coord-I/12/2026, LSS/Q/2026/..)
  for (const l of lines.slice(0, 10)) {
    const m = l.match(/^(?:D\.?\s?O\.?\s*No\.?|F\.?\s*No\.?|No\.?)\s*[:.]?\s*(.+)$/i);
    const cand = (m ? m[1] : l).trim();
    if ((cand.match(/\//g) || []).length >= 2 && cand.split(/\s+/).length <= 4) {
      f.file_no = cand;
      break;
    }
  }
  // date of the letter
  for (const l of lines.slice(0, 25)) {
    if (/^dated?\b/i.test(l) || /^date\s*[:-]/i.test(l)) {
      const d = parseDate(l);
      if (d) {
        f.date = d;
        break;
      }
    }
  }
  // subject (may wrap over lines)
  const subjI = lines.findIndex((l) => /^(subject|sub)\s*[:.-]/i.test(l));
  let bodyStart = 0;
  if (subjI >= 0) {
    let subj = lines[subjI].replace(/^(subject|sub)\s*[:.-]\s*/i, '');
    let j = subjI + 1;
    while (!subj.endsWith('.') && j < lines.length && !/^(sir|madam|dear|the undersigned|i am|\d{1,2}\.\s)/i.test(lines[j]) && subj.length < 300) {
      subj += ' ' + lines[j];
      j++;
    }
    f.subject = subj.replace(/\.+$/, '').trim();
    bodyStart = j;
  }
  // sender: the letterhead above the date
  const head: string[] = [];
  for (const l of lines.slice(0, 25)) {
    if (/^dated?\b|^subject|^to,?$/i.test(l)) break;
    head.push(l);
  }
  // the letterhead: "Government of India" / Ministry / Department or office / address with PIN
  const gi = head.findIndex((l) => /^government of\b/i.test(l));
  let orgs: string[];
  if (gi >= 0) {
    const block: string[] = [];
    for (const l of head.slice(gi + 1)) {
      if (/\b\d{6}\b/.test(l) || l.includes('/')) break;
      block.push(l);
    }
    // a State Government is itself the correspondent: "Government of Maharashtra" / its department
    orgs = head[gi].toLowerCase() === 'government of india' ? block : [head[gi], ...block];
  } else {
    orgs = head.filter((l) => ORG.test(l) && !l.includes('/') && !l.toLowerCase().includes('government of'));
  }
  f.sender_parent = orgs[0] || '';
  f.sender_office = orgs[1] || '';
  f.sender_address = head.find((l) => /\b\d{6}\b/.test(l)) || '';
  // signatory: "(Name)" then designation
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\(([A-Z][^()]{2,60})\)$/);
    if (m) {
      f.signatory = m[1];
      const nxt = lines[i + 1] || '';
      if (nxt && !/^(tel|to|copy|shri|smt)/i.test(nxt)) f.designation = nxt;
      break;
    }
  }
  if (f.format === 'D.O. letter' && !f.designation && head.length > 1) {
    f.signatory = f.signatory || head[0];
    f.designation = head[1];
  }
  // body: from the subject to the closing
  let end = lines.findIndex((l, i) => i > bodyStart && /^(yours (faithfully|sincerely)|with regards|\([A-Z])/i.test(l));
  if (end < 0) end = lines.length;
  let body = lines.slice(bodyStart, end).join(' ');
  body = body.replace(/^(sir\/madam|sir|madam|dear [^,]+),\s*/i, '');
  f.body = body.replace(/\s+/g, ' ').trim();
  let m = f.body.match(/(?:letter|om|o\.m\.|d\.o\.)[^.]{0,30}?(?:of even number|no\.\s*\S+)\s+dated\s+([^.,;]+\d{4})/i);
  if (m) f.reference = m[0];
  f.deadline = deadline(f.body, f.date || today);
  m = f.body.match(/(?:held|scheduled)\s+(?:under [^.]*?\s)?on\s+([0-9]{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4}|\d{1,2}\.\d{1,2}\.\d{4})/i);
  if (m) {
    const d = parseDate(m[1]);
    if (d) f.event_date = d;
  }
  return f;
}

/** When a reply is due: "by 30.10.2026", "latest by …", "within 15 days", "within six weeks", "within a fortnight". */
export function deadline(body: string, letterDate: ISODate): ISODate | null {
  const b = body.toLowerCase();
  for (const m of b.matchAll(/(?:latest by|by|before|on or before|not later than)\s+([0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{4}|[0-9]{1,2}(?:st|nd|rd|th)?\s+[a-z]+,?\s+[0-9]{4})/g)) {
    const d = parseDate(m[1]);
    if (d) return d;
  }
  const m = b.match(/within\s+(\d+|[a-z]+)\s+(working\s+)?(day|days|week|weeks)/);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? +m[1] : WORDNUM[m[1]];
    if (n) return addDays(letterDate, n * (m[3].includes('week') ? 7 : 1));
  }
  if (b.includes('time limit prescribed') && b.includes('right to information')) return addDays(letterDate, 30);   // RTI transfer: 30 days (Section 7(1))
  if (b.includes('fortnight')) return addDays(letterDate, 14);
  if (/most immediate|immediately|at the earliest/.test(b)) return addDays(letterDate, 3);
  return null;
}

// What the letter asks for. Checked in this order: the first that matches wins (a reminder about information is a
// reminder; a deputation request that also mentions vigilance clearance is about deputation).
export const INTENT_RULES: [string, RegExp][] = [
  ['parliament', /lok sabha|rajya sabha|parliament (question|matter)|starred question|unstarred question/],
  ['rti', /right to information|rti act|section 6\(3\)/],
  ['audit_para', /audit para|draft para|draft paragraph|audit observation|observations were made/],
  ['grievance', /grievance|cpgrams/],
  ['reminder', /\breminder\b|still awaited|attention is invited to this/],
  ['deputation_noc', /no objection certificate|\bnoc\b|on deputation|deputation basis/],
  ['vigilance_clearance', /vigilance clearance|vigilance status/],
  ['budget_request', /revised estimates|budget estimates|additional funds|requirement of funds/],
  ['sanction_info', /sanction of the president|grants-in-aid|competent authority has approved|convey the sanction/],
  ['invitation_event', /conference|workshop|grace the occasion|keynote|chief guest|inaugural/],
  ['atr_compliance', /action taken report|compliance report|\batr\b/],
  ['meeting', /meeting (to review|on|will be held|is scheduled)|make it convenient to attend|confirm participation|video conferencing/],
  ['nomination', /\bnominat(e|ion|ions)\b/],
  ['comments_draft', /\bcomments\b|views of the|draft (guidelines|cabinet note|amendment|policy|rules)|inter-ministerial consultation/],
  ['circular_info', /for information and (strict )?compliance|wide circulation|come into force|will be observed|for information and necessary/],
  ['info_request', /furnish|information|\bdata\b|send the details|proforma|details of/],
];

export const INTENT_LABELS: Record<string, string> = {
  parliament: 'Parliament Question - material for reply', rti: 'RTI application', audit_para: 'Audit para / observations',
  grievance: 'Public grievance (CPGRAMS)', reminder: 'Reminder - earlier reference still pending',
  deputation_noc: 'NOC for deputation', vigilance_clearance: 'Vigilance clearance', budget_request: 'Budget / funds requirement',
  sanction_info: 'Sanction / approval (for information)', invitation_event: 'Invitation to an event', meeting: 'Meeting',
  nomination: 'Nomination of an officer', comments_draft: 'Comments on a draft', atr_compliance: 'Action Taken / compliance report',
  circular_info: 'Circular (for information)', info_request: 'Request for information',
};

export function classify(f: Fields): [string, string] {
  const text = `${f.subject || ''} ${f.body || ''}`.toLowerCase();
  for (const [intent, rx] of INTENT_RULES) {
    const m = text.match(rx);
    if (m) return [intent, m[0]];
  }
  return ['info_request', ''];
}

// ---------------------------------------------------------------- filing

function clean(s: string, n: number): string {
  s = s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').replace(/^[ .-]+|[ .-]+$/g, '');
  return s.slice(0, n).replace(/[ .-]+$/, '');
}

/** Folder per correspondent: "Ministry of Finance - Department of Expenditure". */
export function correspondent(f: Fields): string {
  const parent = f.sender_parent || '', office = f.sender_office || '';
  const name = parent && office && !parent.toLowerCase().includes(office.toLowerCase()) ? `${parent} - ${office}` : parent || office || 'Unknown sender';
  return clean(name, 90);
}

/** "2026-10-12 - OM - Subject - File No.pdf" */
export function fileName(f: Fields): string {
  const kind = ({ 'Office Memorandum': 'OM', 'D.O. letter': 'DO', 'Office Order': 'Office Order' } as Record<string, string>)[f.format] || f.format || 'Letter';
  const parts = [f.date || 'undated', kind, clean(f.subject || 'No subject', 80)];
  if (f.file_no) parts.push(clean(f.file_no.replace(/\//g, '-'), 40));
  return parts.join(' - ') + '.pdf';
}

const ASK_WORDS = /(requested|may (kindly|please)|is required|furnish|attend|nominat|replied|disposed|comments|views|confirm|forwarded|intimated|clearance|no objection)/i;

/** The sentence of the letter that says what is wanted. */
export function asks(f: Fields): string {
  const sents = (f.body || '').split(/(?<=[.])\s+(?=[A-Z0-9])/);
  const hit = sents.filter((s) => ASK_WORDS.test(s));
  const s = (hit.length ? hit[hit.length - 1] : sents[0] || '').trim();
  return s.replace(/^\d+\.\s*/, '').slice(0, 400);
}
