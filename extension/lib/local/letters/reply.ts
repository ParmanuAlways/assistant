// Replies in service format, for the option the user picks. The wording of each option (OPTIONS), our letterhead
// (OUR_OFFICE) and the layout (draftReply) are plain templates: put your office's own format in here.
import { addDays, type Fields, type ISODate, MONTHS } from './read';

/** The user's own office, used in the replies */
export const OUR_OFFICE = { parent: 'Ministry of Commerce & Industry', office: 'Department of Industrial Development',
  address: 'Udyog Bhawan, New Delhi - 110011', short: 'IDD', tel: '011-2306 1042' };

// Options per kind of letter: [id, label, what the reply says]. {notes|default} is what the user typed (or the
// default); {ext} is two weeks from today. The first option is the usual one. An empty text means no letter is needed.
export const OPTIONS: Record<string, [string, string, string][]> = {
  info_request: [
    ["provide", "Send the information", "the requisite information is furnished below.\n{notes|The information in the prescribed proforma is enclosed.}"],
    ["nil", "Information is NIL", "the information in respect of this Department is NIL."],
    ["time", "Ask for more time", "the information is being compiled from the divisions concerned. It is requested that the time limit may kindly be extended up to {ext}."],
    ["transfer", "Not our subject - transfer", "the subject matter does not pertain to this Department. The reference is being transferred to the Department concerned for necessary action, under intimation to you."],
    ["clarify", "Ask for clarification", "certain points require clarification before the information can be furnished, namely, {notes|the scope and period of the information sought}. Clarification may kindly be provided."],
  ],
  comments_draft: [
    ["agree", "No comments (agree)", "this Department has no comments to offer on the draft and concurs with the proposal."],
    ["comments", "Send comments", "the comments of this Department are as follows:\n{notes|[comments to be added]}"],
    ["diplomatic_no", "Disagree diplomatically", "while this Department appreciates the objectives of the proposal, it is felt that the draft may be re-examined, particularly {notes|in respect of its financial and administrative implications}, before it is finalised. This Department would be glad to discuss the matter further."],
    ["time", "Ask for more time", "the draft is under examination in consultation with the divisions concerned. It is requested that the time for furnishing comments may kindly be extended up to {ext}."],
  ],
  meeting: [
    ["attend", "Confirm attendance", "{notes|the undersigned} will attend the meeting on behalf of this Department."],
    ["depute", "Depute another officer", "{notes|Shri/Smt. [name], [designation]} will represent this Department in the meeting."],
    ["regret", "Regret - can't attend (diplomatically)", "owing to prior official engagements, it may not be possible for this Department to be represented in the meeting. It is requested that the Department may kindly be excused, and the minutes may be shared. This Department will extend full cooperation in the matter."],
    ["reschedule", "Request another date", "owing to prior commitments on the proposed date, it is requested that the meeting may kindly be rescheduled, if possible, to {notes|a convenient date in the following week}."],
  ],
  nomination: [
    ["nominate", "Nominate an officer", "{notes|Shri/Smt. [name], [designation]} is nominated for the purpose. The particulars of the officer are enclosed."],
    ["regret", "Regret - no officer can be spared", "owing to acute shortage of officers and pressing work, this Department regrets its inability to spare an officer on this occasion. Nominations will be considered favourably in future."],
    ["time", "Ask for more time", "the nomination is under consideration and will be communicated by {ext}."],
  ],
  atr_compliance: [
    ["send", "Send the Action Taken Report", "the Action Taken Report is furnished below.\n{notes|The Action Taken Report is enclosed.}"],
    ["complied", "Report compliance", "the instructions have been complied with by this Department {notes|and all divisions have been informed}."],
    ["time", "Ask for more time", "the action on the decisions is in progress. The Action Taken Report will be furnished by {ext}."],
  ],
  parliament: [
    ["material", "Send material for the reply", "the material for the reply, duly approved by the competent authority, is furnished below.\n{notes|[material to be added]}"],
    ["transfer", "Not our subject - transfer", "the subject matter of the Question does not pertain to this Department. It is requested that the Question may kindly be transferred to the Ministry/Department concerned."],
    ["partial", "Part of it concerns us", "the material in respect of the part of the Question pertaining to this Department is furnished below. The remaining part may be obtained from the Ministry/Department concerned.\n{notes|[material to be added]}"],
  ],
  rti: [
    ["furnish", "Information will be given to the applicant", "the information sought by the applicant is being furnished directly to the applicant within the time limit prescribed under the RTI Act, 2005."],
    ["not_held", "Information not held - return", "the information sought is not held by this public authority. The application is therefore returned for appropriate action under Section 6(3) of the RTI Act, 2005."],
    ["transfer", "Transfer to another authority", "the information sought pertains to {notes|another public authority}, to which the application is being transferred under Section 6(3) of the RTI Act, 2005, under intimation to the applicant."],
  ],
  audit_para: [
    ["reply", "Send reply to the audit observations", "the reply of this Department to the audit observations is as follows:\n{notes|[reply on facts to be added]}"],
    ["accept", "Accept and inform corrective action", "the observations have been noted and corrective action has been taken, namely, {notes|[action taken]}. It is requested that the para may kindly be dropped."],
    ["time", "Ask for more time", "the records are being examined and the reply will be furnished by {ext}. It is requested that the para may not be finalised in the meantime."],
  ],
  grievance: [
    ["redressed", "Grievance redressed - inform", "the grievance has been examined and redressed, namely, {notes|[action taken]}. The grievance has been disposed of on the portal."],
    ["not_tenable", "Not tenable - explain diplomatically", "the grievance has been examined carefully. It is regretted that the request cannot be acceded to under the extant rules, {notes|as the matter is governed by the applicable guidelines}. The petitioner has been informed accordingly."],
    ["transfer", "Not our subject - transfer", "the grievance does not pertain to this Department and is being transferred on the portal to the authority concerned."],
  ],
  reminder: [
    ["send_now", "Send the pending reply now", "the reply to your earlier communication is furnished below.\n{notes|[reply to be added]}\nThe delay is regretted."],
    ["extension", "Regret delay and ask for time", "the delay in replying is regretted. The matter is under active consideration and the reply will be sent by {ext}."],
    ["already", "Reply already sent", "a reply has already been sent vide this Department's {notes|letter No. [number] dated [date]}. A copy is enclosed for ready reference."],
  ],
  sanction_info: [
    ["none", "No reply needed (file it)", ""],
    ["acknowledge", "Acknowledge receipt", "the receipt of the above communication is acknowledged with thanks. Necessary action is being taken."],
  ],
  circular_info: [
    ["none", "No reply needed (file it)", ""],
    ["circulated", "Confirm it was circulated", "the instructions have been noted and circulated to all divisions of this Department for compliance."],
  ],
  invitation_event: [
    ["accept", "Accept", "{notes|I} will be happy to attend the event. I thank you for the kind invitation."],
    ["decline", "Decline politely", "owing to prior commitments, I regret my inability to attend the event. I convey my best wishes for its success."],
    ["represent", "Send a representative", "owing to prior commitments, I may not be able to attend. {notes|A senior officer} will represent the Department. I convey my best wishes for the success of the event."],
  ],
  vigilance_clearance: [
    ["clear", "Give vigilance clearance", "no vigilance case is pending or contemplated against {notes|the officer}, and vigilance clearance is accorded. The APARs are enclosed."],
    ["pending", "Can't clear now (diplomatically)", "a matter in respect of {notes|the officer} is under examination. The vigilance status will be intimated on its conclusion."],
    ["time", "Ask for more time", "the vigilance status is being ascertained and will be communicated by {ext}."],
  ],
  budget_request: [
    ["send", "Send the requirement", "the requirement of this Department is as follows:\n{notes|[figures to be added]}"],
    ["nil", "No additional requirement", "this Department has no additional requirement of funds under the head at present."],
    ["time", "Ask for more time", "the estimates are being compiled and will be furnished by {ext}."],
  ],
  deputation_noc: [
    ["grant", "Grant NOC", "this Department has no objection to the deputation of {notes|the officer}. The vigilance clearance and APARs are enclosed."],
    ["decline", "Decline diplomatically", "in view of exigencies of work and shortage of officers at this level, it may not be possible to relieve {notes|the officer} at present. The request may kindly be considered at a later stage."],
    ["details", "Ask for details", "the terms of deputation, including {notes|the pay level and tenure}, may kindly be intimated to enable this Department to process the request."],
  ],
};

