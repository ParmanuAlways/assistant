"""Government correspondence (e-Office receipts): read the PDF, work out who it is from and what it asks for, file it
in a folder per correspondent, and draft a reply in service format for the option the user picks.

Reading and drafting are rules and templates (instant, offline, predictable); the local model is optional, for
nicer wording of a draft. The reply format lives in REPLY_FORMATS so an office can put its own in.
"""
import io
import json
import re
from datetime import date, timedelta

SCHEMA = """
CREATE TABLE IF NOT EXISTS letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id TEXT, sha256 TEXT, source TEXT, source_url TEXT, original_name TEXT,
  fields TEXT, intent TEXT, deadline TEXT, folder TEXT, file_name TEXT, status TEXT DEFAULT 'new', draft TEXT,
  created_at TEXT, UNIQUE (emp_id, sha256));
"""

# The user's own office, used in the replies (from the user's profile where available)
OUR_OFFICE = {"parent": "Ministry of Commerce & Industry", "office": "Department of Industrial Development",
              "address": "Udyog Bhawan, New Delhi - 110011", "short": "IDD", "tel": "011-2306 1042"}

MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
WORDNUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "ten": 10, "fifteen": 15, "thirty": 30, "a": 1}


# ---------------------------------------------------------------- reading

def pdf_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader
        return "\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(data)).pages)
    except Exception:
        from pdfminer.high_level import extract_text
        return extract_text(io.BytesIO(data))


def _date(s: str):
    s = s.strip().lower()
    if m := re.search(r"(\d{1,2})[./-](\d{1,2})[./-](\d{4})", s):
        d, mth, y = map(int, m.groups())
        try:
            return date(y, mth, d)
        except ValueError:
            return None
    if m := re.search(r"(\d{1,2})(?:st|nd|rd|th)?\s+(" + "|".join(x[:3] for x in MONTHS) + r")[a-z]*,?\s+(\d{4})", s):
        return date(int(m.group(3)), [x[:3] for x in MONTHS].index(m.group(2)) + 1, int(m.group(1)))
    return None


ORG = re.compile(r"\b(ministry|department|government|secretariat|commission|office of|aayog|institute|division|section|branch|"
                 r"directorate|board|authority|council|cell|wing|unit)\b", re.I)
FORMATS = [("OFFICE MEMORANDUM", "Office Memorandum"), ("OFFICE ORDER", "Office Order"), ("CIRCULAR", "Circular"),
           ("NOTICE", "Notice"), ("REMINDER", "Reminder")]


