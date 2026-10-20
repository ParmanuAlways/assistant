"""Dummy Government of India correspondence for testing (service format), with the intent of each letter known.

Every document is fictitious and marked "DUMMY - FOR TESTING". Formats: Letter, Office Memorandum, D.O. letter,
Circular, Office Order, Notice (meeting), Reminder. Kinds of request (intent): see INTENTS.
"""
import io
import random
import re
from datetime import date, timedelta

# The receiving office (fictitious)
US = {"dept": "Department of Industrial Development", "ministry": "Ministry of Commerce & Industry",
      "address": "Udyog Bhawan, New Delhi - 110011", "officer": "Shri Ravi Kumar",
      "designation": "Deputy Secretary (Administration)", "short": "IDD"}

SENDERS = [
    # (parent, office, address, signatory, designation, file prefix, salutation-surname)
    ("Ministry of Finance", "Department of Expenditure", "North Block, New Delhi - 110001", "Anil Kumar Verma", "Under Secretary to the Government of India", "F.No.7(2)/E.Coord-I", "Verma"),
    ("Ministry of Personnel, PG & Pensions", "Department of Personnel & Training", "North Block, New Delhi - 110001", "Smt. Meenakshi Rao", "Deputy Secretary to the Government of India", "No.11013/4", "Rao"),
    ("Ministry of Home Affairs", "Administration Division", "North Block, New Delhi - 110001", "Rajesh Khanna", "Director (Admn.)", "F.No.A-12011/9", "Khanna"),
    ("Cabinet Secretariat", "Coordination Division", "Rashtrapati Bhawan, New Delhi - 110004", "Dr. S. Venkatesh", "Joint Secretary", "No.1/1/3/Cab", "Venkatesh"),
    ("NITI Aayog", "Industry Vertical", "Sansad Marg, New Delhi - 110001", "Kavita Menon", "Adviser (Industry)", "No.M-11016/2", "Menon"),
    ("Lok Sabha Secretariat", "Question Branch", "Parliament House Annexe, New Delhi - 110001", "P. K. Bose", "Under Secretary", "LSS/Q/2026", "Bose"),
    ("Office of the Principal Director of Audit", "Economic & Service Ministries", "AGCR Building, New Delhi - 110002", "R. Subramanian", "Deputy Director (Audit)", "No.PDA/ESM/IDD", "Subramanian"),
    ("Central Vigilance Commission", "Coordination Section", "Satarkta Bhawan, INA, New Delhi - 110023", "Neha Sinha", "Under Secretary", "No.026/VGL/031", "Sinha"),
    ("Ministry of Electronics & Information Technology", "e-Governance Group", "Electronics Niketan, New Delhi - 110003", "Arvind Joshi", "Scientist 'E'", "No.1(4)/2026-EG", "Joshi"),
    ("Department of Administrative Reforms & PG", "Public Grievances Division", "Sardar Patel Bhawan, New Delhi - 110001", "Sunita Bhatt", "Under Secretary", "No.K-11031/7", "Bhatt"),
    ("Government of Maharashtra", "Industries, Energy & Labour Department", "Mantralaya, Mumbai - 400032", "Prashant Deshmukh", "Joint Secretary", "No.IDC-2026/CR-114", "Deshmukh"),
    ("Government of Karnataka", "Commerce & Industries Department", "Vikasa Soudha, Bengaluru - 560001", "H. N. Gowda", "Under Secretary", "CI/112/SPI/2026", "Gowda"),
    ("Institute of Secretariat Training & Management", "Training Division", "JNU Campus, New Delhi - 110067", "Dr. Ritu Saxena", "Director (Training)", "No.ISTM/Trg/2026", "Saxena"),
    ("Ministry of External Affairs", "Economic Diplomacy Division", "Jawaharlal Nehru Bhawan, New Delhi - 110011", "Vikram Nair", "Director (ED)", "No.ED/451/1", "Nair"),
    ("Department of Industrial Development", "Budget Section", "Udyog Bhawan, New Delhi - 110011", "Mohan Lal", "Under Secretary (Budget)", "F.No.B-2/IDD", "Lal"),
    ("Department of Industrial Development", "Vigilance Section", "Udyog Bhawan, New Delhi - 110011", "Seema Arora", "Chief Vigilance Officer", "No.V-11/IDD", "Arora"),
]

