"""Communications: the user's letters, notes, circulars and e-mails from office apps, sorted into folders and
searchable in plain words ("letters I sent to Priya about leave last month").

Items are read from the office app as the user (by the extension, with the user's own session) and indexed per
user in SQLite full-text search. Folders and the query parser are plain rules: fast, offline, no model needed.
"""
import json
import re
from datetime import date, timedelta

SCHEMA = """
CREATE TABLE IF NOT EXISTS comms (
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id TEXT, source TEXT, ext_id TEXT, direction TEXT, type TEXT, ref TEXT,
  date TEXT, sender TEXT, recipients TEXT, cc TEXT, subject TEXT, body TEXT, attachments TEXT, url TEXT, folder TEXT,
  UNIQUE (emp_id, source, ext_id));
CREATE VIRTUAL TABLE IF NOT EXISTS comms_fts USING fts5(subject, body, people, ref, tokenize='porter unicode61');
"""

# Topic folders, first match wins (the type "Circular" gets its own folder)
FOLDERS = [
    ("Leave & HR", r"\b(leave|holiday|attendance|hr department|appraisal|salary|payslip)\b"),
    ("IT", r"\b(laptop|vpn|e-?mail server|it service|software|password|network|lt-\d+)\b"),
    ("Purchase & Finance", r"\b(purchase|po-\d+|pr-\d+|reimburse\w*|budget|invoice|finance|claim|vendor)\b"),
    ("Travel", r"\b(travel|trip|advance|visit to)\b"),
    ("Meetings", r"\b(meeting|minutes|agenda)\b"),
    ("Projects", r"\b(project|prj-\d+|milestone|status report)\b"),
    ("Admin", r"\b(fire drill|desk|admin|facility|parking)\b"),
]
FOLDER_NAMES = ["Circulars"] + [f for f, _ in FOLDERS] + ["Other"]


def folder_for(item: dict) -> str:
    if (item.get("type") or "").lower() == "circular":
        return "Circulars"
    text = f"{item.get('subject', '')} {item.get('body', '')} {item.get('sender', '')} {item.get('recipients', '')}".lower()
    return next((f for f, rx in FOLDERS if re.search(rx, text)), "Other")


