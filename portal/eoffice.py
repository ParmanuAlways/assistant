"""Dummy e-Office (eoffice.office.local:8600): an inbox of receipts. Like the real thing, the list shows only the
receipt number, sender and a cut-off subject; the communication itself is a PDF the user downloads.
All letters are fictitious (portal/govletters.py) and every PDF is marked DUMMY.
"""
import html
from functools import lru_cache

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.middleware.sessions import SessionMiddleware

import govletters

app = FastAPI(title="Dummy e-Office")
app.add_middleware(SessionMiddleware, secret_key="eoffice-dev-secret", session_cookie="EOFFICESESSID")
USERS = {"ravi": "ravi123"}
LETTERS = govletters.generate(100)
BY_ID = {L["id"]: L for L in LETTERS}
INBOX = sorted(LETTERS, key=lambda L: L["date"], reverse=True)

CSS = """body{font-family:Arial,Helvetica,sans-serif;font-size:13px;margin:0;background:#f2f4f7;color:#222}
.top{background:#00427a;color:#fff;padding:10px 16px;display:flex;justify-content:space-between;align-items:center}
.top b{font-size:17px}.top a{color:#fff}
.side{position:fixed;top:44px;left:0;bottom:0;width:170px;background:#e3e8ee;padding:10px}
.side a{display:block;padding:6px 8px;color:#00427a;text-decoration:none;border-radius:3px}.side a.on{background:#c7d3e0;font-weight:bold}
.main{margin-left:190px;padding:14px}.panel{background:#fff;border:1px solid #c9d2dc;padding:12px}
h2{font-size:15px;margin:0 0 10px;color:#00427a}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #d5dbe2;padding:5px 7px;text-align:left}th{background:#e8edf3}
tr:nth-child(even) td{background:#fafbfc}.btn{background:#00427a;color:#fff;padding:5px 12px;text-decoration:none;border-radius:2px}
.dummy{color:#a00;font-size:11px;margin-left:12px}"""


def page(title, body, request):
    u = request.session.get("user")
    return HTMLResponse(f"""<!doctype html><html><head><meta charset="utf-8"><title>{title} - e-Office (dummy)</title><style>{CSS}</style></head>
<body><div class="top"><b>e-Office <span class="dummy">DUMMY - TEST SYSTEM</span></b><span>{html.escape(u or '')} · Deputy Secretary (Admn)
 &nbsp; <a href="/logout">Logout</a></span></div>
<div class="side"><a class="on" href="/">Inbox (Receipts)</a><a href="#">Created</a><a href="#">Sent</a><a href="#">Closed</a><a href="#">Dispatch</a></div>
<div class="main">{body}</div></body></html>""")


def signed_in(request):
    return request.session.get("user") in USERS


@app.get("/login", response_class=HTMLResponse)
def login_form(err: int = 0, next: str = "/"):
    e = '<p style="color:#a00">Invalid credentials.</p>' if err else ""
    return HTMLResponse(f"""<!doctype html><html><head><meta charset="utf-8"><title>Sign in - e-Office (dummy)</title><style>{CSS}</style></head>
<body><div class="top"><b>e-Office <span class="dummy">DUMMY - TEST SYSTEM</span></b></div><div style="width:320px;margin:80px auto" class="panel">
<h2>Sign in</h2>{e}<form method="post" action="/login"><input type="hidden" name="next" value="{html.escape(next)}">
<p>User ID<br><input id="eo_user" name="u" style="width:100%"></p><p>Password<br><input id="eo_pass" type="password" name="p" style="width:100%"></p>
<p><input id="eo_login" type="submit" value="Sign in" class="btn"></p></form></div></body></html>""")


@app.post("/login")
async def login(request: Request):
    f = await request.form()
    if USERS.get(f.get("u")) != f.get("p"):
        return RedirectResponse("/login?err=1", status_code=303)
    request.session["user"] = f.get("u")
    return RedirectResponse(f.get("next") or "/", status_code=303)


@app.get("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


@app.get("/", response_class=HTMLResponse)
def inbox(request: Request, page_no: int = 1):
    if not signed_in(request):
        return RedirectResponse("/login", status_code=303)
    per = 20
    rows = INBOX[(page_no - 1) * per: page_no * per]
    trs = "".join(f"""<tr><td>{html.escape(L['receipt_no'])}</td><td>{L['date']}</td><td>{html.escape(L['sender_office'])}</td>
<td>{html.escape(L['subject'][:42])}{'…' if len(L['subject']) > 42 else ''}</td><td>{L['format']}</td>
<td><a href="/receipt/{L['id']}">View</a> · <a href="/receipt/{L['id']}/download">Download</a></td></tr>""" for L in rows)
    pages = (len(INBOX) + per - 1) // per
    pager = " ".join(f"<b>{i}</b>" if i == page_no else f'<a href="/?page_no={i}">{i}</a>' for i in range(1, pages + 1))
    return page("Inbox", f"""<div class="panel"><h2>Inbox - Receipts ({len(INBOX)})</h2><table>
<tr><th>Receipt No.</th><th>Received on</th><th>From</th><th>Subject</th><th>Category</th><th>Action</th></tr>{trs}</table>
<p>Page: {pager}</p></div>""", request)


@app.get("/receipt/{rid}", response_class=HTMLResponse)
def receipt(request: Request, rid: int):
    if not signed_in(request):
        return RedirectResponse(f"/login?next=/receipt/{rid}", status_code=303)
    L = BY_ID.get(rid)
    if not L:
        return page("Not found", '<div class="panel">No such receipt.</div>', request)
    return page(L["receipt_no"], f"""<div class="panel"><h2>Receipt {html.escape(L['receipt_no'])}</h2><table>
<tr><th>Received on</th><td>{L['date']}</td></tr><tr><th>From</th><td>{html.escape(L['sender_office'])}, {html.escape(L['sender_parent'])}</td></tr>
<tr><th>Category</th><td>{L['format']}</td></tr><tr><th>Subject</th><td>{html.escape(L['subject'][:60])}…</td></tr>
<tr><th>Communication</th><td>Electronic copy attached (PDF). <a class="btn" id="download" href="/receipt/{rid}/download">Download</a></td></tr></table></div>""",
                request)


@lru_cache(maxsize=200)
def _pdf(rid: int) -> bytes:
    return govletters.render_pdf(BY_ID[rid])


@app.get("/receipt/{rid}/download")
def download(request: Request, rid: int):
    if not signed_in(request):
        return RedirectResponse(f"/login?next=/receipt/{rid}", status_code=303)
    L = BY_ID.get(rid)
    if not L:
        return Response(status_code=404)
    return Response(_pdf(rid), media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{L["receipt_no"].split("/")[0]}.pdf"'})


@app.get("/api/receipts")
def receipts(request: Request):
    """The inbox list for the signed-in user (read by the assistant as the user)."""
    if not signed_in(request):
        return JSONResponse({"error": "not signed in"}, status_code=401)
    base = str(request.base_url).rstrip("/")
    return [{"id": L["id"], "receipt_no": L["receipt_no"], "date": L["date"], "from": L["sender_office"], "category": L["format"],
             "download": f"{base}/receipt/{L['id']}/download", "url": f"{base}/receipt/{L['id']}"} for L in INBOX]


@app.get("/debug/truth")
def truth():
    """Ground truth for tests: what each letter is (never shown to the assistant)."""
    return [{k: L[k] for k in ("id", "receipt_no", "intent", "format", "file_no", "date", "deadline", "sender_parent", "sender_office",
                               "signatory", "subject")} for L in LETTERS]