def parse(text: str, today: date | None = None) -> dict:
    """The parts of a service-format letter: file no., date, sender, signatory, subject, body, references, deadline."""
    today = today or date.today()
    lines = [l.strip() for l in text.splitlines() if l.strip() and not l.strip().upper().startswith("DUMMY")]
    joined = "\n".join(lines)
    f = {"format": "Letter"}
    if re.search(r"\bD\.\s?O\.\s*(No|Letter)", joined, re.I):
        f["format"] = "D.O. letter"
    for marker, fmt in FORMATS:
        if any(l.upper() == marker for l in lines[:25]):
            f["format"] = fmt
            break
    # file number: a short line near the top with slashes (F.No. 7(2)/E.Coord-I/12/2026, LSS/Q/2026/..)
    for l in lines[:10]:
        m = re.match(r"^(?:D\.?\s?O\.?\s*No\.?|F\.?\s*No\.?|No\.?)\s*[:.]?\s*(.+)$", l, re.I)
        cand = (m.group(1) if m else l).strip()
        if cand.count("/") >= 2 and len(cand.split()) <= 4:
            f["file_no"] = cand
            break
    # date of the letter
    for l in lines[:25]:
        if re.match(r"^dated?\b", l, re.I) or re.match(r"^date\s*[:\-]", l, re.I):
            if d := _date(l):
                f["date"] = d.isoformat()
                break
    # subject (may wrap over lines)
    subj_i = next((i for i, l in enumerate(lines) if re.match(r"^(subject|sub)\s*[:.\-]", l, re.I)), None)
    if subj_i is not None:
        subj = re.sub(r"^(subject|sub)\s*[:.\-]\s*", "", lines[subj_i], flags=re.I)
        j = subj_i + 1
        while not subj.endswith(".") and j < len(lines) and not re.match(r"^(sir|madam|dear|the undersigned|i am|\d{1,2}\.\s)", lines[j], re.I) \
                and len(subj) < 300:
            subj += " " + lines[j]
            j += 1
        f["subject"] = subj.rstrip(".").strip()
        body_start = j
    else:
        body_start = 0
    # sender: organisation lines above the date (skip "Government of India", the person's name in a D.O.)
    head = []
    for l in lines[:25]:
        if re.match(r"^dated?\b|^subject|^to,?$", l, re.I):
            break
        head.append(l)
    # the letterhead: "Government of India" / Ministry / Department or office / address with PIN
    gi = next((i for i, l in enumerate(head) if re.match(r"^government of\b", l, re.I)), None)
    if gi is not None:
        block = []
        for l in head[gi + 1:]:
            if re.search(r"\b\d{6}\b", l) or "/" in l:
                break
            block.append(l)
        # a State Government is itself the correspondent: "Government of Maharashtra" / its department
        orgs = block if head[gi].lower() == "government of india" else [head[gi]] + block
    else:
        orgs = [l for l in head if ORG.search(l) and "/" not in l and "government of" not in l.lower()]
    f["sender_parent"] = orgs[0] if orgs else ""
    f["sender_office"] = orgs[1] if len(orgs) > 1 else ""
    f["sender_address"] = next((l for l in head if re.search(r"\b\d{6}\b", l)), "")
    # signatory: "(Name)" then designation
    for i, l in enumerate(lines):
        if m := re.match(r"^\(([A-Z][^()]{2,60})\)$", l):
            f["signatory"] = m.group(1)
            nxt = lines[i + 1] if i + 1 < len(lines) else ""
            if nxt and not nxt.lower().startswith(("tel", "to", "copy", "shri", "smt")):
                f["designation"] = nxt
            break
    if f["format"] == "D.O. letter" and not f.get("designation") and len(head) > 1:
        f["signatory"], f["designation"] = f.get("signatory") or head[0], head[1]
    # body: from the subject to the closing
    end = next((i for i, l in enumerate(lines) if i > body_start and re.match(r"^(yours (faithfully|sincerely)|with regards|\([A-Z])", l, re.I)),
               len(lines))
    body = " ".join(lines[body_start:end])
    body = re.sub(r"^(sir/madam|sir|madam|dear [^,]+),\s*", "", body, flags=re.I)
    f["body"] = re.sub(r"\s+", " ", body).strip()
    if m := re.search(r"(?:letter|om|o\.m\.|d\.o\.)[^.]{0,30}?(?:of even number|no\.\s*\S+)\s+dated\s+([^.,;]+\d{4})", f["body"], re.I):
        f["reference"] = m.group(0)
    f["deadline"] = deadline(f["body"], date.fromisoformat(f["date"]) if f.get("date") else today)
    if m := re.search(r"(?:held|scheduled)\s+(?:under [^.]*?\s)?on\s+([0-9]{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4}|\d{1,2}\.\d{1,2}\.\d{4})", f["body"], re.I):
        if d := _date(m.group(1)):
            f["event_date"] = d.isoformat()
    return f