SUBJECTS = ["the National Industrial Corridor Programme", "the PLI Scheme for White Goods", "Ease of Doing Business reforms",
            "the Start-up India Seed Fund", "MSME cluster development", "the Industrial Park Rating System",
            "the Logistics Efficiency Enhancement Programme", "Swachhta Pakhwada 2026", "e-Office implementation",
            "the Annual Action Plan 2026-27", "digitisation of records", "the Vibrant Villages Programme"]
OFFICERS = ["Shri Amit Sharma, Under Secretary", "Smt. Pooja Iyer, Deputy Secretary", "Shri Naveen Gupta, Director",
            "Shri Karan Malhotra, Section Officer", "Smt. Lata Krishnan, Under Secretary"]
CITIES = ["Mumbai", "Bengaluru", "Chennai", "Hyderabad", "Kolkata"]
DUMMY = "DUMMY - FOR TESTING ONLY - not a genuine government document"


def _ord(n):
    return f"{n}{'th' if 11 <= n % 100 <= 13 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def formal_date(d):
    return f"{_ord(d.day)} {d.strftime('%B')}, {d.year}"


def dotted(d):
    return d.strftime("%d.%m.%Y")


# Each intent: (formats it comes in, subject line, body paragraphs). Several phrasings per intent so the
# classifier can't just match one fixed sentence. {t} topic, {dl} deadline, {d1}/{d2} dates, {n} number ...
INTENTS = {
    "info_request": (["Letter", "Office Memorandum", "D.O. letter"], [
        "Furnishing of information regarding {t}",
        "Requirement of data on {t}",
        "Information sought on progress under {t}"], [
        ["I am directed to request that the information on {t} in the enclosed proforma may be furnished to this {office_word} latest by {dl}.",
         "The information may also be sent by e-mail in MS-Excel format."],
        ["The undersigned is directed to say that data relating to {t} for the period April-September 2026 is required for a review by the competent authority.",
         "It is requested that the requisite data may please be provided by {dl} positively."],
        ["Kindly send the details of physical and financial progress made under {t} by {dl}, so that the same can be compiled."]]),
    "comments_draft": (["Office Memorandum", "Letter", "D.O. letter"], [
        "Comments on the draft guidelines for {t}",
        "Draft Cabinet Note on {t} - inter-ministerial consultation",
        "Seeking views on the draft amendment relating to {t}"], [
        ["The undersigned is directed to forward herewith a copy of the draft guidelines for {t} and to request that comments, if any, may be furnished within {days} days.",
         "In case no comments are received by {dl}, it will be presumed that the {us_word} has no comments to offer."],
        ["A draft Cabinet Note on {t} is enclosed for inter-ministerial consultation. Views of the {us_word} may be conveyed by {dl} for incorporation in the final Note."]]),
    "meeting": (["Notice", "Office Memorandum"], [
        "Meeting to review {t}",
        "Inter-ministerial meeting on {t} on {d1s}"], [
        ["The undersigned is directed to state that a meeting to review {t} will be held under the chairmanship of the Secretary on {d1f} at {time} in Committee Room No. {n}.",
         "It is requested to kindly make it convenient to attend the meeting or depute a senior officer. The name of the officer attending may be intimated by {dl}."],
        ["An inter-ministerial meeting on {t} is scheduled on {d1f} at {time} through video conferencing. You are requested to confirm participation by {dl}."]]),
    "nomination": (["Letter", "Office Memorandum", "Circular"], [
        "Nomination of officers for training programme on {t}",
        "Constitution of a Committee on {t} - nomination of a representative"], [
        ["ISTM is conducting a {days}-day training programme on {t} from {d1f}. It is requested that nominations of officers of the level of Under Secretary and above may be sent by {dl}."],
        ["It has been decided to constitute a Committee to examine {t}. The {us_word} is requested to nominate a representative not below the rank of Director to the Committee by {dl}."]]),
    "atr_compliance": (["Office Memorandum", "Letter", "D.O. letter"], [
        "Action Taken Report on the decisions of the meeting on {t}",
        "Compliance of instructions regarding {t}"], [
        ["Please refer to the minutes of the meeting held on {d2f} on {t}. An Action Taken Report on the decisions pertaining to the {us_word} may be furnished by {dl}."],
        ["Instructions were issued vide this {office_word}'s OM dated {d2f} regarding {t}. A compliance report indicating the action taken may be sent by {dl}."]]),
    "parliament": (["Letter"], [
        "Lok Sabha Unstarred Question No. {n} for answer on {d1s} regarding {t}",
        "Rajya Sabha Starred Question Diary No. {n} - {t}"], [
        ["MOST IMMEDIATE / PARLIAMENT QUESTION",
         "A copy of the above question regarding {t} is forwarded herewith. Material for the reply, duly vetted, may be furnished by {dl} positively, as the question is listed for answer on {d1f}."],
        ["PARLIAMENT MATTER - TIME BOUND",
         "The above question has been transferred to the {us_word}. Inputs for preparing the reply may be sent latest by {dl}."]]),
    "rti": (["Letter"], [
        "Transfer of RTI application under Section 6(3) of the RTI Act, 2005",
        "Application under the RTI Act, 2005 from Shri {applicant}"], [
        ["An application dated {d2f} received from Shri {applicant} under the Right to Information Act, 2005 seeking information on {t} is transferred under Section 6(3) of the Act, as the information is held by your public authority.",
         "The applicant may be replied to directly within the time limit prescribed under the Act."]]),
    "audit_para": (["Letter"], [
        "Draft Audit Para on {t}",
        "Audit observations on expenditure under {t}"], [
        ["A draft paragraph on irregularities noticed in {t} is forwarded herewith. The reply of the {us_word} may be furnished within six weeks, latest by {dl}.",
         "In case no reply is received, the para will be finalised without the views of the {us_word}."],
        ["During the audit of accounts for 2025-26, certain observations were made regarding expenditure under {t}. Replies to the observations may be furnished by {dl}."]]),
    "grievance": (["Office Memorandum"], [
        "Public grievance received on CPGRAMS regarding {t}",
        "Grievance petition of Shri {applicant} regarding {t}"], [
        ["The undersigned is directed to forward the grievance No. DARPG/E/2026/0{n} received on CPGRAMS regarding {t} for examination and disposal on merit.",
         "Action taken may be uploaded on the portal and the grievance disposed of within {days} days."]]),
    "reminder": (["Reminder", "Office Memorandum"], [
        "REMINDER - Furnishing of information regarding {t}",
        "Second Reminder: Comments on {t}"], [
        ["Attention is invited to this {office_word}'s letter of even number dated {d2f} on the subject cited above. The reply is still awaited.",
         "It is requested that the matter may be treated as URGENT and the reply sent by {dl}."]]),
    "sanction_info": (["Office Order", "Letter"], [
        "Sanction of Grants-in-aid under {t}",
        "Approval of the competent authority for {t}"], [
        ["I am directed to convey the sanction of the President for release of Rs. {lakh} lakh as grants-in-aid under {t} for the year 2026-27.",
         "This issues with the concurrence of the Integrated Finance Division."],
        ["The competent authority has approved the proposal regarding {t}. This is for information and necessary action."]]),
    "circular_info": (["Circular"], [
        "Guidelines on {t} - for information and compliance",
        "Observance of {t}"], [
        ["The undersigned is directed to circulate the guidelines on {t} for information and strict compliance by all concerned.",
         "These instructions come into force with immediate effect."],
        ["All Ministries/Departments are informed that {t} will be observed from {d1f}. This is for information and wide circulation."]]),
    "invitation_event": (["D.O. letter", "Letter"], [
        "Invitation to the National Conference on {t}",
        "Inaugural session of the Workshop on {t}"], [
        ["I am happy to inform you that we are organising a National Conference on {t} on {d1f} at {city}.",
         "I would be grateful if you could kindly grace the occasion and deliver the keynote address. Kindly confirm your availability by {dl}."]]),
    "vigilance_clearance": (["Office Memorandum"], [
        "Vigilance clearance in respect of {officer}",
        "Request for vigilance status of {officer} for empanelment"], [
        ["The undersigned is directed to request that vigilance clearance in respect of {officer} may be furnished to this {office_word} by {dl}, along with the APARs for the last five years."]]),
    "budget_request": (["Office Memorandum"], [
        "Revised Estimates 2026-27 and Budget Estimates 2027-28",
        "Requirement of additional funds under {t}"], [
        ["The undersigned is directed to request that the Revised Estimates 2026-27 and Budget Estimates 2027-28 in respect of {t} may be furnished in the prescribed format by {dl}."],
        ["Requirement of additional funds, if any, under {t} during the current financial year may be intimated with justification by {dl}."]]),
    "deputation_noc": (["Letter", "Office Memorandum"], [
        "No Objection Certificate for deputation of {officer}",
        "Forwarding of application of {officer} for the post of Director on deputation"], [
        ["{officer} of your {us_word} has applied for the post of Director in this {office_word} on deputation basis. It is requested that a No Objection Certificate, along with vigilance clearance, may be sent by {dl}."]]),
}

