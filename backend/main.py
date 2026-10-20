"""Office Assistant backend: auth, agent loop, per-user profiles, model settings, audit trail."""
import base64
import fnmatch
import ipaddress
import json
import os
import re
import socket
import time
import uuid
from datetime import date
from functools import lru_cache
from urllib.parse import urlparse

import httpx
import jwt
from cryptography.fernet import Fernet
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

import agent
import comms
import db
import skills

KC_ISSUER = os.environ.get("KC_ISSUER", "http://keycloak.office.local:8080/realms/company")
CLIENT_ID = os.environ.get("KC_CLIENT_ID", "browser-agent")
DEFAULT_MODEL_URL = os.environ.get("DEFAULT_MODEL_URL", "http://llm.office.local:9100/v1")
DEFAULT_MODEL_NAME = os.environ.get("DEFAULT_MODEL_NAME")  # e.g. "gemma4-e2b"; None = rule-based stand-in
SHOT_DIR = os.environ.get("SHOT_DIR", os.path.join(os.path.dirname(__file__), "screenshots"))
KEY_FILE = os.path.join(os.path.dirname(__file__), "secret.key")
TODAY_OVERRIDE = os.environ.get("AGENT_TODAY")  # lets tests pin "today"
WITH_CALENDAR = os.environ.get("AGENT_CALENDAR", "1") == "1"  # spell out the next 3 weeks in the prompt
# Structured output default for models that don't set their own: auto | schema | object | none
DEFAULT_JSON_MODE = os.environ.get("AGENT_JSON_MODE") or {"1": "schema", "0": "object"}.get(
    os.environ.get("AGENT_SCHEMA", ""), "auto")
# Answers that must never become profile facts, and fields that are one-off by nature
NON_ANSWER = re.compile(r"not sure|don'?t know|no idea|best judg|skip|n/?a\b|^\s*-?\s*$", re.I)
ONE_OFF_FIELD = re.compile(r"date|time|reason|purpose|quantity|amount|title|subject|description|comment|day", re.I)
SENSITIVE = ("password", "passwd", "pin", "otp", "cvv", "aadhaar", "pan_number", "account_number")

os.makedirs(SHOT_DIR, exist_ok=True)
if not os.path.exists(KEY_FILE):
    open(KEY_FILE, "wb").write(Fernet.generate_key())
fernet = Fernet(open(KEY_FILE, "rb").read())
con = db.init(DEFAULT_MODEL_URL, DEFAULT_MODEL_NAME)

app = FastAPI(title="Office Assistant API")
# Extension pages with host_permissions bypass CORS; this is for the browser-based admin pages.
app.add_middleware(CORSMiddleware, allow_origin_regex=r"chrome-extension://.*|moz-extension://.*",
                   allow_methods=["*"], allow_headers=["*"])


def enc(v):
    return fernet.encrypt(v.encode()).decode() if v else None


def dec(v):
    return fernet.decrypt(v.encode()).decode() if v else None


def today():
    return date.fromisoformat(TODAY_OVERRIDE) if TODAY_OVERRIDE else date.today()