def deadline(body: str, letter_date: date):
    """When a reply is due: "by 30.10.2026", "latest by …", "within 15 days", "within six weeks", "within a fortnight"."""
    b = body.lower()
    for m in re.finditer(r"(?:latest by|by|before|on or before|not later than)\s+([0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{4}|"
                         r"[0-9]{1,2}(?:st|nd|rd|th)?\s+[a-z]+,?\s+[0-9]{4})", b):
        if d := _date(m.group(1)):
            return d.isoformat()
    if m := re.search(r"within\s+(\d+|[a-z]+)\s+(working\s+)?(day|days|week|weeks)", b):
        n = int(m.group(1)) if m.group(1).isdigit() else WORDNUM.get(m.group(1))
        if n:
            return (letter_date + timedelta(days=n * (7 if "week" in m.group(3) else 1))).isoformat()
    if "time limit prescribed" in b and "right to information" in b:   # RTI transfer: 30 days (Section 7(1))
        return (letter_date + timedelta(days=30)).isoformat()
    if "fortnight" in b:
        return (letter_date + timedelta(days=14)).isoformat()
    if re.search(r"most immediate|immediately|at the earliest", b):
        return (letter_date + timedelta(days=3)).isoformat()
    return None


# What the letter asks for. Checked in this order: the first that matches wins (a reminder about information is a
# reminder; a deputation request that also mentions vigilance clearance is about deputation).
INTENT_RULES = [
    ("parliament", r"lok sabha|rajya sabha|parliament (question|matter)|starred question|unstarred question"),
    ("rti", r"right to information|rti act|section 6\(3\)"),
    ("audit_para", r"audit para|draft para|draft paragraph|audit observation|observations were made"),
    ("grievance", r"grievance|cpgrams"),
    ("reminder", r"\breminder\b|still awaited|attention is invited to this"),
    ("deputation_noc", r"no objection certificate|\bnoc\b|on deputation|deputation basis"),
    ("vigilance_clearance", r"vigilance clearance|vigilance status"),
    ("budget_request", r"revised estimates|budget estimates|additional funds|requirement of funds"),
    ("sanction_info", r"sanction of the president|grants-in-aid|competent authority has approved|convey the sanction"),
    ("invitation_event", r"conference|workshop|grace the occasion|keynote|chief guest|inaugural"),
    ("atr_compliance", r"action taken report|compliance report|\batr\b"),
    ("meeting", r"meeting (to review|on|will be held|is scheduled)|make it convenient to attend|confirm participation|video conferencing"),
    ("nomination", r"\bnominat(e|ion|ions)\b"),
    ("comments_draft", r"\bcomments\b|views of the|draft (guidelines|cabinet note|amendment|policy|rules)|inter-ministerial consultation"),
    ("circular_info", r"for information and (strict )?compliance|wide circulation|come into force|will be observed|for information and necessary"),
    ("info_request", r"furnish|information|\bdata\b|send the details|proforma|details of"),
]

INTENT_LABELS = {
    "parliament": "Parliament Question - material for reply", "rti": "RTI application", "audit_para": "Audit para / observations",
    "grievance": "Public grievance (CPGRAMS)", "reminder": "Reminder - earlier reference still pending",
    "deputation_noc": "NOC for deputation", "vigilance_clearance": "Vigilance clearance", "budget_request": "Budget / funds requirement",
    "sanction_info": "Sanction / approval (for information)", "invitation_event": "Invitation to an event", "meeting": "Meeting",
    "nomination": "Nomination of an officer", "comments_draft": "Comments on a draft", "atr_compliance": "Action Taken / compliance report",
    "circular_info": "Circular (for information)", "info_request": "Request for information",
}


def classify(f: dict) -> tuple[str, str]:
    text = f"{f.get('subject', '')} {f.get('body', '')}".lower()
    for intent, rx in INTENT_RULES:
        if m := re.search(rx, text):
            return intent, m.group(0)
    return "info_request", ""


# ---------------------------------------------------------------- filing

def _clean(s: str, n: int) -> str:
    s = re.sub(r'[\\/:*?"<>|]+', "-", s)
    s = re.sub(r"\s+", " ", s).strip(" .-")
    return s[:n].rstrip(" .-")