export interface Option { id: string; label: string; recommended: boolean; letter: boolean }

export function optionsFor(intent: string): Option[] {
  return OPTIONS[intent].map(([id, label, text], k) => ({ id, label, recommended: k === 0, letter: !!text }));
}

function fill(text: string, notes: string, ext: string): string {
  const n = notes.trim();
  return text.replace(/\{notes\|([^}]*)\}/g, (_, def) => (n ? n : def)).replaceAll('{notes}', n).replaceAll('{ext}', ext);
}

export function salutation(name: string): string {
  name = (name || '').trim();
  const last = name.split(/\s+/).pop();
  for (const title of ['Dr.', 'Smt.', 'Shri', 'Ms.', 'Mr.']) if (name.startsWith(title)) return `Dear ${title} ${last},`;
  return name ? `Dear Shri ${last},` : 'Dear Sir/Madam,';
}

/** "17.09.2026", or with long=true "17th September, 2026" */
export function fmtDate(iso?: ISODate | null, long = false): string {
  if (!iso) return '[date]';
  const [y, m, d] = iso.split('-').map(Number);
  if (long) {
    const suf = d % 100 >= 11 && d % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[d % 10] || 'th';
    return `${d}${suf} ${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)}, ${y}`;
  }
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
}

/** One line of the reply: c centre, cb centre bold, r right, b bold, p paragraph, l line */
export type Line = [string, string];

export interface Me { name?: string; designation?: string }