def mask(obj):
    if isinstance(obj, dict):
        return {k: ("****" if any(s in str(k).lower() for s in SENSITIVE) else mask(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [mask(x) for x in obj]
    return obj


# ---------------------------------------------------------------- auth

@lru_cache
def jwks():
    return jwt.PyJWKClient(f"{KC_ISSUER}/protocol/openid-connect/certs")


class User(BaseModel):
    emp_id: str
    username: str
    name: str
    email: str = ""
    roles: list[str]
    claims: dict


def current_user(request: Request) -> User:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Not signed in")
    token = auth[7:]
    try:
        key = jwks().get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, key, algorithms=["RS256"], issuer=KC_ISSUER, options={"verify_aud": False})
    except Exception as e:
        raise HTTPException(401, f"Invalid token: {e}")
    if claims.get("azp") != CLIENT_ID:
        raise HTTPException(401, "Token was not issued to the Office Assistant")
    roles = claims.get("realm_access", {}).get("roles", [])
    u = User(emp_id=claims.get("emp_id") or claims["preferred_username"], username=claims["preferred_username"],
             name=claims.get("name", claims["preferred_username"]), email=claims.get("email", ""),
             roles=roles, claims=claims)
    known = con.execute("SELECT 1 FROM users WHERE emp_id=?", (u.emp_id,)).fetchone()
    con.execute("INSERT OR REPLACE INTO users VALUES (?,?,?,?,?,?)",
                (u.emp_id, u.username, u.name, u.email, json.dumps(roles), db.now()))
    # Directory details flow into the profile automatically (source = directory)
    for field, value in {"name": u.name, "employee_id": u.emp_id, "email": u.email,
                         "department": claims.get("department"), "manager": claims.get("manager"),
                         "phone": claims.get("phone")}.items():
        if value:
            con.execute("""INSERT INTO user_profile VALUES (?,?,?, 'directory', ?)
                ON CONFLICT(emp_id, field) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                WHERE user_profile.source='directory'""", (u.emp_id, field, value, db.now()))
    con.commit()
    if not known:
        db.log_event(con, u.emp_id, "first_login", {"username": u.username, "roles": roles})
    return u


def require(role):
    def dep(u: User = Depends(current_user)):
        if role not in u.roles:
            raise HTTPException(403, f"Requires role '{role}'")
        return u
    return dep


def directory_lookup(goal: str) -> list[dict]:
    """Colleagues named in the request, from the company directory (Keycloak/AD), so the model never guesses
    email addresses. Searches each capitalised word of the goal."""
    names = {w for w in re.findall(r"\b[A-Z][a-z]{2,}\b", goal)} - {"Send", "Reply", "Forward", "Find", "Move", "Email",
                                                                    "Apply", "Book", "Order", "Register", "Raise", "Claim"}
    if not names:
        return []
    try:
        tok = httpx.post(f"{KC_ISSUER}/protocol/openid-connect/token", timeout=10, data={
            "grant_type": "client_credentials", "client_id": "assistant-backend",
            "client_secret": os.environ.get("KC_BACKEND_SECRET", "assistant-backend-secret")}).json()["access_token"]
        admin = KC_ISSUER.replace("/realms/", "/admin/realms/")
        found = {}
        for n in names:
            for u in httpx.get(f"{admin}/users", params={"search": n, "max": 5}, timeout=10,
                               headers={"Authorization": f"Bearer {tok}"}).json():
                if u.get("email") and not u["username"].startswith("service-account"):
                    found[u["email"]] = {"name": f"{u.get('firstName', '')} {u.get('lastName', '')}".strip(),
                                         "email": u["email"]}
        return list(found.values())
    except Exception:
        return []


def get_profile(emp_id):
    return {r["field"]: r["value"] for r in con.execute("SELECT field, value FROM user_profile WHERE emp_id=?", (emp_id,))}


@app.get("/api/me")
def me(u: User = Depends(current_user)):
    return {"emp_id": u.emp_id, "username": u.username, "name": u.name, "email": u.email, "roles": u.roles}


# ---------------------------------------------------------------- profile

@app.get("/api/profile")
def profile(u: User = Depends(current_user)):
    return [dict(r) for r in con.execute(
        "SELECT field, value, source, updated_at FROM user_profile WHERE emp_id=? ORDER BY field", (u.emp_id,))]


@app.put("/api/profile")
def update_profile(body: dict, u: User = Depends(current_user)):
    for field, value in body.items():
        field = re.sub(r"[^a-z0-9_]", "_", field.lower())
        con.execute("INSERT OR REPLACE INTO user_profile VALUES (?,?,?, 'user', ?)", (u.emp_id, field, str(value), db.now()))
    con.commit()
    db.log_event(con, u.emp_id, "profile_updated", mask({"fields": body}))
    return profile(u)


@app.delete("/api/profile/{field}")
def delete_profile_field(field: str, u: User = Depends(current_user)):
    con.execute("DELETE FROM user_profile WHERE emp_id=? AND field=?", (u.emp_id, field))
    con.commit()
    db.log_event(con, u.emp_id, "profile_field_deleted", {"field": field})
    return {"ok": True}


# ---------------------------------------------------------------- model settings

def policy():
    p = dict(con.execute("SELECT * FROM admin_policy WHERE id=1").fetchone())
    p["allowed_model_hosts"] = json.loads(p["allowed_model_hosts"])
    p["allowed_sites"] = json.loads(p["allowed_sites"])
    p["allow_custom_endpoints"] = bool(p["allow_custom_endpoints"])
    return p


def host_allowed(url, rules):
    host = urlparse(url).hostname
    if not host or urlparse(url).scheme not in ("http", "https"):
        return False
    try:
        ip = ipaddress.ip_address(socket.gethostbyname(host))
    except OSError:
        ip = None
    for rule in rules:
        if "/" in rule:
            if ip and ip in ipaddress.ip_network(rule, strict=False):
                return True
        elif fnmatch.fnmatch(host, rule):
            return True
    return False


def provider_row(pid):
    return con.execute("SELECT * FROM model_providers WHERE id=? AND enabled=1", (pid,)).fetchone()


def provider_cfg(p, temperature=0.2):
    return {"name": p["name"], "url": p["base_url"], "model": p["model"], "key": dec(p["api_key_enc"]),
            "vision": bool(p["supports_vision"]), "temperature": temperature, "provider_id": p["id"],
            "json_mode": (p["json_mode"] if p["json_mode"] not in (None, "", "auto") else DEFAULT_JSON_MODE),
            "context_tokens": p["context_tokens"] or 8192}


def default_model_cfg():
    return provider_cfg(con.execute("SELECT * FROM model_providers WHERE is_default=1 AND enabled=1").fetchone())


def model_cfg(emp_id):
    s = con.execute("SELECT * FROM user_settings WHERE emp_id=?", (emp_id,)).fetchone()
    temp = s["temperature"] if s else 0.2
    if s and s["custom_url"] and policy()["allow_custom_endpoints"]:
        return {"name": "Custom endpoint", "url": s["custom_url"], "model": s["custom_model"],
                "key": dec(s["custom_key_enc"]), "vision": False, "temperature": temp, "provider_id": None,
                "json_mode": DEFAULT_JSON_MODE, "context_tokens": 8192}
    if s and s["provider_id"] and (p := provider_row(s["provider_id"])):
        return provider_cfg(p, temp)
    return {**default_model_cfg(), "temperature": temp}


@app.get("/api/models")
def models(u: User = Depends(current_user)):
    rows = con.execute("SELECT id, name, base_url, model, supports_vision, is_default, note FROM model_providers WHERE enabled=1")
    return {"models": [dict(r) for r in rows], "allow_custom_endpoints": policy()["allow_custom_endpoints"]}


@app.get("/api/settings")
def get_settings(u: User = Depends(current_user)):
    s = con.execute("SELECT * FROM user_settings WHERE emp_id=?", (u.emp_id,)).fetchone()
    cfg = model_cfg(u.emp_id)
    return {"provider_id": s["provider_id"] if s else None, "custom_url": s["custom_url"] if s else None,
            "custom_model": s["custom_model"] if s else None, "has_custom_key": bool(s and s["custom_key_enc"]),
            "temperature": s["temperature"] if s else 0.2, "active": {k: cfg[k] for k in ("name", "url", "model")}}


class SettingsIn(BaseModel):
    mode: str = "list"            # list | custom
    provider_id: int | None = None
    custom_url: str | None = None
    custom_model: str | None = None
    api_key: str | None = None
    temperature: float = 0.2


def validate_settings(body: SettingsIn):
    if body.mode == "custom":
        pol = policy()
        if not pol["allow_custom_endpoints"]:
            raise HTTPException(403, "Your administrator has not allowed custom model endpoints.")
        if not body.custom_url or not body.custom_model:
            raise HTTPException(400, "Custom endpoint needs a URL and a model name.")
        if not host_allowed(body.custom_url, pol["allowed_model_hosts"]):
            raise HTTPException(403, f"{urlparse(body.custom_url).hostname} is not an allowed model host "
                                     f"(allowed: {', '.join(pol['allowed_model_hosts'])}).")
    elif body.provider_id is not None and not provider_row(body.provider_id):
        raise HTTPException(400, "Unknown model.")


@app.put("/api/settings")
def put_settings(body: SettingsIn, u: User = Depends(current_user)):
    validate_settings(body)
    before = get_settings(u)["active"]
    old = con.execute("SELECT custom_key_enc FROM user_settings WHERE emp_id=?", (u.emp_id,)).fetchone()
    custom = body.mode == "custom"
    key_enc = enc(body.api_key) if body.api_key else (old["custom_key_enc"] if old and custom else None)
    con.execute("INSERT OR REPLACE INTO user_settings VALUES (?,?,?,?,?,?,?)", (
        u.emp_id, None if custom else body.provider_id, body.custom_url if custom else None,
        body.custom_model if custom else None, key_enc if custom else None, body.temperature, db.now()))
    con.commit()
    after = get_settings(u)["active"]
    db.log_event(con, u.emp_id, "settings_changed", {"from": before, "to": after, "temperature": body.temperature})
    return get_settings(u)


@app.post("/api/settings/test")
def test_settings(body: SettingsIn, u: User = Depends(current_user)):
    validate_settings(body)
    if body.mode == "custom":
        cfg = {"url": body.custom_url, "model": body.custom_model, "key": body.api_key}
    elif body.provider_id:
        p = provider_row(body.provider_id)
        cfg = {"url": p["base_url"], "model": p["model"], "key": dec(p["api_key_enc"])}
    else:
        cfg = default_model_cfg()
    cfg = {"json_mode": DEFAULT_JSON_MODE, "context_tokens": 8192, **cfg}
    t0 = time.time()
    try:
        reply = agent.call_model(cfg, [{"role": "user", "content": "Reply with the single word OK."}], timeout=120,
                                 json_mode=False)
        ms = int((time.time() - t0) * 1000)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
    try:  # optional: find out which structured-output mode and roles this server supports
        agent.call_model(cfg, [{"role": "system", "content": agent.SYSTEM_PROMPT}, {"role": "user", "content":
                         "The task is already complete. Reply with the done action."}], timeout=180)
        caps = agent.capabilities(cfg)
        return {"ok": True, "ms": ms, "reply": reply[:200], "structured_output": caps["json"],
                "system_role": caps["system"]}
    except Exception:
        return {"ok": True, "ms": ms, "reply": reply[:200], "structured_output": None, "system_role": None}


# ---------------------------------------------------------------- agent tasks

class TaskIn(BaseModel):
    prompt: str
    url: str | None = None


@app.post("/api/tasks")
def create_task(body: TaskIn, request: Request, u: User = Depends(current_user)):
    task_id = str(uuid.uuid4())
    cfg = model_cfg(u.emp_id)
    con.execute("""INSERT INTO tasks (task_id, emp_id, user_name, prompt, site, status, model, model_url, client_ip,
        user_agent, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (task_id, u.emp_id, u.name, body.prompt, urlparse(body.url or "").hostname, "running",
                 cfg["model"], cfg["url"], request.client.host if request.client else None,
                 request.headers.get("user-agent"), db.now()))
    con.commit()
    db.log_event(con, u.emp_id, "user_message", {"prompt": body.prompt, "model": cfg["model"], "model_url": cfg["url"]},
                 task_id=task_id, url=body.url)
    return {"task_id": task_id, "model": cfg["name"]}


def own_task(task_id, u: User):
    t = con.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
    if not t or t["emp_id"] != u.emp_id:
        raise HTTPException(404, "Task not found")
    return t


def history_for_model(task_id):
    """Earlier steps of this task, condensed for the prompt."""
    out = []
    for r in con.execute("SELECT event_type, payload FROM events WHERE task_id=? ORDER BY seq", (task_id,)):
        p = json.loads(r["payload"])
        if r["event_type"] == "model_action":
            a = p["action"]
            out.append({"did": {k: a[k] for k in ("action", "id", "value", "url", "question", "field", "fields") if k in a},
                        "on": p.get("element")})
        elif r["event_type"] == "action_result":
            out.append({"result": p})
        elif r["event_type"] == "user_answer":
            out.append({"user_answered": {"field": p.get("field"), "question": p.get("question"), "answer": p.get("answer")}})
    return out


class StepIn(BaseModel):
    page: dict
    last_result: dict | None = None
    user_answer: dict | None = None
    screenshot_b64: str | None = None   # sent when the backend asked for one (vision fallback)


PLAN_ON = os.environ.get("AGENT_PLAN", "1") == "1"
WORKFLOW_ON = os.environ.get("AGENT_WORKFLOWS", "1") == "1"
LAST_PAGE_TEXT: dict[str, str] = {}   # task_id -> page text seen before the latest action
TASK_STATE: dict[str, dict] = {}      # task_id -> working memory (plan, workflow replay, sign-out, failures)
FAIL_FIX = "The model did not give a usable answer."


def is_login_page(page: dict) -> bool:
    return any(e.get("type") == "password" for e in page.get("elements", []))


def where_am_i(page: dict) -> str:
    """The URL that best says where the work is: the main frame of a frameset, else the page."""
    for f in page.get("frames") or []:
        name, _, url = f.partition(": ")
        if name in ("main", "content", "body", "workspace"):
            return url
    return page.get("url") or ""


def task_values(task_id):
    """What the user answered and what the assistant typed in this task (for value provenance)."""
    answers, typed = [], []
    for r in con.execute("SELECT event_type, payload FROM events WHERE task_id=? AND event_type IN "
                         "('user_answer','model_action')", (task_id,)):
        p = json.loads(r["payload"])
        if r["event_type"] == "user_answer":
            answers.append(str(p.get("answer") or ""))
        else:
            a = p.get("action") or {}
            if a.get("value"):
                typed.append(str(a["value"]))
            typed += [str(f.get("value")) for f in a.get("fields") or []]
    return answers, typed


def build_confirmation(task_id, t, page, confirm, profile):
    """Adds where each value came from and the pre-submit checks to a confirmation."""
    answers, typed = task_values(task_id)
    confirm["fields"] = agent.provenance(confirm["fields"], t["prompt"], profile, answers, typed, today())
    confirm["checks"] = agent.verify_submission(t["prompt"], confirm["fields"], today(), confirm.get("row", ""),
                                                page.get("text") or "")
    confirm["fields"] = [{k: v for k, v in f.items() if not k.startswith("_")} for f in confirm["fields"]]
    return confirm


@app.post("/api/tasks/{task_id}/step")
def step(task_id: str, body: StepIn, u: User = Depends(current_user)):
    t = own_task(task_id, u)
    if t["status"] != "running":
        raise HTTPException(409, f"Task is {t['status']}")
    pol = policy()
    if t["steps"] >= pol["max_steps"]:
        return finish_internal(task_id, u, "failed", f"Stopped after {pol['max_steps']} steps.", act_only=True)
    st = TASK_STATE.setdefault(task_id, {"fails": 0})
    page = body.page
    for el in page.get("elements", []):        # passwords never leave the browser, but be sure
        if el.get("type") == "password":
            el["value"] = ""
    if body.last_result is not None:
        # Check what the action changed, so the model sees the effect, not just "clicked"
        res = mask(body.last_result)
        observed = []
        if where_am_i(page) != st.get("last_where"):
            observed.append(f"now on {page.get('title') or ''} {where_am_i(page)}".strip())
        if page.get("errors"):
            observed.append("errors shown: " + " | ".join(page["errors"])[:300])
        elif where_am_i(page) == st.get("last_where"):
            # same page: say what appeared ("Selected seat: C3", "Item added"), so the effect of the action is visible
            new = agent.text_added(LAST_PAGE_TEXT.get(task_id) or "", page.get("text") or "")
            if new:
                observed.append("the page now shows: " + new)
        last_kind = (con.execute("SELECT payload FROM events WHERE task_id=? AND event_type='model_action' ORDER BY seq DESC "
                                 "LIMIT 1", (task_id,)).fetchone() or {"payload": "{}"})["payload"]
        if ('"action": "click"' in last_kind and (page.get("text") or "") == LAST_PAGE_TEXT.get(task_id)
                and not res.get("dialog")):
            observed.append("the page did not change")   # (typing changes field values, not the page text)
        if observed:
            res["observed"] = "; ".join(observed)
        db.log_event(con, u.emp_id, "action_result", res, task_id=task_id, url=page.get("url"))
        st["fails"] = 0 if body.last_result.get("ok") and not page.get("errors") else st["fails"] + 1
    if body.user_answer:
        ans = body.user_answer
        db.log_event(con, u.emp_id, "user_answer", mask(ans), task_id=task_id, url=page.get("url"))
        field = re.sub(r"[^a-z0-9_]", "_", (ans.get("field") or "").lower())
        if (ans.get("remember") and field and field != "user_action" and ans.get("answer")
                and not NON_ANSWER.search(ans["answer"]) and not ONE_OFF_FIELD.search(field)):
            con.execute("INSERT OR REPLACE INTO user_profile VALUES (?,?,?, 'learned', ?)",
                        (u.emp_id, field, ans["answer"], db.now()))
            con.commit()
            db.log_event(con, u.emp_id, "profile_learned", mask({"field": field, "value": ans["answer"]}), task_id=task_id)
    shot_name = None
    if body.screenshot_b64:
        shot_name = f"{task_id}-{uuid.uuid4().hex[:8]}.png"
        open(os.path.join(SHOT_DIR, shot_name), "wb").write(base64.b64decode(body.screenshot_b64.split(",")[-1]))
    db.log_event(con, u.emp_id, "page_snapshot", {
        "title": page.get("title"), "text_excerpt": (page.get("text") or "")[:600], "notices": page.get("notices"),
        "errors": page.get("errors"), "frames": page.get("frames"), "popup": page.get("popup"),
        "elements": [{k: e.get(k) for k in ("id", "tag", "type", "label", "text", "value", "required", "frame", "menu", "row")}
                     for e in page.get("elements", [])][:80]}, task_id=task_id, url=page.get("url"), screenshot=shot_name)

    host = urlparse(page.get("url") or "").hostname or ""
    on_allowed_site = any(fnmatch.fnmatch(host, s) for s in pol["allowed_sites"])
    if host and not on_allowed_site and t["steps"] > 0:
        return finish_internal(task_id, u, "failed", f"Stopped: {host} is not an allowed site.", act_only=True)
    playbooks = [dict(r) for r in con.execute("SELECT id, site, task, steps, source, macro FROM site_playbooks WHERE status='active'")]
    all_playbooks = playbooks
    if any(p["source"] == "teach" for p in playbooks):
        playbooks = agent.select_playbooks(playbooks, t["prompt"], host)
    playbooks = [{k: p[k] for k in ("site", "task", "steps")} for p in playbooks]
    for link in con.execute("SELECT title, url FROM user_links WHERE emp_id=?", (u.emp_id,)):
        h = urlparse(link["url"]).hostname or ""
        if any(fnmatch.fnmatch(h, s) for s in pol["allowed_sites"]):
            playbooks.append({"site": h, "task": f"{link['title']} (the user's saved app)", "steps": f"Start URL: {link['url']}"})
    profile = get_profile(u.emp_id)
    if colleagues := directory_lookup(t["prompt"]):
        profile["colleagues_from_company_directory"] = colleagues
    cfg = model_cfg(u.emp_id)
    extra = []

    # Signed out in the middle of a task (session expiry): remember where we were, resume after sign-in
    same_site = urlparse(st.get("last_good") or "").hostname == host
    if is_login_page(page):
        if t["steps"] > 0 and same_site and not st.get("signed_out"):   # bounced to sign-in inside the same site
            st["signed_out"], st["resume_at"] = True, st.get("last_good")
            db.log_event(con, u.emp_id, "signed_out_detected", {"resume_at": st["resume_at"]}, task_id=task_id)
    else:
        if st.pop("signed_out", False) and st.get("resume_at"):
            st["resume_note"] = 4
        st["last_good"] = where_am_i(page)
    if st.get("resume_note"):
        st["resume_note"] -= 1
        extra.append(f"NOTE: the site signed you out during the task and the user signed in again. Continue where you "
                     f"were: {st['resume_at']} (navigate there if needed). Values typed before may be lost: check the form.")

    # First step: a workflow seen before (taught, or a past success), else a short plan
    if t["steps"] == 0 and "workflow" not in st:
        st["workflow"] = skills.pick_workflow(con, t["prompt"], all_playbooks) if WORKFLOW_ON else None
        if st["workflow"]:
            db.log_event(con, u.emp_id, "workflow_selected", {"source": st["workflow"]["source"],
                                                              "label": st["workflow"]["label"],
                                                              "steps": st["workflow"]["steps"]}, task_id=task_id)
        elif PLAN_ON:
            try:
                plan_msgs = agent.build_messages(t["prompt"], profile, playbooks, [], page, today(), WITH_CALENDAR,
                                                 cfg["context_tokens"])
                plan_msgs[0] = {"role": "system", "content": agent.PLAN_PROMPT}
                plan_msgs[1]["content"] = plan_msgs[1]["content"].replace("Reply with the next action as one JSON object.",
                                                                          "Reply with the plan as one JSON object.")
                st["plan"] = agent.parse_plan(agent.call_model(cfg, plan_msgs, schema=agent.PLAN_SCHEMA))
                db.log_event(con, u.emp_id, "plan", {"steps": st["plan"]}, task_id=task_id)
            except Exception as e:
                db.log_event(con, u.emp_id, "plan_skipped", {"error": str(e)[:200]}, task_id=task_id)
    if st.get("plan"):
        extra.append("PLAN (made at the start; adapt it if the page differs):\n" +
                     "\n".join(f"{i + 1}. {x}" for i, x in enumerate(st["plan"])))

    wf = st.get("workflow")
    macro_act = None
    if wf and not is_login_page(page) and not page.get("errors"):
        macro_act, wf_hint = skills.suggest(wf, page, host)
        if wf_hint:
            extra.append(wf_hint)
        if wf.get("misses", 0) >= 6:
            db.log_event(con, u.emp_id, "workflow_drift", {"source": wf["source"], "cursor": wf["cursor"]}, task_id=task_id)
            st["drift"] = 1
            st["workflow"] = wf = None
            macro_act = None
    vision_ok = cfg.get("vision") or os.environ.get("AGENT_VISION") == "1"
    image = body.screenshot_b64 if body.screenshot_b64 and vision_ok else None
    messages = agent.build_messages(t["prompt"], profile, playbooks, history_for_model(task_id),
                                    page, today(), WITH_CALENDAR, cfg["context_tokens"], extra, image)
    act, reply, used = None, "", cfg
    fix = st.get("fix_field")
    if fix and body.user_answer and body.user_answer.get("field") == fix["field"]:
        st.pop("fix_field")
        ans = str(body.user_answer.get("answer") or "").strip()
        target = next((e for e in page.get("elements", []) if (e.get("label") or "") == fix["label"]), None)
        if target and ans and not NON_ANSWER.search(ans):
            macro_act = {"action": "select" if target["tag"] == "select" else "type", "id": target["id"], "value": ans,
                         "thought": f"Entering the {fix['label']} you gave me."}
    drawing = next((e for e in page.get("elements", []) if e.get("type") == "drawing" and e.get("rect")), None)
    if image and drawing and st.pop("vision_reason", None) == "drawing":
        try:
            macro_act, target = agent.locate_in_drawing(cfg, t["prompt"], image, drawing, st.get("last_target", ""))
            db.log_event(con, u.emp_id, "vision_locate", {"target": target, "action": macro_act}, task_id=task_id)
            st["last_target"] = target if macro_act else st.get("last_target", "")
        except Exception as e:
            db.log_event(con, u.emp_id, "model_error", {"where": "vision_locate", "error": str(e)[:200]}, task_id=task_id)
    if macro_act:
        act, reply = macro_act, json.dumps({k: v for k, v in macro_act.items() if not k.startswith("_")})
    else:
        try:
            reply = agent.call_model(cfg, messages)
        except Exception as e:
            fallback = default_model_cfg()
            db.log_event(con, u.emp_id, "model_error", {"model": cfg["model"], "url": cfg["url"], "error": str(e)[:300],
                                                         "fallback": fallback["model"] if fallback["url"] != cfg["url"] else None},
                         task_id=task_id)
            if fallback["url"] == cfg["url"]:
                return finish_internal(task_id, u, "failed", f"Model unavailable: {e}", act_only=True)
            used = fallback
            reply = agent.call_model(used, messages)
        try:
            act = agent.parse_action(reply)
        except Exception as e:  # one retry with the error shown to the model
            db.log_event(con, u.emp_id, "model_parse_error", {"error": str(e)[:200], "reply": reply[:500]}, task_id=task_id)
            messages += [{"role": "assistant", "content": reply},
                         {"role": "user", "content": f"That was not valid ({e}). Reply with ONE JSON object only."}]
            reply = agent.call_model(used, messages)
            try:
                act = agent.parse_action(reply)
            except Exception as e2:
                db.log_event(con, u.emp_id, "model_parse_error", {"error": str(e2)[:200], "reply": reply[:500]}, task_id=task_id)
                act = {"action": "fail", "summary": FAIL_FIX, "thought": ""}

    def correct(note, event):
        nonlocal messages
        db.log_event(con, u.emp_id, event, {"action": act, "note": note}, task_id=task_id)
        messages += [{"role": "assistant", "content": json.dumps({k: v for k, v in act.items() if not k.startswith("_")})},
                     {"role": "user", "content": note}]
        try:
            return agent.parse_action(agent.call_model(used, messages))
        except Exception:
            return {"action": "fail", "summary": FAIL_FIX, "thought": ""}

    by_id = {e["id"]: e for e in page.get("elements", [])}
    ID_ACTIONS = ("click", "type", "select", "pick_date", "autocomplete", "upload", "hover")

    # Recover from an element number that is not on the page (once), instead of giving up
    if act["action"] in ID_ACTIONS and act.get("id") not in by_id:
        act = correct(f"Element [{act.get('id')}] is not on this page. Choose an element from the ELEMENTS list "
                      "(or navigate / ask_user).", "element_not_found")
    if act["action"] == "fill_form":
        act["fields"] = [f for f in act.get("fields", []) if f["id"] in by_id and str(f.get("value", "")).strip()]
        if not act["fields"]:
            act = correct("Those element numbers are not on this page or the values are empty. Use element numbers "
                          "from the ELEMENTS list, or ask_user for values you don't know.", "element_not_found")
    if act["action"] == "click_xy" and not image:
        act = correct("click_xy is only possible with a screenshot. Use an element number from the list.", "element_not_found")

    # Loop guard: the same action again on an unchanged page means the model is stuck
    # Same action on the same element of the same page; element numbers alone are reused across pages
    def sig(a, el=None, page_url=None):
        el = el or {}
        return json.dumps({"action": a.get("action"), "value": a.get("value"), "url": a.get("url"),
                           "fields": a.get("fields"),
                           "el": [el.get("tag"), el.get("text"), el.get("label")], "page": page_url}, sort_keys=True)
    recent = []
    for r in con.execute("SELECT url, payload FROM events WHERE task_id=? AND event_type='model_action' "
                         "ORDER BY seq DESC LIMIT 2", (task_id,)):
        p = json.loads(r["payload"])
        recent.append(sig(p["action"], p.get("element"), r["url"]))
    cur_sig = lambda a: sig(a, by_id.get(a.get("id")), page.get("url"))
    page_unchanged = (page.get("text") or "") == LAST_PAGE_TEXT.get(task_id)   # a real repeat changed nothing
    looped = False
    if act["action"] not in ("done", "fail", "ask_user") and recent and recent[0] == cur_sig(act) and page_unchanged:
        looped = True
        db.log_event(con, u.emp_id, "loop_detected", {"repeated": act}, task_id=task_id)
        if wf:   # a replayed step that doesn't work: stop replaying, let the model decide
            st["workflow"] = wf = None
            st["drift"] = 1
        if len(recent) > 1 and recent[1] == cur_sig(act):
            act = {"action": "fail", "summary": "Stopped: the assistant kept repeating the same step.", "thought": ""}
        else:
            act = correct("You already did exactly that in the previous step and the page is as shown. "
                          "Choose a DIFFERENT action that makes progress (e.g. click a link or fill a field).", "loop_correction")
            if cur_sig(act) == recent[0]:   # corrected, yet the same action again: never execute it twice
                act = {"action": "fail", "summary": "Stopped: the assistant kept repeating the same step.", "thought": ""}

    # Reality checks: a claimed success must be visible on the page, and forms must be complete
    # before we ask the user to confirm. One correction round each; then report honestly.
    submitted_something = went_through(task_id)
    # Claims of having changed something need proof on the page; "find X and tell me" answers don't
    claims_change = act["action"] == "done" and (submitted_something or agent.claims_action(act.get("summary", "")))
    prev_text = LAST_PAGE_TEXT.get(task_id, "")
    if act["action"] == "done" and submitted_something and not agent.page_shows_success(page, prev_text):
        # It did act (the user confirmed), but the site shows no confirmation. Never push the model to act
        # again here: that can repeat a destructive action. Report honestly and let the person check.
        db.log_event(con, u.emp_id, "done_unverified", {"action": act}, task_id=task_id)
        act = {"action": "done", "unverified": True, "thought": act.get("thought", ""),
               "summary": f"{act.get('summary', '')} — note: the site did not show a confirmation message, "
                          "please check that it went through."}
    elif claims_change and not agent.page_shows_success(page, prev_text):
        act = correct("The current page does NOT show any success message or reference number, so the task is not done. "
                      "Look at the page again and continue (fill missing fields, then submit).", "done_rejected")
        if act["action"] == "done" and agent.claims_action(act.get("summary", "")) \
                and not agent.page_shows_success(page, prev_text):
            act = {"action": "fail", "summary": "Could not confirm the task was completed: the site shows no success "
                                                "message. Please check the page.", "thought": ""}
    if agent.needs_confirmation(act, page) and (missing := agent.missing_required(page)):
        act = correct(f"Do not submit yet. These required fields are still empty: {', '.join(missing)}. Fill them first, "
                      "or use ask_user if you don't know the value.", "submit_blocked_incomplete")
        if agent.needs_confirmation(act, page) and (missing := agent.missing_required(page)):
            # Still trying to submit an incomplete form: get the value from the person and fill it in
            # ourselves (the model has shown it won't). Never ask the same question twice.
            answered = {}
            for r in con.execute("SELECT payload FROM events WHERE task_id=? AND event_type='user_answer'", (task_id,)):
                a = json.loads(r["payload"])
                answered[a.get("field")] = a.get("answer")
            slug = lambda label: "fill_" + re.sub(r"[^a-z0-9]+", "_", (label or "").lower()).strip("_")
            fields = agent.missing_required_fields(page)
            known = next((e for e in fields if answered.get(slug(e.get("label")))
                          and not NON_ANSWER.search(answered[slug(e.get("label"))])), None)
            if known:
                act = {"action": "select" if known["tag"] == "select" else "type", "id": known["id"],
                       "value": answered[slug(known.get("label"))], "thought": "Filling in the value you gave me."}
            elif fields and slug(fields[0].get("label")) not in answered:
                act = {"action": "ask_user", "field": slug(fields[0].get("label")),
                       "question": f"What should I enter for '{fields[0].get('label')}'?", "remember": False,
                       "thought": "A required field is still empty."}
            else:
                act = {"action": "fail", "summary": f"Could not complete the form: {', '.join(missing)} still empty.",
                       "thought": ""}
    # Pre-submit verifier: what the request spells out (dates, amounts, IDs) must be on the form. One correction.
    if agent.needs_confirmation(act, page) and (fix := agent.row_fix(act, page, t["prompt"], today())):
        db.log_event(con, u.emp_id, "row_corrected", {"from": act, "to": fix}, task_id=task_id)
        act = fix
    if (c := agent.needs_confirmation(act, page)):
        answers, typed = task_values(task_id)
        prov = agent.provenance(c["fields"], t["prompt"], profile, answers, typed, today())
        bad = next((f for f in prov if f.get("_reference") or
                    (f.get("_profile_key") and not agent.profile_fits(f["_profile_key"], f.get("label") or ""))), None)
        asked = st.setdefault("fix_asked", set())
        if bad and bad.get("label") and bad["label"] not in asked:
            # e.g. the user's own phone in "Emergency Contact Number", or "my desk" as a desk number: ask for that value
            asked.add(bad["label"])
            field = re.sub(r"[^a-z0-9]+", "_", bad["label"].lower()).strip("_")
            st["fix_field"] = {"field": field, "label": bad["label"]}
            db.log_event(con, u.emp_id, "presubmit_mismatch", {"action": act, "note": f"ask for {bad['label']}"}, task_id=task_id)
            act = {"action": "ask_user", "field": field, "question": f"What should I enter for '{bad['label']}'?",
                   "remember": not ONE_OFF_FIELD.search(field), "thought": f"\"{bad.get('value')}\" is not right for {bad['label']}."}
    if (c := agent.needs_confirmation(act, page)) and not st.get("verified_once"):
        checks = [x for x in build_confirmation(task_id, t, page, c, profile)["checks"] if "myself" not in x]
        if checks and drawing and vision_ok and st.get("vision_tries", 0) < 3 and any("selected" in x for x in checks):
            # the wrong thing is selected in the drawing (e.g. seat C2 instead of C3): look at it again
            st["vision_tries"] = st.get("vision_tries", 0) + 1
            st["vision_reason"] = "drawing"
            db.log_event(con, u.emp_id, "presubmit_mismatch", {"action": act, "note": " ".join(checks)}, task_id=task_id)
            act = {"action": "look", "thought": "The page does not show what you asked for yet: looking at the drawing again."}
            checks = []
        if checks:
            st["verified_once"] = True
            fixed = correct("Before submitting, check the form against the GOAL: " + " ".join(checks) +
                            " Fix the form (or, if it is right, click the same button again).", "presubmit_mismatch")
            if fixed["action"] != "fail":   # no usable fix: the user sees the checks in the confirmation instead
                act = fixed

    element = by_id.get(act.get("id"))
    # Mechanical fixes for common slips
    if act["action"] == "click" and element and element.get("type") == "file":
        act = {"action": "upload", "id": act["id"], "thought": act.get("thought", ""),
               "question": f"Which file should I attach for '{element.get('label') or 'the file field'}'?"}
    if act["action"] == "upload" and element and (not act.get("question") or re.search(r"ask the user|which file to", act["question"], re.I)):
        act["question"] = f"Which file should I attach for '{element.get('label') or 'the file field'}'?"
    if act["action"] == "type" and element and element.get("readonly") and agent.parse_dates(act.get("value", ""), today()):
        act = {**act, "action": "pick_date", "value": sorted(agent.parse_dates(act["value"], today()))[0]}
    if act["action"] in ("type", "select", "autocomplete", "pick_date") and element and not str(act.get("value", "")).strip():
        # An empty value means the model doesn't know it: ask the person instead of typing nothing
        label = element.get("label") or element.get("text") or "this field"
        field = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
        act = {"action": "ask_user", "field": field, "question": f"What should I enter for '{label}'?",
               "remember": not ONE_OFF_FIELD.search(field), "thought": "I don't know this value."}
    # Sign-in pages are the person's job (user name too): never fill them in, ask the user to sign in
    if is_login_page(page) and (act["action"] in ("type", "fill_form", "autocomplete") or
                                (act["action"] == "click" and element and element.get("type") == "submit")):
        act = {"action": "ask_user", "field": "user_action",
               "question": "Please sign in on the page yourself, then press Continue.",
               "thought": "Signing in is done by you; I never type sign-in details."}
        element = None
    blocked = None
    if act["action"] in ID_ACTIONS and not element:
        blocked = f"element [{act.get('id')}] is not on the page"
    elif act["action"] == "type" and element and element.get("type") == "password":
        act = {"action": "ask_user", "field": "user_action",
               "question": "This page needs your password. Please sign in on the page yourself, then press Continue.",
               "thought": "Assistant never types passwords."}
    elif act["action"] == "navigate" and not any(fnmatch.fnmatch(urlparse(act.get("url", "")).hostname or "", s)
                                                  for s in pol["allowed_sites"]):
        blocked = f"navigation to {act.get('url')} is outside the allowed sites"
    if blocked:
        act = {"action": "fail", "summary": f"Blocked by policy: {blocked}.", "thought": act.get("thought", "")}
    # Don't give up on the first obstacle (once per task): wrong page, a widget that needs another approach
    if act["action"] == "fail" and not act.get("summary", "").startswith(("Blocked", "Stopped", "Could not")) \
            and act.get("summary") != FAIL_FIX and not st.get("fail_retry") and t["steps"] < pol["max_steps"] - 2:
        st["fail_retry"] = True
        retry = correct("Do not give up yet. If this is the wrong page, navigate to the start URL in the SITE PLAYBOOKS. "
                        "If a field does not work, try another way (pick_date, autocomplete, the button or icon next to it, "
                        "a pop-up window). Reply fail only if there is really no way.", "fail_retry")
        if retry["action"] != "fail":
            act = retry
            element = by_id.get(act.get("id"))

    # Vision fallback: before giving up, or when the target is a drawing, look at a screenshot (vision models only)
    want_look = (act["action"] == "fail" and not act.get("summary", "").startswith(("Blocked", "Stopped"))) or \
        (act["action"] == "click" and (element or {}).get("type") == "drawing")
    if vision_ok and want_look and not image and st.get("vision_tries", 0) < 3:
        st["vision_tries"] = st.get("vision_tries", 0) + 1
        if (element or {}).get("type") == "drawing" or any(e.get("type") == "drawing" for e in page.get("elements", [])):
            st["vision_reason"] = "drawing"
        db.log_event(con, u.emp_id, "vision_fallback", {"instead_of": mask(act)}, task_id=task_id)
        act = {"action": "look", "thought": "Taking a screenshot to see the page."}
        element = None
        st["fails"] = max(st["fails"], 2)

    LAST_PAGE_TEXT[task_id] = page.get("text") or ""
    st["last_where"] = where_am_i(page)
    confirm = agent.needs_confirmation(act, page)
    if confirm and just_confirmed(task_id, element):
        confirm = None   # e.g. "Place order" then the site's own "Yes, place order" dialog: ask the user once
    if confirm:
        confirm = build_confirmation(task_id, t, page, confirm, profile)
        # Doing the same final action twice in one task (a second "Send") is almost always a mistake
        same = sum(1 for button, ok in approvals(task_id) if ok and button == confirm["button"])
        if same:
            confirm["warning"] = (f"You already approved \"{confirm['button']}\" {same} time(s) in this task. "
                                  "Approving again will do it again (for example, send a second email).")
    fields_info = None
    if act["action"] == "fill_form":
        fields_info = []
        for f in act["fields"]:
            e = by_id.get(f["id"], {})
            kind = "select" if e.get("tag") == "select" else "pick_date" if e.get("readonly") else "type"
            fields_info.append({"id": f["id"], "label": e.get("label") or e.get("text"), "kind": kind})
    from_workflow = "_macro_step" in act
    if wf:
        skills.advance(wf, act, element, fields_info)
    act = {k: v for k, v in act.items() if not k.startswith("_")}
    con.execute("UPDATE tasks SET steps=steps+1, model=?, model_url=? WHERE task_id=?", (used["model"], used["url"], task_id))
    con.commit()
    db.log_event(con, u.emp_id, "model_action", {
        "action": mask(act), "element": element and {k: element.get(k) for k in ("tag", "type", "label", "text", "menu", "row",
                                                                                   "frame", "readonly", "href")},
        "fields_info": fields_info, "source": "workflow" if from_workflow else "model",
        "needs_confirmation": bool(confirm), "model": used["model"], "model_url": used["url"]},
        task_id=task_id, url=page.get("url"))
    if act["action"] in ("done", "fail"):
        status = "failed" if act["action"] == "fail" else "unverified" if act.get("unverified") else "completed"
        finish_internal(task_id, u, status, act.get("summary", ""))
    # Vision fallback: stuck or failing repeatedly -> ask for a screenshot with numbered boxes next step
    want_screenshot = (looped or st["fails"] >= 2 or act["action"] == "look") and act["action"] not in ("done", "fail")
    return {"action": act, "needs_confirmation": bool(confirm), "confirmation": confirm, "host": host,
            "want_screenshot": want_screenshot}


class DialogIn(BaseModel):
    page: dict
    id: int | None = None
    message: str


@app.post("/api/tasks/{task_id}/dialog")
def site_dialog(task_id: str, body: DialogIn, u: User = Depends(current_user)):
    """The site asked "Are you sure...?" (a native confirm) for an action the user had not approved: build the
    confirmation to show the user, with the site's own question."""
    t = own_task(task_id, u)
    el = next((e for e in body.page.get("elements", []) if e["id"] == body.id), None) or {}
    c = agent.confirmation_for(el, body.page, body.message)
    c = build_confirmation(task_id, t, body.page, c, get_profile(u.emp_id))
    db.log_event(con, u.emp_id, "site_dialog", {"message": body.message, "element": {k: el.get(k) for k in ("text", "row")}},
                 task_id=task_id, url=body.page.get("url"))
    return c


def approvals(task_id) -> list[tuple[str, bool]]:
    """Submits the user approved in this task, and whether each one went through. One the site rejected (an alert
    such as "Please pick the approver", an error message, nothing happened) doesn't count."""
    rows = list(con.execute("SELECT event_type, payload FROM events WHERE task_id=? AND event_type IN "
                            "('confirmation','action_result') ORDER BY seq", (task_id,)))
    out = []
    for i, r in enumerate(rows):
        c = json.loads(r["payload"])
        if r["event_type"] != "confirmation" or not c.get("approved"):
            continue
        res = next((json.loads(x["payload"]) for x in rows[i + 1:] if x["event_type"] == "action_result"), None)
        rejected = res is not None and ((res.get("dialog") or {}).get("kind") == "alert" or not res.get("ok") or
                                        bool(re.search(r"errors shown|did not change", res.get("observed") or "")))
        out.append((c.get("button"), not rejected))   # not reported yet: assume it went through (never do it twice)
    return out


def went_through(task_id) -> bool:
    return any(ok for _, ok in approvals(task_id))


def just_confirmed(task_id, element):
    """True if the user just approved the previous action AND this click is the site's own confirmation button
    for it (e.g. "Place order" then the site's "Yes, place order"). A repeat of the same button always asks again."""
    last = con.execute("SELECT payload FROM events WHERE task_id=? AND event_type='model_action' ORDER BY seq DESC LIMIT 1",
                       (task_id,)).fetchone()
    if not last or not json.loads(last["payload"]).get("needs_confirmation"):
        return False
    prev_el = json.loads(last["payload"]).get("element") or {}
    label = f"{(element or {}).get('text', '')} {(element or {}).get('label', '')}"
    if (prev_el.get("text"), prev_el.get("label")) == ((element or {}).get("text"), (element or {}).get("label")) \
            or not re.search(r"\b(yes|ok|confirm)\b", label, re.I):
        return False
    c = con.execute("SELECT payload FROM events WHERE task_id=? AND event_type='confirmation' ORDER BY seq DESC LIMIT 1",
                    (task_id,)).fetchone()
    return bool(c and json.loads(c["payload"]).get("approved"))


def finish_internal(task_id, u, status, summary, act_only=False):
    cur = con.execute("UPDATE tasks SET status=?, summary=?, ended_at=? WHERE task_id=? AND status='running'",
                      (status, summary, db.now(), task_id))
    con.commit()
    db.log_event(con, u.emp_id, "task_finished", {"status": status, "summary": summary}, task_id=task_id)
    if cur.rowcount:
        record_outcome(task_id, u, status, summary)
    if act_only:
        return {"action": {"action": "fail" if status != "completed" else "done", "summary": summary},
                "needs_confirmation": False, "confirmation": None}


def record_outcome(task_id, u, status, summary):
    """Playbook/workflow health, and learning from verified successes."""
    st = TASK_STATE.pop(task_id, {})
    LAST_PAGE_TEXT.pop(task_id, None)
    wf = st.get("workflow") or {}
    source = wf.get("source") or next((json.loads(r["payload"]).get("source") for r in con.execute(
        "SELECT payload FROM events WHERE task_id=? AND event_type='workflow_selected'", (task_id,))), None)
    con.execute("INSERT OR REPLACE INTO task_outcomes VALUES (?,?,?,?,?,?,?)",
                (task_id, skills.main_site(con, task_id), source, status, summary[:300], st.get("drift", 0), db.now()))
    con.commit()
    if source and source.startswith("experience:"):
        col = "successes" if status == "completed" else "failures"
        con.execute(f"UPDATE experiences SET {col}={col}+1 WHERE id=?", (int(source.split(":")[1]),))
        con.commit()
    acted = con.execute("SELECT 1 FROM events WHERE task_id=? AND event_type='confirmation' AND payload LIKE "
                        "'%\"approved\": true%'", (task_id,)).fetchone()
    if status == "completed" and acted:
        prompt = con.execute("SELECT prompt FROM tasks WHERE task_id=?", (task_id,)).fetchone()["prompt"]
        exp = skills.learn_from_task(con, task_id, prompt, db.now())
        if exp:
            db.log_event(con, u.emp_id, "experience_saved", {"experience": exp}, task_id=task_id)



class EventIn(BaseModel):
    event_type: str                # confirmation | screenshot | client_error | user_cancelled
    payload: dict = {}
    url: str | None = None
    screenshot_b64: str | None = None


@app.post("/api/tasks/{task_id}/events")
def add_event(task_id: str, body: EventIn, u: User = Depends(current_user)):
    t = own_task(task_id, u)
    if body.event_type not in {"confirmation", "screenshot", "client_error", "user_cancelled", "file_chosen"}:
        raise HTTPException(400, "Unknown event type")
    shot = None
    if body.screenshot_b64:
        data = base64.b64decode(body.screenshot_b64.split(",")[-1])
        shot = f"{task_id}-{uuid.uuid4().hex[:8]}.png"
        open(os.path.join(SHOT_DIR, shot), "wb").write(data)
    db.log_event(con, u.emp_id, body.event_type, mask(body.payload), task_id=task_id, url=body.url, screenshot=shot)
    if body.event_type in ("user_cancelled", "client_error") and t["status"] == "running":
        finish_internal(task_id, u, "cancelled" if body.event_type == "user_cancelled" else "failed",
                        body.payload.get("reason", body.event_type))
    return {"ok": True, "screenshot": shot}


# ---------------------------------------------------------------- history & audit

@app.get("/api/history")
def history(all: bool = False, emp_id: str = "", status: str = "", site: str = "", u: User = Depends(current_user)):
    q, args = "SELECT * FROM tasks WHERE 1=1", []
    if not (all and "auditor" in u.roles):
        q += " AND emp_id=?"
        args.append(u.emp_id)
    elif emp_id:
        q += " AND emp_id=?"
        args.append(emp_id)
    if status:
        q += " AND status=?"
        args.append(status)
    if site:
        q += " AND site LIKE ?"
        args.append(f"%{site}%")
    return [dict(r) for r in con.execute(q + " ORDER BY started_at DESC LIMIT 500", args)]


@app.get("/api/history/{task_id}")
def task_detail(task_id: str, u: User = Depends(current_user)):
    t = con.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
    if not t or (t["emp_id"] != u.emp_id and "auditor" not in u.roles):
        raise HTTPException(404, "Task not found")
    events = [{**dict(r), "payload": json.loads(r["payload"])} for r in
              con.execute("SELECT * FROM events WHERE task_id=? ORDER BY seq", (task_id,))]
    return {"task": dict(t), "events": events}


@app.get("/api/screenshots/{name}")
def screenshot(name: str, u: User = Depends(current_user)):
    if not re.fullmatch(r"[0-9a-f-]+\.png", name):
        raise HTTPException(400)
    task_id = name.rsplit("-", 1)[0]
    t = con.execute("SELECT emp_id FROM tasks WHERE task_id=?", (task_id,)).fetchone()
    if not t or (t["emp_id"] != u.emp_id and "auditor" not in u.roles):
        raise HTTPException(404)
    return FileResponse(os.path.join(SHOT_DIR, name), media_type="image/png")


@app.get("/api/audit/verify")
def audit_verify(u: User = Depends(require("auditor"))):
    result = db.verify_chain(con)
    db.log_event(con, u.emp_id, "audit_verified", result)
    return result


@app.get("/api/audit/log")
def audit_log(u: User = Depends(require("auditor"))):
    rows = con.execute("SELECT id, emp_id, event_type, payload, created_at FROM events WHERE task_id IS NULL "
                       "ORDER BY id DESC LIMIT 500")
    return [{**dict(r), "payload": json.loads(r["payload"])} for r in rows]


# ---------------------------------------------------------------- admin

@app.get("/api/admin/policy")
def get_policy(u: User = Depends(require("admin"))):
    return policy()


@app.put("/api/admin/policy")
def put_policy(body: dict, u: User = Depends(require("admin"))):
    p = {**policy(), **body}
    con.execute("UPDATE admin_policy SET allow_custom_endpoints=?, allowed_model_hosts=?, allowed_sites=?, max_steps=? WHERE id=1",
                (int(bool(p["allow_custom_endpoints"])), json.dumps(p["allowed_model_hosts"]),
                 json.dumps(p["allowed_sites"]), int(p["max_steps"])))
    con.commit()
    db.log_event(con, u.emp_id, "policy_changed", body)
    return policy()


class ProviderIn(BaseModel):
    name: str
    base_url: str
    model: str
    api_key: str | None = None
    supports_vision: bool = False
    is_default: bool = False
    json_mode: str = "auto"        # auto | schema | object | none
    context_tokens: int = 8192


@app.post("/api/admin/models")
def add_model(body: ProviderIn, u: User = Depends(require("admin"))):
    if body.is_default:
        con.execute("UPDATE model_providers SET is_default=0")
    con.execute("INSERT INTO model_providers (name, base_url, model, api_key_enc, supports_vision, is_default, json_mode, "
                "context_tokens) VALUES (?,?,?,?,?,?,?,?)",
                (body.name, body.base_url, body.model, enc(body.api_key), int(body.supports_vision), int(body.is_default),
                 body.json_mode, body.context_tokens))
    con.commit()
    db.log_event(con, u.emp_id, "model_added", mask(body.model_dump()))
    return models(u)


# ---------------------------------------------------------------- teach mode

class TeachIn(BaseModel):
    name: str
    site: str
    events: list[dict]


def events_as_text(events):
    out = []
    for e in events:
        k = e.get("kind")
        if k == "navigate":
            out.append(f'Opened page "{e.get("title")}" {e.get("url")}')
        elif k == "click":
            out.append(f'Clicked {"link" if e.get("tag") == "a" else "button"} "{e.get("text") or e.get("label")}"'
                       + (f' in the "{e["menu"]}" menu (opens on hover)' if e.get("menu") else "")
                       + (f' in the table row "{e["row"][:60]}"' if e.get("row") else ""))
        elif k == "fill" and e.get("autocomplete"):
            out.append(f'Typed into "{e.get("label")}" and picked "{e.get("value")}" from the suggestions')
        elif k == "fill":
            out.append(f'{"A pop-up filled" if e.get("readonly") else "Typed"} "{e.get("value")}" into field "{e.get("label")}"')
        elif k == "date":
            out.append(f'Picked the date "{e.get("value")}" for "{e.get("label")}" in the calendar')
        elif k == "upload":
            out.append(f'Attached a file ("{e.get("value")}") to "{e.get("label")}"')
        elif k == "choose":
            out.append(f'Chose "{e.get("value")}" for "{e.get("label")}"')
    return "\n".join(f"{i + 1}. {x}" for i, x in enumerate(out))


@app.post("/api/teach/draft")
def teach_draft(body: TeachIn, u: User = Depends(current_user)):
    events = [e for e in body.events if e.get("value") != "(hidden)"]   # never pass on passwords
    recording = events_as_text(events)
    db.log_event(con, u.emp_id, "teach_recorded", {"name": body.name, "site": body.site, "steps": len(events),
                                                   "recording": recording[:4000]})
    cfg = model_cfg(u.emp_id)
    try:
        steps = agent.parse_playbook(agent.call_model(
            cfg, [{"role": "system", "content": agent.TEACH_PROMPT},
                  {"role": "user", "content": f"Workflow name: {body.name}\n\nRECORDING:\n{recording}"}],
            schema=agent.PLAYBOOK_SCHEMA))
    except Exception as e:
        steps = f"Start URL: {events[0]['url'] if events else ''}\n" + recording   # fall back to the raw recording
        db.log_event(con, u.emp_id, "model_error", {"where": "teach_draft", "error": str(e)[:200]})
    return {"steps": steps, "recording": recording}


class PlaybookIn(BaseModel):
    site: str
    task: str
    steps: str
    events: list[dict] | None = None   # the recording, replayed as a workflow later


@app.get("/api/playbooks")
def list_playbooks(u: User = Depends(current_user)):
    return [dict(r) for r in con.execute("SELECT * FROM site_playbooks ORDER BY id DESC")]


@app.post("/api/playbooks")
def create_playbook(body: PlaybookIn, u: User = Depends(current_user)):
    status = "active" if "admin" in u.roles else "pending"
    events = body.events or []   # structure only: macro_from_teach keeps labels/buttons, drops sign-in and values
    macro = json.dumps(skills.macro_from_teach(events)) if events else None
    cur = con.execute("INSERT INTO site_playbooks (site, task, steps, updated_by, updated_at, status, source, macro) "
                      "VALUES (?,?,?,?,?,?, 'teach', ?)", (body.site, body.task, body.steps, u.emp_id, db.now(), status, macro))
    con.commit()
    db.log_event(con, u.emp_id, "playbook_created", {"id": cur.lastrowid, "site": body.site, "task": body.task,
                                                     "status": status, "steps": body.steps})
    return {"id": cur.lastrowid, "status": status}


@app.post("/api/playbooks/{pid}/approve")
def approve_playbook(pid: int, u: User = Depends(require("admin"))):
    con.execute("UPDATE site_playbooks SET status='active', updated_at=? WHERE id=?", (db.now(), pid))
    con.commit()
    db.log_event(con, u.emp_id, "playbook_approved", {"id": pid})
    return {"ok": True}


@app.get("/api/admin/playbooks")
def playbooks(u: User = Depends(current_user)):
    return [dict(r) for r in con.execute("SELECT * FROM site_playbooks")]


@app.put("/api/admin/playbooks/{pid}")
def put_playbook(pid: int, body: dict, u: User = Depends(require("admin"))):
    con.execute("UPDATE site_playbooks SET steps=?, updated_by=?, updated_at=? WHERE id=?",
                (body["steps"], u.emp_id, db.now(), pid))
    con.commit()
    db.log_event(con, u.emp_id, "playbook_changed", {"id": pid, "steps": body["steps"]})
    return playbooks(u)


# ---------------------------------------------------------------- home screen: your apps, what you usually do

class LinkIn(BaseModel):
    title: str
    url: str


@app.get("/api/links")
def list_links(u: User = Depends(current_user)):
    return [dict(r) for r in con.execute("SELECT id, title, url FROM user_links WHERE emp_id=? ORDER BY id", (u.emp_id,))]


@app.post("/api/links")
def add_link(body: LinkIn, u: User = Depends(current_user)):
    url, title = body.url.strip(), body.title.strip()
    if not re.match(r"^https?://[^\s/]+", url):
        raise HTTPException(400, "Enter a full address starting with http:// or https://")
    title = title or urlparse(url).hostname
    cur = con.execute("INSERT INTO user_links (emp_id, title, url, created_at) VALUES (?,?,?,?)", (u.emp_id, title[:60], url, db.now()))
    con.commit()
    db.log_event(con, u.emp_id, "link_added", {"title": title, "url": url})
    allowed = any(fnmatch.fnmatch(urlparse(url).hostname or "", s) for s in policy()["allowed_sites"])
    return {"id": cur.lastrowid, "title": title, "url": url, "assistant_can_use": allowed}


@app.delete("/api/links/{lid}")
def delete_link(lid: int, u: User = Depends(current_user)):
    con.execute("DELETE FROM user_links WHERE id=? AND emp_id=?", (lid, u.emp_id))
    con.commit()
    db.log_event(con, u.emp_id, "link_deleted", {"id": lid})
    return {"ok": True}


@app.get("/api/home")
def home(u: User = Depends(current_user)):
    """The first screen after sign-in: the user's apps, the tasks they do most often, and their latest tasks."""
    tasks = [dict(r) for r in con.execute("SELECT task_id, prompt, status, summary, started_at FROM tasks WHERE emp_id=? "
                                          "ORDER BY started_at DESC LIMIT 200", (u.emp_id,))]
    groups = []   # similar requests count as the same kind of task ("apply leave ..." twice)
    for t in tasks:
        g = next((g for g in groups if skills.similarity(g["prompt"], t["prompt"]) >= 0.6), None)
        if g:
            g["count"] += 1
            g["done"] += t["status"] == "completed"
        else:
            groups.append({"prompt": t["prompt"], "count": 1, "done": int(t["status"] == "completed"), "last": t["started_at"]})
    frequent = sorted(groups, key=lambda g: -g["count"])[:4]   # (groups are newest first; ties stay that way)
    return {"links": list_links(u), "frequent": frequent, "recent": tasks[:5]}


# ---------------------------------------------------------------- communications

class CommsSyncIn(BaseModel):
    source: str
    items: list[dict]


@app.post("/api/comms/sync")
def comms_sync(body: CommsSyncIn, u: User = Depends(current_user)):
    """Items the extension read from an office app as the user (their own session)."""
    n = comms.sync(con, u.emp_id, body.source[:100], body.items[:5000], me_hint=u.emp_id)
    db.log_event(con, u.emp_id, "comms_synced", {"source": body.source, "items": n})
    return {"synced": n}


@app.get("/api/comms/search")
def comms_search(q: str = "", folder: str = "", direction: str = "", u: User = Depends(current_user)):
    return comms.search(con, u.emp_id, q, folder, direction, today())


@app.get("/api/admin/playbook-health")
def playbook_health(u: User = Depends(current_user)):
    """How each site and each replayed workflow has been doing (auditors and admins)."""
    if not {"auditor", "admin"} & set(u.roles):
        raise HTTPException(403, "Auditors and admins only")
    names = {f"playbook:{r['id']}": f"taught: {r['task']}" for r in con.execute("SELECT id, task FROM site_playbooks")}
    names.update({f"experience:{r['id']}": f"learned: {r['goal'][:60]}" for r in con.execute("SELECT id, goal FROM experiences")})
    return [{**h, "name": names.get(h["key"], h["key"])} for h in skills.health(con)]


@app.get("/api/admin/experiences")
def list_experiences(u: User = Depends(require("admin"))):
    return [{**dict(r), "steps": json.loads(r["steps"])} for r in con.execute("SELECT * FROM experiences ORDER BY id DESC")]


@app.delete("/api/admin/experiences/{eid}")
def delete_experience(eid: int, u: User = Depends(require("admin"))):
    con.execute("DELETE FROM experiences WHERE id=?", (eid,))
    con.commit()
    db.log_event(con, u.emp_id, "experience_deleted", {"id": eid})
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"ok": True}