def correspondent(f: dict) -> str:
    """Folder per correspondent: "Ministry of Finance - Department of Expenditure"."""
    parent, office = f.get("sender_parent", ""), f.get("sender_office", "")
    name = f"{parent} - {office}" if parent and office and office.lower() not in parent.lower() else parent or office or "Unknown sender"
    return _clean(name, 90)


def file_name(f: dict) -> str:
    kind = {"Office Memorandum": "OM", "D.O. letter": "DO", "Office Order": "Office Order"}.get(f.get("format"), f.get("format", "Letter"))
    parts = [f.get("date") or "undated", kind, _clean(f.get("subject", "No subject"), 80)]
    if f.get("file_no"):
        parts.append(_clean(f["file_no"].replace("/", "-"), 40))
    return " - ".join(parts) + ".pdf"


# ---------------------------------------------------------------- replying

# Options per kind of letter: (id, label, what the reply says). {notes} is what the user typed; {ext} two weeks on.
# The first option is the usual one. "none" means no letter is needed.
OPTIONS = {
    "info_request": [
        ("provide", "Send the information", "the requisite information is furnished below.\n{notes|The information in the prescribed proforma is enclosed.}"),
        ("nil", "Information is NIL", "the information in respect of this Department is NIL."),
        ("time", "Ask for more time", "the information is being compiled from the divisions concerned. It is requested that the time limit may kindly be extended up to {ext}."),
        ("transfer", "Not our subject - transfer", "the subject matter does not pertain to this Department. The reference is being transferred to the Department concerned for necessary action, under intimation to you."),
        ("clarify", "Ask for clarification", "certain points require clarification before the information can be furnished, namely, {notes|the scope and period of the information sought}. Clarification may kindly be provided."),
    ],
    "comments_draft": [
        ("agree", "No comments (agree)", "this Department has no comments to offer on the draft and concurs with the proposal."),
        ("comments", "Send comments", "the comments of this Department are as follows:\n{notes|[comments to be added]}"),
        ("diplomatic_no", "Disagree diplomatically", "while this Department appreciates the objectives of the proposal, it is felt that the draft may be re-examined, particularly {notes|in respect of its financial and administrative implications}, before it is finalised. This Department would be glad to discuss the matter further."),
        ("time", "Ask for more time", "the draft is under examination in consultation with the divisions concerned. It is requested that the time for furnishing comments may kindly be extended up to {ext}."),
    ],
    "meeting": [
        ("attend", "Confirm attendance", "{notes|the undersigned} will attend the meeting on behalf of this Department."),
        ("depute", "Depute another officer", "{notes|Shri/Smt. [name], [designation]} will represent this Department in the meeting."),
        ("regret", "Regret - can't attend (diplomatically)", "owing to prior official engagements, it may not be possible for this Department to be represented in the meeting. It is requested that the Department may kindly be excused, and the minutes may be shared. This Department will extend full cooperation in the matter."),
        ("reschedule", "Request another date", "owing to prior commitments on the proposed date, it is requested that the meeting may kindly be rescheduled, if possible, to {notes|a convenient date in the following week}."),
    ],
    "nomination": [
        ("nominate", "Nominate an officer", "{notes|Shri/Smt. [name], [designation]} is nominated for the purpose. The particulars of the officer are enclosed."),
        ("regret", "Regret - no officer can be spared", "owing to acute shortage of officers and pressing work, this Department regrets its inability to spare an officer on this occasion. Nominations will be considered favourably in future."),
        ("time", "Ask for more time", "the nomination is under consideration and will be communicated by {ext}."),
    ],
    "atr_compliance": [
        ("send", "Send the Action Taken Report", "the Action Taken Report is furnished below.\n{notes|The Action Taken Report is enclosed.}"),
        ("complied", "Report compliance", "the instructions have been complied with by this Department {notes|and all divisions have been informed}."),
        ("time", "Ask for more time", "the action on the decisions is in progress. The Action Taken Report will be furnished by {ext}."),
    ],
    "parliament": [
        ("material", "Send material for the reply", "the material for the reply, duly approved by the competent authority, is furnished below.\n{notes|[material to be added]}"),
        ("transfer", "Not our subject - transfer", "the subject matter of the Question does not pertain to this Department. It is requested that the Question may kindly be transferred to the Ministry/Department concerned."),
        ("partial", "Part of it concerns us", "the material in respect of the part of the Question pertaining to this Department is furnished below. The remaining part may be obtained from the Ministry/Department concerned.\n{notes|[material to be added]}"),
    ],
    "rti": [
        ("furnish", "Information will be given to the applicant", "the information sought by the applicant is being furnished directly to the applicant within the time limit prescribed under the RTI Act, 2005."),
        ("not_held", "Information not held - return", "the information sought is not held by this public authority. The application is therefore returned for appropriate action under Section 6(3) of the RTI Act, 2005."),
        ("transfer", "Transfer to another authority", "the information sought pertains to {notes|another public authority}, to which the application is being transferred under Section 6(3) of the RTI Act, 2005, under intimation to the applicant."),
    ],
    "audit_para": [
        ("reply", "Send reply to the audit observations", "the reply of this Department to the audit observations is as follows:\n{notes|[reply on facts to be added]}"),
        ("accept", "Accept and inform corrective action", "the observations have been noted and corrective action has been taken, namely, {notes|[action taken]}. It is requested that the para may kindly be dropped."),
        ("time", "Ask for more time", "the records are being examined and the reply will be furnished by {ext}. It is requested that the para may not be finalised in the meantime."),
    ],
    "grievance": [
        ("redressed", "Grievance redressed - inform", "the grievance has been examined and redressed, namely, {notes|[action taken]}. The grievance has been disposed of on the portal."),
        ("not_tenable", "Not tenable - explain diplomatically", "the grievance has been examined carefully. It is regretted that the request cannot be acceded to under the extant rules, {notes|as the matter is governed by the applicable guidelines}. The petitioner has been informed accordingly."),
        ("transfer", "Not our subject - transfer", "the grievance does not pertain to this Department and is being transferred on the portal to the authority concerned."),
    ],
    "reminder": [
        ("send_now", "Send the pending reply now", "the reply to your earlier communication is furnished below.\n{notes|[reply to be added]}\nThe delay is regretted."),
        ("extension", "Regret delay and ask for time", "the delay in replying is regretted. The matter is under active consideration and the reply will be sent by {ext}."),
        ("already", "Reply already sent", "a reply has already been sent vide this Department's {notes|letter No. [number] dated [date]}. A copy is enclosed for ready reference."),
    ],
    "sanction_info": [
        ("none", "No reply needed (file it)", ""),
        ("acknowledge", "Acknowledge receipt", "the receipt of the above communication is acknowledged with thanks. Necessary action is being taken."),
    ],
    "circular_info": [
        ("none", "No reply needed (file it)", ""),
        ("circulated", "Confirm it was circulated", "the instructions have been noted and circulated to all divisions of this Department for compliance."),
    ],
    "invitation_event": [
        ("accept", "Accept", "{notes|I} will be happy to attend the event. I thank you for the kind invitation."),
        ("decline", "Decline politely", "owing to prior commitments, I regret my inability to attend the event. I convey my best wishes for its success."),
        ("represent", "Send a representative", "owing to prior commitments, I may not be able to attend. {notes|A senior officer} will represent the Department. I convey my best wishes for the success of the event."),
    ],
    "vigilance_clearance": [
        ("clear", "Give vigilance clearance", "no vigilance case is pending or contemplated against {notes|the officer}, and vigilance clearance is accorded. The APARs are enclosed."),
        ("pending", "Can't clear now (diplomatically)", "a matter in respect of {notes|the officer} is under examination. The vigilance status will be intimated on its conclusion."),
        ("time", "Ask for more time", "the vigilance status is being ascertained and will be communicated by {ext}."),
    ],
    "budget_request": [
        ("send", "Send the requirement", "the requirement of this Department is as follows:\n{notes|[figures to be added]}"),
        ("nil", "No additional requirement", "this Department has no additional requirement of funds under the head at present."),
        ("time", "Ask for more time", "the estimates are being compiled and will be furnished by {ext}."),
    ],
    "deputation_noc": [
        ("grant", "Grant NOC", "this Department has no objection to the deputation of {notes|the officer}. The vigilance clearance and APARs are enclosed."),
        ("decline", "Decline diplomatically", "in view of exigencies of work and shortage of officers at this level, it may not be possible to relieve {notes|the officer} at present. The request may kindly be considered at a later stage."),
        ("details", "Ask for details", "the terms of deputation, including {notes|the pay level and tenure}, may kindly be intimated to enable this Department to process the request."),
    ],
}