APPLICANTS = ["Ramesh Chandra", "Suresh Patil", "Mohd. Irfan", "Harpreet Singh", "Deepak Yadav"]


def generate(n=100, seed=26, today=date(2026, 10, 19)):
    rnd = random.Random(seed)
    intents = list(INTENTS)
    out = []
    for i in range(n):
        intent = intents[i % len(intents)] if i < len(intents) * 3 else rnd.choice(intents)
        formats, subjects, bodies = INTENTS[intent]
        fmt = rnd.choice(formats)
        snd = rnd.choice([s for s in SENDERS if not (intent == "parliament" and s[0] != "Lok Sabha Secretariat")]
                         if intent != "parliament" else [s for s in SENDERS if s[0] == "Lok Sabha Secretariat"])
        if intent == "audit_para":
            snd = SENDERS[6]
        if intent == "nomination" and rnd.random() < .5:
            snd = SENDERS[12]
        sent = today - timedelta(days=rnd.randint(0, 60))
        dl = sent + timedelta(days=rnd.choice([7, 10, 14, 15, 21, 30]))
        d1 = sent + timedelta(days=rnd.randint(5, 25))
        d2 = sent - timedelta(days=rnd.randint(15, 60))
        if intent in ("meeting", "invitation_event"):   # a reply about attending is due before the day itself
            dl = max(sent + timedelta(days=1), min(dl, d1 - timedelta(days=3)))
        f = {"t": rnd.choice(SUBJECTS), "dl": dotted(dl), "d1f": formal_date(d1), "d1s": dotted(d1), "d2f": formal_date(d2),
             "days": rnd.choice([7, 10, 15, 3, 5]), "time": rnd.choice(["11:00 AM", "3:00 PM", "4:30 PM"]), "n": rnd.randint(101, 4999),
             "applicant": rnd.choice(APPLICANTS), "officer": rnd.choice(OFFICERS), "city": rnd.choice(CITIES),
             "lakh": rnd.randint(5, 900), "office_word": "Ministry" if "Ministry" in snd[0] else "Department" if "Department" in snd[0] else "office",
             "us_word": "Department"}
        subject = rnd.choice(subjects).format(**f)
        paras = [p.format(**f) for p in rnd.choice(bodies)]
        if fmt == "D.O. letter":   # a D.O. letter is personal, first person
            for a, b in (("The undersigned is directed to say that", "I am writing to say that"),
                         ("The undersigned is directed to request that", "I would request that"),
                         ("The undersigned is directed to forward herewith", "I am forwarding herewith"),
                         ("I am directed to request that", "I would request that"), ("It is requested that", "I would request that"),
                         ("It is requested to kindly", "I would request you to kindly")):
                paras = [p.replace(a, b) for p in paras]
        # what the letter itself says is due (the truth the reader is tested against)
        text = " ".join(paras)
        if intent in ("sanction_info", "circular_info"):
            due = None
        elif f["dl"] in text:
            due = dl
        elif m := re.search(r"within (\d+) days", text):
            due = sent + timedelta(days=int(m.group(1)))
        elif "time limit prescribed" in text:     # RTI transfer: 30 days under Section 7(1)
            due = sent + timedelta(days=30)
        else:
            due = None
        file_no = f"{snd[5]}/{rnd.randint(1, 99)}/2026-{rnd.choice(['Admn', 'Coord', 'Pol', 'Fin', 'Estt'])}"
        out.append({
            "id": 7000 + i, "intent": intent, "format": fmt, "file_no": file_no, "date": sent.isoformat(),
            "deadline": due.isoformat() if due else None,
            "sender_parent": snd[0], "sender_office": snd[1], "sender_address": snd[2], "signatory": snd[3],
            "designation": snd[4], "surname": snd[6], "subject": subject, "paras": paras,
            "receipt_no": f"{rnd.randint(1000000, 9999999)}/2026/{US['short']}-{rnd.choice(['Admn', 'Coord', 'Estt'])}",
            "copy_to": rnd.choice([[], ["PS to Secretary", "Guard file"], ["NIC Cell for uploading on the website"]]),
        })
    return out