/** The reply as lines in service format, answering a Letter with a letter, an OM with an OM, a D.O. with a D.O. */
export function draftReply(f: Fields, intent: string, option: string, notes: string, me: Me, today: ISODate, ourFileNo: string) {
  const opt = OPTIONS[intent].find((o) => o[0] === option)!;
  const body = fill(opt[2], notes, fmtDate(addDays(today, 14)));
  const [first, ...rest] = body.split('\n');
  const theirs = f.format || 'Letter';
  const kind = ['Office Memorandum', 'Notice', 'Circular', 'Office Order'].includes(theirs) ? 'OM' : theirs === 'D.O. letter' ? 'DO' : 'Letter';
  const refWord = { OM: 'O.M.', DO: 'D.O. letter', Letter: 'letter' }[kind];
  const ref = `${refWord} No. ${f.file_no ?? '[number]'} dated ${fmtDate(f.date)}`;
  const name = me.name ?? '[Name]', desig = me.designation ?? 'Deputy Secretary';
  const L: Line[] = [];
  if (kind === 'DO') L.push(['b', name], ['l', desig], ['r', `D.O. No. ${ourFileNo}`]);
  else L.push(['r', `F.No. ${ourFileNo}`]);
  L.push(['cb', 'Government of India'], ['cb', OUR_OFFICE.parent], ['c', OUR_OFFICE.office], ['c', OUR_OFFICE.address],
    ['r', `Dated the ${fmtDate(today, true)}`]);
  // official letters go to the post ("The Director (Training)"); a D.O. reply goes to the person by name
  const who = kind === 'DO' ? [f.signatory, f.designation] : [f.designation ? `The ${f.designation}` : ''];
  const toBlock = [...who, f.sender_office, f.sender_parent, f.sender_address].filter((x): x is string => !!x);
  if (kind === 'OM') L.push(['cb', 'OFFICE MEMORANDUM']);
  if (kind === 'Letter') L.push(['l', 'To,'], ...toBlock.map((x, i): Line => ['l', '    ' + x + (i < toBlock.length - 1 ? ',' : '.')]));
  if (kind === 'DO') L.push(['l', salutation(f.signatory || '')]);
  L.push(['b', `Subject: ${f.subject ?? ''}.`]);
  if (kind === 'Letter') L.push(['l', 'Sir/Madam,']);
  const subj = f.subject ?? 'the above subject';
  const lead = {
    Letter: `I am directed to refer to your ${ref} on the subject cited above and to say that ${first}`,
    OM: `The undersigned is directed to refer to the ${ref} on the subject mentioned above and to say that ${first}`,
    DO: `Please refer to your ${ref} regarding ${subj.slice(0, 1).toLowerCase()}${(f.subject ?? '').slice(1)}. ${first.slice(0, 1).toUpperCase()}${first.slice(1)}`,
  }[kind];
  const paras = [lead, ...rest.filter((r) => r.trim())];
  if (kind !== 'DO') paras.push('This issues with the approval of the competent authority.');
  paras.forEach((p, i) => L.push(['p', (i ? `${i + 1}.  ` : '') + p]));
  if (kind === 'DO') {
    L.push(['l', 'With regards,'], ['r', 'Yours sincerely,'], ['r', `(${name})`], ...toBlock.map((x): Line => ['l', x]));
  } else {
    if (kind === 'Letter') L.push(['r', 'Yours faithfully,']);
    L.push(['r', `(${name})`], ['r', `${desig} to the Government of India`], ['r', `Tel: ${OUR_OFFICE.tel}`]);
    if (kind === 'OM') L.push(['l', 'To'], ['l', '    ' + toBlock.join(', ')]);
  }
  return { lines: L, kind, text: linesToText(L) };
}

/** Python's str.center */
function center(s: string, width: number): string {
  const marg = width - s.length;
  if (marg <= 0) return s;
  const left = Math.floor(marg / 2) + (marg & width & 1);
  return ' '.repeat(left) + s + ' '.repeat(marg - left);
}

export function linesToText(L: Line[]): string {
  const out: string[] = [];
  for (const [style, t] of L) {
    if (style === 'c' || style === 'cb') out.push(center(t, 72).trimEnd());
    else if (style === 'r') out.push(t.padStart(72));
    else if (style === 'p') out.push('', '        ' + t);
    else if (style === 'b') out.push('', t);
    else out.push(t);
  }
  return out.join('\n');
}

/** Put reworded paragraphs (from the model) back into the reply, keeping the numbering and everything else. */
export function applyParas(L: Line[], paras: string[]): Line[] {
  const old = L.map((x, i) => (x[0] === 'p' ? i : -1)).filter((i) => i >= 0);
  if (!paras?.length || paras.length !== old.length) return L;
  const out = L.slice();
  old.forEach((i, k) => {
    const p = String(paras[k]).trim().replace(/^\d+\.\s*/, '');
    out[i] = ['p', (k ? `${k + 1}.  ` : '') + p];
  });
  return out;
}

export const AI_PROMPT = `You improve the wording of a draft reply from a Government of India office. Keep the meaning, every fact,
number, name and date exactly; do not add facts. Use formal official English (noting and drafting style), short
paragraphs. Reply with ONE JSON object: {"paras": ["first paragraph", "second paragraph", ...]}`;
export const AI_SCHEMA = { type: 'object', additionalProperties: false, required: ['paras'],
  properties: { paras: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 900 } } } };