def options_for(intent: str) -> list[dict]:
    return [{"id": i, "label": label, "recommended": k == 0, "letter": bool(text)} for k, (i, label, text) in enumerate(OPTIONS[intent])]


def _fill(text: str, notes: str, ext: str) -> str:
    def rep(m):
        default = m.group(1)
        return notes.strip() if notes.strip() else default
    out = re.sub(r"\{notes\|([^}]*)\}", rep, text)
    return out.replace("{notes}", notes.strip()).replace("{ext}", ext)


def salutation(name: str) -> str:
    name = (name or "").strip()
    for title in ("Dr.", "Smt.", "Shri", "Ms.", "Mr."):
        if name.startswith(title):
            return f"Dear {title} {name.split()[-1]},"
    return f"Dear Shri {name.split()[-1]}," if name else "Dear Sir/Madam,"


def draft_reply(f: dict, intent: str, option: str, notes: str, me: dict, today: date, our_file_no: str) -> dict:
    """The reply as structured lines in service format, answering a Letter with a letter, an OM with an OM, a D.O. with a D.O."""
    opt = next(o for o in OPTIONS[intent] if o[0] == option)
    body = _fill(opt[2], notes, (today + timedelta(days=14)).strftime("%d.%m.%Y"))
    first, *rest = body.split("\n")
    theirs = f.get("format", "Letter")
    kind = "OM" if theirs in ("Office Memorandum", "Notice", "Circular", "Office Order") else "DO" if theirs == "D.O. letter" else "Letter"
    ref_word = {"OM": "O.M.", "DO": "D.O. letter", "Letter": "letter"}[kind]
    ref = f"{ref_word} No. {f.get('file_no', '[number]')} dated {fmt_date(f.get('date'))}"
    name, desig = me.get("name", "[Name]"), me.get("designation", "Deputy Secretary")
    L = []   # (style, text): c centre, cb centre bold, r right, b bold, p paragraph, l line
    if kind == "DO":
        L += [("b", name), ("l", desig), ("r", f"D.O. No. {our_file_no}")]
    else:
        L += [("r", f"F.No. {our_file_no}")]
    L += [("cb", "Government of India"), ("cb", OUR_OFFICE["parent"]), ("c", OUR_OFFICE["office"]), ("c", OUR_OFFICE["address"]),
          ("r", f"Dated the {fmt_date(today.isoformat(), long=True)}")]
    # official letters go to the post ("The Director (Training)"); a D.O. reply goes to the person by name
    who = (f.get("signatory"), f.get("designation")) if kind == "DO" else (f"The {f['designation']}" if f.get("designation") else "",)
    to_block = [x for x in (*who, f.get("sender_office"), f.get("sender_parent"), f.get("sender_address")) if x]
    if kind == "OM":
        L.append(("cb", "OFFICE MEMORANDUM"))
    if kind == "Letter":
        L += [("l", "To,")] + [("l", "    " + x + ("," if i < len(to_block) - 1 else ".")) for i, x in enumerate(to_block)]
    if kind == "DO":
        L.append(("l", salutation(f.get("signatory", ""))))
    L.append(("b", f"Subject: {f.get('subject', '')}."))
    if kind == "Letter":
        L.append(("l", "Sir/Madam,"))
    lead = {"Letter": f"I am directed to refer to your {ref} on the subject cited above and to say that {first}",
            "OM": f"The undersigned is directed to refer to the {ref} on the subject mentioned above and to say that {first}",
            "DO": f"Please refer to your {ref} regarding {f.get('subject', 'the above subject')[:1].lower()}{f.get('subject', '')[1:]}. "
                  f"{first[:1].upper()}{first[1:]}"}[kind]
    paras = [lead] + [r for r in rest if r.strip()]
    if kind != "DO":
        paras.append("This issues with the approval of the competent authority.")
    for i, p in enumerate(paras):
        L.append(("p", (f"{i + 1}.  " if i else "") + p))
    if kind == "DO":
        L += [("l", "With regards,"), ("r", "Yours sincerely,"), ("r", f"({name})")]
        L += [("l", x) for x in to_block]
    else:
        if kind == "Letter":
            L.append(("r", "Yours faithfully,"))
        L += [("r", f"({name})"), ("r", f"{desig} to the Government of India"), ("r", f"Tel: {OUR_OFFICE['tel']}")]
        if kind == "OM":
            L += [("l", "To")] + [("l", "    " + ", ".join(to_block))]
    return {"lines": L, "kind": kind, "text": lines_to_text(L)}