def sync(con, emp_id: str, source: str, items: list[dict], me_hint: str = "") -> int:
    """Insert or update the items of one source. Direction: what the user sent vs. received."""
    n = 0
    for it in items:
        sender, recipients = str(it.get("from") or it.get("sender") or ""), str(it.get("to") or it.get("recipients") or "")
        direction = it.get("direction") or ("sent" if it.get("box") == "out" or (me_hint and me_hint.lower() in sender.lower())
                                            else "received")
        row = {"type": it.get("type") or "E-mail", "ref": it.get("ref") or "", "date": str(it.get("date") or "")[:10],
               "sender": sender, "recipients": recipients, "cc": it.get("cc") or "", "subject": it.get("subject") or "",
               "body": it.get("body") or "", "attachments": json.dumps(it.get("attachments") or []), "url": it.get("url") or ""}
        row["folder"] = folder_for(row)
        old = con.execute("SELECT id FROM comms WHERE emp_id=? AND source=? AND ext_id=?", (emp_id, source, str(it.get("id")))).fetchone()
        if old:
            con.execute("DELETE FROM comms_fts WHERE rowid=?", (old["id"],))
            con.execute("""UPDATE comms SET direction=?, type=?, ref=?, date=?, sender=?, recipients=?, cc=?, subject=?, body=?,
                attachments=?, url=?, folder=? WHERE id=?""", (direction, row["type"], row["ref"], row["date"], row["sender"],
                row["recipients"], row["cc"], row["subject"], row["body"], row["attachments"], row["url"], row["folder"], old["id"]))
            cid = old["id"]
        else:
            cid = con.execute("""INSERT INTO comms (emp_id, source, ext_id, direction, type, ref, date, sender, recipients, cc, subject,
                body, attachments, url, folder) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (emp_id, source, str(it.get("id")), direction,
                row["type"], row["ref"], row["date"], row["sender"], row["recipients"], row["cc"], row["subject"], row["body"],
                row["attachments"], row["url"], row["folder"])).lastrowid
        con.execute("INSERT INTO comms_fts (rowid, subject, body, people, ref) VALUES (?,?,?,?,?)",
                    (cid, row["subject"], row["body"], f"{row['sender']} {row['recipients']} {row['cc']}", row["ref"]))
        n += 1
    con.commit()
    return n


MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
STOP = {"find", "show", "me", "my", "the", "a", "an", "all", "any", "about", "regarding", "on", "of", "for", "with", "i", "what",
        "which", "where", "is", "are", "was", "did", "that", "those", "these", "please", "list", "get", "search", "communication",
        "communications", "letter", "letters", "note", "notes", "circular", "circulars", "mail", "mails", "email", "emails",
        "e-mail", "e-mails", "memo", "memos", "sent", "send", "received", "got", "inward", "outward", "have", "has", "in", "and",
        "or", "last", "this", "week", "month", "year", "today", "yesterday", "from", "to", "by", "since", "before", "after"}


def parse_query(q: str, today: date) -> dict:
    """Plain words -> filters + search terms. "letters I sent to Priya about leave last month" ->
    direction=sent, to=Priya, type=Letter, after/before = last month, terms=[leave]."""
    ql = f" {(q or '').lower()} "
    f = {"terms": []}
    if re.search(r"\b(i sent|i have sent|i send|did i send|i wrote|did i write|sent by me|my sent|outward|outgoing|i replied)\b", ql) \
            or re.search(r"\bsent\b", ql):
        f["direction"] = "sent"
    if re.search(r"\b(received|inward|incoming|i got|sent to me|came to me)\b", ql):
        f["direction"] = "received"
    for word, typ in (("letter", "Letter"), ("note", "Note"), ("circular", "Circular"), ("memo", "Note"), ("e-?mails?|mails?", "E-mail")):
        if re.search(rf"\b({word})s?\b", ql):
            f["type"] = typ
            break
    name = r"([a-z][a-z.]+(?:\s+(?!about|on|in|last|this|regarding|for|since|before|after|from|to)[a-z][a-z.]+)?)"
    if m := re.search(r"\bto\s+" + name, ql):
        if m.group(1) not in ("me", "all", "the"):
            f["to"] = m.group(1).strip()
    if m := re.search(r"\bfrom\s+" + name, ql):
        if m.group(1) not in ("me", "the"):
            f["from"] = m.group(1).strip()
    # dates
    if "last week" in ql:
        start = today - timedelta(days=today.weekday() + 7)
        f["after"], f["before"] = start.isoformat(), (start + timedelta(days=6)).isoformat()
    elif "this week" in ql:
        f["after"] = (today - timedelta(days=today.weekday())).isoformat()
    elif "last month" in ql:
        first = today.replace(day=1)
        prev_end = first - timedelta(days=1)
        f["after"], f["before"] = prev_end.replace(day=1).isoformat(), prev_end.isoformat()
    elif "this month" in ql:
        f["after"] = today.replace(day=1).isoformat()
    elif "yesterday" in ql:
        f["after"] = f["before"] = (today - timedelta(days=1)).isoformat()
    elif "today" in ql:
        f["after"] = f["before"] = today.isoformat()
    elif m := re.search(r"\b(?:in|during)\s+(" + "|".join(MONTHS) + r"|" + "|".join(x[:3] for x in MONTHS) + r")\b(?:\s+(\d{4}))?", ql):
        mon = next(i for i, x in enumerate(MONTHS) if x.startswith(m.group(1)[:3])) + 1
        year = int(m.group(2)) if m.group(2) else (today.year if mon <= today.month else today.year - 1)
        end = (date(year + (mon == 12), mon % 12 + 1, 1) - timedelta(days=1))
        f["after"], f["before"] = date(year, mon, 1).isoformat(), end.isoformat()
    # the rest are words to look for (references like PO-1234 kept whole)
    rest = ql
    for k in ("to", "from"):
        if f.get(k):
            rest = re.sub(rf"\b{k}\s+{re.escape(f[k])}\b", " ", rest)
    for tok in re.findall(r"[a-z]{2,}-?\d+|[a-z0-9]+", rest):
        if tok not in STOP and not tok.isdigit() and tok not in MONTHS and tok not in [x[:3] for x in MONTHS]:
            f["terms"].append(tok)
    return f


def search(con, emp_id: str, q: str = "", folder: str = "", direction: str = "", today: date | None = None, limit: int = 30) -> dict:
    today = today or date.today()
    f = parse_query(q, today) if q else {"terms": []}
    if direction:
        f["direction"] = direction
    # "to Pune" is a place, not a person: a name only filters if it is one of the user's correspondents
    for k, cols in (("to", "recipients || ' ' || cc"), ("from", "sender")):
        if f.get(k) and not con.execute(f"SELECT 1 FROM comms WHERE emp_id=? AND lower({cols}) LIKE ? LIMIT 1",
                                        (emp_id, f"%{f[k]}%")).fetchone():
            f["terms"] += f.pop(k).split()
    where, args = ["c.emp_id=?"], [emp_id]
    if folder and folder in FOLDER_NAMES:
        where.append("c.folder=?"); args.append(folder)
    # "letters" is what people call any communication: letters come first, but notes and e-mails count too
    soft_type = f.get("type") == "Letter"
    for key, col in (("direction", "c.direction"), ("type", "c.type")):
        if f.get(key) and not (key == "type" and soft_type):
            where.append(f"{col}=?"); args.append(f[key])
    if f.get("to"):
        where.append("lower(c.recipients || ' ' || c.cc) LIKE ?"); args.append(f"%{f['to']}%")
    if f.get("from"):
        where.append("lower(c.sender) LIKE ?"); args.append(f"%{f['from']}%")
    if f.get("after"):
        where.append("c.date >= ?"); args.append(f["after"])
    if f.get("before"):
        where.append("c.date <= ?"); args.append(f["before"])

    def run(match, n=limit):
        sql = ("SELECT c.*, " + ("snippet(comms_fts, 1, '<mark>', '</mark>', '…', 14) AS snip, bm25(comms_fts) AS score "
                                  if match else "'' AS snip, 0 AS score ") +
               "FROM comms c " + ("JOIN comms_fts ON comms_fts.rowid = c.id AND comms_fts MATCH ? " if match else "") +
               "WHERE " + " AND ".join(where) + (" ORDER BY score, c.date DESC" if match else " ORDER BY c.date DESC") + " LIMIT ?")
        return [dict(r) for r in con.execute(sql, ([match] if match else []) + args + [n])]

    terms = [re.sub(r'[^\w-]', '', t) for t in f["terms"] if re.sub(r'[^\w-]', '', t)]
    quote = lambda t: f'"{t}"' if "-" in t else f"{t}*"
    # names as whole words: "Priya" is not "Priyanka"
    name_rx = [(k, re.compile(rf"\b{re.escape(f[k])}\b", re.I)) for k in ("to", "from") if f.get(k)]
    run_sql = run

    def run(match):
        rows = run_sql(match, limit * 5 if name_rx else limit)
        to_rx = None
        for k, rx in name_rx:
            rows = [r for r in rows if rx.search(r["sender"] if k == "from" else f"{r['recipients']} {r['cc']}")]
            to_rx = rx if k == "to" else to_rx
        # sent to them directly before only copied to them; then letters before other kinds (stable: keeps relevance)
        rows.sort(key=lambda r: (bool(to_rx) and not to_rx.search(r["recipients"]), soft_type and r["type"] != "Letter"))
        return rows[:limit]
    rows, mode = [], "all words"
    if terms:
        rows = run(" AND ".join(quote(t) for t in terms))
        if not rows:   # be forgiving: any of the words
            rows, mode = run(" OR ".join(quote(t) for t in terms)), "any word"
    else:
        rows = run(None)
    relaxed = None
    if not rows and (f.get("after") or f.get("before")):
        # nothing in that period: show the same search on any date, and say so
        keep = [(w, a) for w, a in zip(where, args) if not w.startswith("c.date")]
        where[:], args[:] = [w for w, _ in keep], [a for _, a in keep]
        rows = run(" OR ".join(quote(t) for t in terms)) if terms else run(None)
        relaxed = "dates"
    for r in rows:
        r["attachments"] = json.loads(r["attachments"] or "[]")
        if not r["snip"]:
            r["snip"] = (r["body"] or "")[:140]
    counts = {name: 0 for name in FOLDER_NAMES}
    for row in con.execute("SELECT folder, COUNT(*) FROM comms WHERE emp_id=? GROUP BY folder", (emp_id,)):
        counts[row[0]] = row[1]
    boxes = dict(con.execute("SELECT direction, COUNT(*) FROM comms WHERE emp_id=? GROUP BY direction", (emp_id,)).fetchall())
    return {"query": f, "match": mode, "relaxed": relaxed, "results": rows, "folders": counts, "sent": boxes.get("sent", 0),
            "received": boxes.get("received", 0)}


def looks_like_search(prompt: str) -> bool:
    """A chat message that is a search of the user's communications rather than a task to do."""
    p = prompt.lower()
    return bool(re.match(r"\s*(find|search|show|look up|where is|list|which)\b", p)) and bool(
        re.search(r"\b(letters?|notes?|circulars?|e-?mails?|mails?|memos?|communications?|sent|received)\b", p))