def text_lines(L: dict) -> list[tuple[str, str]]:
    """The letter as (style, text) lines in service format; styles: c=centre, cb=centre bold, r=right, b=bold, p=para, l=line."""
    lines = []
    fmt = L["format"]
    is_do = fmt == "D.O. letter"
    if is_do:
        lines += [("b", L["signatory"]), ("l", L["designation"])]
        lines += [("r", f"D.O. No. {L['file_no'].removeprefix('F.No.').removeprefix('No.')}")]
    else:
        lines += [("r", f"{'F.No.' if not L['file_no'].startswith(('No.', 'F.No.')) else ''}{L['file_no']}")]
    gov = "Government of India" if not L["sender_parent"].startswith("Government of") and L["sender_parent"] != "Lok Sabha Secretariat" else ""
    if gov:
        lines.append(("cb", gov))
    lines += [("cb", L["sender_parent"]), ("c", L["sender_office"]), ("c", L["sender_address"]), ("r", f"Dated the {formal_date(date.fromisoformat(L['date']))}")]
    title = {"Office Memorandum": "OFFICE MEMORANDUM", "Circular": "CIRCULAR", "Office Order": "OFFICE ORDER", "Notice": "NOTICE",
             "Reminder": "REMINDER"}.get(fmt)
    if title:
        lines.append(("cb", title))
    if fmt not in ("Office Memorandum", "Circular", "Office Order", "Notice") and not is_do:
        lines += [("l", "To,"), ("l", f"    The {US['designation']},"), ("l", f"    {US['dept']},"), ("l", f"    {US['ministry']},"),
                  ("l", f"    {US['address']}.")]
    if is_do:
        lines += [("l", f"Dear {US['officer'].replace('Shri ', 'Shri ')},")]
    lines.append(("b", f"Subject: {L['subject']}."))
    if not is_do and fmt in ("Letter", "Reminder"):
        lines.append(("l", "Sir/Madam,"))
    for k, p in enumerate(L["paras"]):
        if p.isupper():
            lines.append(("cb", p))
        else:
            lines.append(("p", (f"{k + 1}.  " if len(L["paras"]) > 1 and k > 0 else "") + p))
    if is_do:
        lines += [("l", "With regards,"), ("r", "Yours sincerely,"), ("r", f"({L['signatory']})")]
        lines += [("l", f"{US['officer']}"), ("l", US["designation"]), ("l", f"{US['dept']}, {US['address']}")]
    else:
        if fmt in ("Letter", "Reminder"):
            lines.append(("r", "Yours faithfully,"))
        lines += [("r", f"({L['signatory']})"), ("r", L["designation"]), ("r", "Tel: 011-2309 " + str(1000 + L["id"] % 9000))]
        if fmt in ("Office Memorandum", "Notice", "Circular", "Office Order"):
            lines += [("l", "To"), ("l", f"    The {US['designation']}, {US['dept']}, {US['address']}" if fmt != "Circular"
                                     else "    All Ministries/Departments of the Government of India")]
    if L["copy_to"]:
        lines.append(("l", "Copy to:"))
        lines += [("l", f"    {i + 1}. {c}") for i, c in enumerate(L["copy_to"])]
    return lines