def fmt_date(iso, long=False):
    if not iso:
        return "[date]"
    d = date.fromisoformat(iso)
    if long:
        n = d.day
        suf = "th" if 11 <= n % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
        return f"{n}{suf} {d.strftime('%B')}, {d.year}"
    return d.strftime("%d.%m.%Y")


def lines_to_text(L) -> str:
    out = []
    for style, t in L:
        if style in ("c", "cb"):
            out.append(t.center(72).rstrip())
        elif style == "r":
            out.append(t.rjust(72))
        elif style == "p":
            out.append("")
            out.append("        " + t)
        elif style == "b":
            out.append("")
            out.append(t)
        else:
            out.append(t)
    return "\n".join(out)


def to_docx(L) -> bytes:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt, Cm
    doc = Document()
    for s in doc.sections:
        s.left_margin, s.right_margin, s.top_margin = Cm(2.5), Cm(2), Cm(2)
    st = doc.styles["Normal"]
    st.font.name, st.font.size = "Times New Roman", Pt(12)
    align = {"c": WD_ALIGN_PARAGRAPH.CENTER, "cb": WD_ALIGN_PARAGRAPH.CENTER, "r": WD_ALIGN_PARAGRAPH.RIGHT,
             "p": WD_ALIGN_PARAGRAPH.JUSTIFY, "b": WD_ALIGN_PARAGRAPH.LEFT, "l": WD_ALIGN_PARAGRAPH.LEFT}
    for style, t in L:
        para = doc.add_paragraph()
        run = para.add_run(t.strip() if style != "l" else t.replace("    ", "\t"))
        run.bold = style in ("cb", "b")
        para.alignment = align[style]
        para.paragraph_format.space_after = Pt(2 if style in ("c", "cb", "l") else 6)
        if style == "p":
            para.paragraph_format.first_line_indent = Cm(1.27)
            para.paragraph_format.space_before = Pt(6)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


