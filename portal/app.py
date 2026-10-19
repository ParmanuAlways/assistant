"""A small stand-in for an intranet HR Leave Portal.

It signs people in through the company Keycloak (like a real intranet app would) and has
an ordinary server-rendered leave form. The browser agent has never been told the HTML of
this site: it has to read the page like a person would.
"""
import html
import os
import secrets
import sqlite3
from datetime import date
from urllib.parse import urlencode

import httpx
from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.middleware.sessions import SessionMiddleware

KC = os.environ.get("KC_URL", "http://keycloak.office.local:8080/realms/company")
BASE = os.environ.get("PORTAL_URL", "http://hr.office.local:8200")
CLIENT_ID, CLIENT_SECRET = "hr-portal", "hr-portal-secret"
DB = os.environ.get("PORTAL_DB", os.path.join(os.path.dirname(__file__), "portal.db"))

# The HR system's own employee master (separate from Keycloak, as in real life)
EMPLOYEES = {
    "ravi": {"emp_id": "EMP1042", "name": "Ravi Kumar", "department": "Engineering", "manager": "Priya Sharma",
             "balance": {"Casual Leave": 8, "Sick Leave": 6, "Earned Leave": 15}},
    "anita": {"emp_id": "EMP2001", "name": "Anita Desai", "department": "Internal Audit", "manager": "CFO Office",
              "balance": {"Casual Leave": 10, "Sick Leave": 6, "Earned Leave": 12}},
    "admin1": {"emp_id": "EMP0001", "name": "Arjun Mehta", "department": "IT", "manager": "CIO",
               "balance": {"Casual Leave": 10, "Sick Leave": 6, "Earned Leave": 20}},
}
LEAVE_TYPES = ["Casual Leave", "Sick Leave", "Earned Leave"]

app = FastAPI(title="HR Leave Portal")
app.add_middleware(SessionMiddleware, secret_key="portal-dev-secret", session_cookie="hrportal")


def db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.execute("""CREATE TABLE IF NOT EXISTS leaves (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT, username TEXT, emp_id TEXT, leave_type TEXT,
        from_date TEXT, to_date TEXT, days INTEGER, reason TEXT, emergency_contact TEXT, manager TEXT,
        status TEXT DEFAULT 'Pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP)""")
    return con


def page(title, body, user=None):
    nav = ""
    if user:
        nav = ('<nav><a href="/">Home</a> <a href="/leave/apply">Apply Leave</a> <a href="/leaves">My Leaves</a> '
               f'<a href="/profile">My Profile</a> <span class="who">{html.escape(user["name"])}</span> '
               '<a href="/logout">Logout</a></nav>')
    return HTMLResponse(f"""<!doctype html><html><head><meta charset="utf-8"><title>{title} – HR Portal</title>
<style>
body{{font-family:Arial,sans-serif;margin:0;background:#f3f5f9;color:#222}}
header{{background:#1d3c6e;color:#fff;padding:14px 24px;font-size:20px}}
nav{{background:#2b5291;padding:8px 24px}} nav a,nav span{{color:#fff;margin-right:16px;text-decoration:none}}
.who{{float:right}} main{{max-width:720px;margin:24px auto;background:#fff;padding:24px;border-radius:6px}}
label{{display:block;margin-top:12px;font-weight:bold}} .req{{color:#c00}}
input,select,textarea{{width:100%;padding:8px;margin-top:4px;box-sizing:border-box}}
button,.btn{{background:#1d3c6e;color:#fff;border:0;padding:10px 18px;margin-top:16px;border-radius:4px;
cursor:pointer;text-decoration:none;display:inline-block}}
.error{{background:#fde2e2;color:#900;padding:10px;border-radius:4px}}
.success{{background:#e1f5e4;color:#14532d;padding:10px;border-radius:4px}}
table{{width:100%;border-collapse:collapse}} td,th{{border:1px solid #ddd;padding:6px;text-align:left}}
</style></head><body><header>Acme Corp · HR Leave Portal</header>{nav}<main>{body}</main></body></html>""")