def render_pdf(L: dict) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.enums import TA_CENTER, TA_RIGHT, TA_JUSTIFY, TA_LEFT
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
    from xml.sax.saxutils import escape
    buf = io.BytesIO()
    styles = {
        "c": ParagraphStyle("c", fontName="Times-Roman", fontSize=12, leading=15, alignment=TA_CENTER),
        "cb": ParagraphStyle("cb", fontName="Times-Bold", fontSize=12, leading=16, alignment=TA_CENTER, spaceBefore=2),
        "r": ParagraphStyle("r", fontName="Times-Roman", fontSize=12, leading=15, alignment=TA_RIGHT, spaceBefore=4),
        "b": ParagraphStyle("b", fontName="Times-Bold", fontSize=12, leading=15, alignment=TA_LEFT, spaceBefore=10, spaceAfter=6),
        "p": ParagraphStyle("p", fontName="Times-Roman", fontSize=12, leading=16, alignment=TA_JUSTIFY, firstLineIndent=36, spaceBefore=6),
        "l": ParagraphStyle("l", fontName="Times-Roman", fontSize=12, leading=15, alignment=TA_LEFT),
    }

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica-Oblique", 8)
        canvas.setFillGray(0.45)
        canvas.drawCentredString(A4[0] / 2, 22, DUMMY)
        canvas.restoreState()
    story = []
    for style, text in text_lines(L):
        story.append(Paragraph(escape(text).replace("    ", "&nbsp;" * 6), styles[style]))
    SimpleDocTemplate(buf, pagesize=A4, leftMargin=72, rightMargin=60, topMargin=54, bottomMargin=50,
                      title=L["subject"], author="Dummy e-Office").build(story, onFirstPage=footer, onLaterPages=footer)
    return buf.getvalue()


if __name__ == "__main__":
    import sys
    letters = generate()
    from collections import Counter
    print(Counter(x["intent"] for x in letters))
    print(Counter(x["format"] for x in letters))
    out = sys.argv[1] if len(sys.argv) > 1 else None
    if out:
        import os
        os.makedirs(out, exist_ok=True)
        import csv
        short = {"Office Memorandum": "OM", "D.O. letter": "DO"}
        with open(f"{out}/index.csv", "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["file", "receipt_no", "format", "what it asks (intent)", "date", "reply due", "from", "subject"])
            for L in letters:
                name = f"{L['id']} - {short.get(L['format'], L['format'])} - {L['intent']}.pdf"
                open(f"{out}/{name}", "wb").write(render_pdf(L))
                w.writerow([name, L["receipt_no"], L["format"], L["intent"], L["date"], L["deadline"] or "",
                            f"{L['sender_parent']} - {L['sender_office']}", L["subject"]])