AI_PROMPT = """You improve the wording of a draft reply from a Government of India office. Keep the meaning, every fact,
number, name and date exactly; do not add facts. Use formal official English (noting and drafting style), short
paragraphs. Reply with ONE JSON object: {"paras": ["first paragraph", "second paragraph", ...]}"""
AI_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["paras"],
             "properties": {"paras": {"type": "array", "maxItems": 6, "items": {"type": "string", "maxLength": 900}}}}


def apply_paras(L, paras: list[str]):
    """Put reworded paragraphs (from the model) back into the reply, keeping the numbering and everything else."""
    old = [i for i, (s, _) in enumerate(L) if s == "p"]
    if not paras or len(paras) != len(old):
        return L
    L = list(L)
    for k, (i, p) in enumerate(zip(old, paras)):
        p = re.sub(r"^\d+\.\s*", "", p.strip())
        L[i] = ("p", (f"{k + 1}.  " if k else "") + p)
    return L


# ---------------------------------------------------------------- the register (one row per letter received)

ASK_WORDS = re.compile(r"(requested|may (kindly|please)|is required|furnish|attend|nominat|replied|disposed|comments|views|"
                       r"confirm|forwarded|intimated|clearance|no objection)", re.I)


def asks(f: dict) -> str:
    """The sentence of the letter that says what is wanted."""
    sents = re.split(r"(?<=[.])\s+(?=[A-Z0-9])", f.get("body", ""))
    hit = [s for s in sents if ASK_WORDS.search(s)]
    s = (hit[-1] if hit else sents[0] if sents else "").strip()
    return re.sub(r"^\d+\.\s*", "", s)[:400]