def current(request: Request):
    u = request.session.get("user")
    return {**EMPLOYEES[u], "username": u} if u in EMPLOYEES else None


@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    user = current(request)
    if not user:
        return page("Welcome", '<h2>Welcome to the HR Leave Portal</h2><p>Please sign in to continue.</p>'
                    '<a class="btn" href="/login">Login with Company SSO</a>')
    bal = "".join(f"<tr><td>{k}</td><td>{v}</td></tr>" for k, v in user["balance"].items())
    return page("Home", f'<h2>Hello, {html.escape(user["name"])}</h2><p>What would you like to do?</p>'
                f'<a class="btn" href="/leave/apply">Apply Leave</a> <a class="btn" href="/leaves">My Leaves</a>'
                f'<h3>Leave balance</h3><table><tr><th>Type</th><th>Days left</th></tr>{bal}</table>', user)


@app.get("/login")
def login(request: Request):
    state = secrets.token_urlsafe(16)
    request.session["state"] = state
    return RedirectResponse(f"{KC}/protocol/openid-connect/auth?" + urlencode({
        "client_id": CLIENT_ID, "response_type": "code", "scope": "openid profile",
        "redirect_uri": f"{BASE}/callback", "state": state}))


@app.get("/callback")
def callback(request: Request, code: str = "", state: str = ""):
    if not code or state != request.session.pop("state", None):
        return page("Error", '<p class="error">Sign-in failed. <a href="/login">Try again</a></p>')
    tok = httpx.post(f"{KC}/protocol/openid-connect/token", data={
        "grant_type": "authorization_code", "code": code, "redirect_uri": f"{BASE}/callback",
        "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET}).raise_for_status().json()
    info = httpx.get(f"{KC}/protocol/openid-connect/userinfo",
                     headers={"Authorization": f"Bearer {tok['access_token']}"}).raise_for_status().json()
    request.session["user"] = info["preferred_username"]
    return RedirectResponse("/", status_code=303)


@app.get("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/")


def leave_form(user, values=None, error=""):
    v = values or {}
    opts = '<option value="">-- Select --</option>' + "".join(
        f'<option{" selected" if v.get("leave_type") == t else ""}>{t}</option>' for t in LEAVE_TYPES)
    esc = lambda k: html.escape(v.get(k, ""))
    err = f'<p class="error">{html.escape(error)}</p>' if error else ""
    return page("Apply Leave", f"""<h2>Apply for Leave</h2>{err}
<form method="post" action="/leave/apply">
<label for="emp">Employee ID <span class="req">*</span></label>
<input id="emp" name="employee_id" required placeholder="e.g. EMP0000" value="{esc('employee_id')}">
<label for="ltype">Leave Type <span class="req">*</span></label>
<select id="ltype" name="leave_type" required>{opts}</select>
<label for="from">From Date <span class="req">*</span></label>
<input id="from" type="date" name="from_date" required value="{esc('from_date')}">
<label for="to">To Date <span class="req">*</span></label>
<input id="to" type="date" name="to_date" required value="{esc('to_date')}">
<label for="reason">Reason <span class="req">*</span></label>
<textarea id="reason" name="reason" required rows="3">{esc('reason')}</textarea>
<label for="contact">Emergency Contact Number <span class="req">*</span></label>
<input id="contact" type="tel" name="emergency_contact" required pattern="[0-9]{{10}}" placeholder="10-digit mobile" value="{esc('emergency_contact')}">
<label for="mgr">Reporting Manager <span class="req">*</span></label>
<input id="mgr" name="manager" required value="{esc('manager')}">
<button type="submit">Submit Leave Request</button>
</form>""", user)


@app.get("/leave/apply", response_class=HTMLResponse)
def apply_form(request: Request):
    user = current(request)
    return leave_form(user) if user else RedirectResponse("/")


@app.post("/leave/apply", response_class=HTMLResponse)
def apply_submit(request: Request, employee_id: str = Form(""), leave_type: str = Form(""),
                 from_date: str = Form(""), to_date: str = Form(""), reason: str = Form(""),
                 emergency_contact: str = Form(""), manager: str = Form("")):
    user = current(request)
    if not user:
        return RedirectResponse("/", status_code=303)
    values = dict(employee_id=employee_id, leave_type=leave_type, from_date=from_date, to_date=to_date,
                  reason=reason, emergency_contact=emergency_contact, manager=manager)
    try:
        f, t = date.fromisoformat(from_date), date.fromisoformat(to_date)
    except ValueError:
        return leave_form(user, values, "Please enter valid From and To dates.")
    if employee_id.strip().upper() != user["emp_id"]:
        return leave_form(user, values, "Employee ID does not match your account.")
    if leave_type not in LEAVE_TYPES:
        return leave_form(user, values, "Please select a leave type.")
    if t < f:
        return leave_form(user, values, "To Date cannot be before From Date.")
    if not (emergency_contact.isdigit() and len(emergency_contact) == 10):
        return leave_form(user, values, "Emergency contact must be a 10-digit number.")
    if not reason.strip() or not manager.strip():
        return leave_form(user, values, "Reason and Reporting Manager are required.")
    days = (t - f).days + 1
    con = db()
    cur = con.execute("""INSERT INTO leaves (username, emp_id, leave_type, from_date, to_date, days, reason,
        emergency_contact, manager) VALUES (?,?,?,?,?,?,?,?,?)""",
                      (user["username"], user["emp_id"], leave_type, from_date, to_date, days, reason.strip(),
                       emergency_contact, manager.strip()))
    ref = f"LR-{1000 + cur.lastrowid}"
    con.execute("UPDATE leaves SET ref=? WHERE id=?", (ref, cur.lastrowid))
    con.commit()
    return RedirectResponse(f"/leave/success/{ref}", status_code=303)


@app.get("/leave/success/{ref}", response_class=HTMLResponse)
def success(request: Request, ref: str):
    user = current(request)
    r = db().execute("SELECT * FROM leaves WHERE ref=? AND username=?", (ref, user and user["username"])).fetchone()
    if not r:
        return RedirectResponse("/")
    return page("Submitted", f'<p class="success">Leave request <b>{r["ref"]}</b> submitted successfully. '
                f'{r["days"]} day(s) of {r["leave_type"]} from {r["from_date"]} to {r["to_date"]}. '
                f'Status: {r["status"]} (sent to {html.escape(r["manager"])}).</p>'
                '<a class="btn" href="/leaves">View My Leaves</a>', user)


@app.get("/leaves", response_class=HTMLResponse)
def my_leaves(request: Request):
    user = current(request)
    if not user:
        return RedirectResponse("/")
    rows = db().execute("SELECT * FROM leaves WHERE username=? ORDER BY id DESC", (user["username"],)).fetchall()
    trs = "".join(f"<tr><td>{r['ref']}</td><td>{r['leave_type']}</td><td>{r['from_date']}</td><td>{r['to_date']}</td>"
                  f"<td>{r['days']}</td><td>{r['status']}</td></tr>" for r in rows) or '<tr><td colspan="6">No leave requests yet.</td></tr>'
    return page("My Leaves", "<h2>My Leaves</h2><table><tr><th>Ref</th><th>Type</th><th>From</th><th>To</th>"
                f"<th>Days</th><th>Status</th></tr>{trs}</table>", user)


@app.get("/profile", response_class=HTMLResponse)
def profile(request: Request):
    user = current(request)
    if not user:
        return RedirectResponse("/")
    rows = "".join(f"<tr><th>{k}</th><td>{html.escape(str(user[f]))}</td></tr>" for k, f in [
        ("Name", "name"), ("Employee ID", "emp_id"), ("Department", "department"), ("Reporting Manager", "manager")])
    return page("My Profile", f"<h2>My Profile</h2><table>{rows}</table>", user)


@app.get("/debug/leaves")
def debug_leaves():
    """Test hook only: lets the automated test check what really got saved."""
    return JSONResponse([dict(r) for r in db().execute("SELECT * FROM leaves ORDER BY id").fetchall()])