def ingest(con, emp_id: str, pdf: bytes, source: str, url: str, original_name: str, store_dir, today: date) -> tuple[dict, bool]:
    """Read a downloaded letter once (the same PDF twice is the same letter) and remember where it is filed."""
    import hashlib
    import os
    sha = hashlib.sha256(pdf).hexdigest()
    row = con.execute("SELECT * FROM letters WHERE emp_id=? AND sha256=?", (emp_id, sha)).fetchone()
    if row:
        return record(row), False
    f = parse(pdf_text(pdf), today)
    intent, why = classify(f)
    f["intent_why"] = why
    f["asks"] = asks(f)
    os.makedirs(store_dir, exist_ok=True)
    with open(os.path.join(store_dir, f"{sha}.pdf"), "wb") as fh:
        fh.write(pdf)
    con.execute("""INSERT INTO letters (emp_id, sha256, source, source_url, original_name, fields, intent, deadline, folder, file_name,
                   status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'new', ?)""",
                (emp_id, sha, source[:100], url[:500], original_name[:200], json.dumps(f), intent, f.get("deadline"),
                 correspondent(f), file_name(f), today.isoformat()))
    return record(con.execute("SELECT * FROM letters WHERE emp_id=? AND sha256=?", (emp_id, sha)).fetchone()), True


def record(row) -> dict:
    f = json.loads(row["fields"])
    return {"id": row["id"], "folder": row["folder"], "file_name": row["file_name"], "intent": row["intent"],
            "intent_label": INTENT_LABELS.get(row["intent"], row["intent"]), "deadline": row["deadline"], "status": row["status"],
            "source_url": row["source_url"], "original_name": row["original_name"], "received": row["created_at"],
            "format": f.get("format"), "file_no": f.get("file_no"), "date": f.get("date"), "subject": f.get("subject"),
            "from": row["folder"], "signatory": f.get("signatory"), "designation": f.get("designation"), "asks": f.get("asks", ""),
            "options": options_for(row["intent"]), "draft": json.loads(row["draft"]) if row["draft"] else None}


def register_csv(rows) -> str:
    import csv
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Received", "Letter date", "File No.", "From", "Type", "Subject", "What it asks", "Reply due", "Status", "Filed as"])
    for r in rows:
        w.writerow([r["received"], r["date"], r["file_no"], r["folder"], r["intent_label"], r["subject"], r["asks"],
                    r["deadline"] or "", r["status"], f"{r['folder']}/{r['file_name']}"])
    return buf.getvalue()
