"""Workflows the assistant has seen work: taught demonstrations and its own successful runs ("experiences").

A workflow is a list of steps. Steps that are the same every time (open a menu, click "Travel Request",
click "Submit") are replayed directly, without asking the model; steps whose value depends on the request
(type the destination, pick the dates) are left to the model, with the workflow shown as a hint. Any step
that can't be found on the page hands control back to the model, so a changed site degrades to the normal
agent instead of breaking. The final submit still goes through the usual confirmation.
"""
import json
import re
from urllib.parse import urlparse

STOP = {"the", "and", "for", "with", "from", "this", "that", "please", "into", "about", "your", "you", "are", "was",
        "will", "have", "has", "our", "per", "each", "via", "not", "all", "any", "can", "legacy", "erp", "intranet"}
VALUE_ACTIONS = {"type", "select", "pick_date", "autocomplete", "upload"}
FIXED_ACTIONS = {"click", "hover"}


def words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]{3,}", (text or "").lower()) if w not in STOP}


def similarity(a: str, b: str) -> float:
    wa, wb = words(a), words(b)
    return len(wa & wb) / max(1, min(len(wa), len(wb)))


def _norm(s) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()


def is_param_click(text: str, row: str | None, demo_values: set[str], goal: str = "", el: dict | None = None) -> bool:
    """Clicks that depend on the request: calendar days and arrows, a specific table row, a value that was typed or
    that comes from the request (a suggestion "Priya Sharma (Engineering)", a lookup entry "Engineering - Bangalore")."""
    t = _norm(text)
    if bool(row) or not t or re.fullmatch(r"\d{1,2}|[<>‹›«»]+|next|prev|previous", (text or "").strip().lower()):
        return True
    if t in demo_values or any(len(v) >= 3 and v in t for v in demo_values):
        return True
    el = el or {}
    href = (el.get("href") or "").strip()
    navigation = el.get("menu") or el.get("tag") == "button" or el.get("type") in ("submit", "button") or \
        (href and not href.endswith("#") and not href.lower().startswith("javascript:")) or (el.get("tag") == "a" and "href" not in el)
    return not navigation and len(t) >= 5 and t in _norm(goal)


def step_text(st: dict) -> str:
    if st["action"] == "navigate":
        return f"open {st.get('url')}"
    target = st.get("text") or st.get("label") or "?"
    where = f" (in menu {st['menu']})" if st.get("menu") else ""
    if st["action"] in VALUE_ACTIONS:
        return f"{st['action']} '{st.get('label') or target}' <value from the request>"
    if st.get("param"):
        return f"click the right '{target}' for this request{where}"
    return f"{st['action']} '{target}'{where}"


# ---------------------------------------------------------------- building workflows

def macro_from_teach(events: list[dict]) -> list[dict]:
    """Recorder events -> workflow steps."""
    steps, demo = [], {_norm(e.get("value")) for e in events if e.get("kind") in ("fill", "choose") and e.get("value")}
    # signing in is always done by the person: leave out what was typed on sign-in pages
    login_urls = {e.get("url") for e in events if e.get("kind") == "fill" and e.get("value") == "(hidden)"}
    for e in events:
        if e.get("url") in login_urls and e.get("kind") != "navigate":
            continue
        k = e.get("kind")
        if k == "navigate" and not steps:
            steps.append({"action": "navigate", "url": e.get("url"), "host": urlparse(e.get("url") or "").hostname})
        elif k == "click":
            if e.get("readonly"):       # clicked a read-only box: a picker follows, the "date" event covers it
                continue
            text = e.get("text") or e.get("label") or ""
            param = is_param_click(text, e.get("row"), demo)
            steps.append({"action": "click", "text": text, "menu": e.get("menu"), "param": param})
        elif k in ("fill", "choose", "date", "upload"):
            action = {"fill": "type", "choose": "select", "date": "pick_date", "upload": "upload"}[k]
            if e.get("autocomplete"):
                action = "autocomplete"
            steps.append({"action": action, "label": e.get("label"), "param": True})
    # pick_date covers the calendar: drop the clicks that opened it and picked the day/month around a date step
    calendarish = lambda st: st["action"] == "click" and (
        re.fullmatch(r"\d{1,2}|[<>‹›«»]+|next|prev|previous|today", (st.get("text") or "").strip().lower())
        or re.search(r"\b(pick|calendar|date)\b", (st.get("text") or "").lower()))
    # (the date of a picker is often reported a step late, so drop every calendar click once there is a date step)
    has_dates = any(st["action"] == "pick_date" for st in steps)
    drop = {i for i, st in enumerate(steps) if has_dates and calendarish(st)}
    out = []
    for i, st in enumerate(steps):
        if i in drop or (out and out[-1] == st):
            continue
        out.append(st)
    return out


def macro_from_run(con, task_id: str, goal: str = "") -> list[dict]:
    """The model actions of a successful task -> workflow steps (only actions that worked and the site accepted)."""
    rows = list(con.execute("SELECT event_type, payload FROM events WHERE task_id=? AND event_type IN "
                            "('model_action','action_result') ORDER BY seq", (task_id,)))
    steps, pending = [], None
    demo = set()
    for r in rows:
        p = json.loads(r["payload"])
        if r["event_type"] == "model_action":
            pending = p
            a = p["action"]
            if a.get("action") in VALUE_ACTIONS and a.get("value"):
                demo.add(_norm(a["value"]))
            for f in a.get("fields") or []:
                demo.add(_norm(f.get("value")))
            continue
        if not pending:
            continue
        rejected = (p.get("dialog") or {}).get("kind") == "alert" or "errors shown" in (p.get("observed") or "")
        ok, p, pending = p.get("ok") and not rejected, pending, None
        a, el = p["action"], p.get("element") or {}
        if not ok or a.get("action") in ("ask_user", "done", "fail", "click_xy", "look"):
            continue
        if a["action"] == "navigate":
            continue
        if a["action"] == "fill_form":
            for f in p.get("fields_info") or []:
                steps.append({"action": f.get("kind", "type"), "label": f.get("label"), "param": True})
            continue
        if a["action"] in VALUE_ACTIONS:
            steps.append({"action": a["action"], "label": el.get("label") or el.get("text"), "param": True})
            continue
        text = el.get("text") or el.get("label") or ""
        steps.append({"action": a["action"], "text": text, "menu": el.get("menu"),
                      "param": is_param_click(text, el.get("row"), demo, goal, el)})
    out = []
    for st in steps:
        if not out or out[-1] != st:
            out.append(st)
    return out


# ---------------------------------------------------------------- replay

def _find(st: dict, page: dict):
    want = _norm(st.get("text") or st.get("label"))
    if not want:
        return None
    for el in page.get("elements", []):
        if el.get("tag") in ("input", "select", "textarea") and el.get("type") not in ("submit", "button"):
            continue
        if _norm(el.get("text")) == want or _norm(el.get("label")) == want:
            if st.get("menu") and el.get("menu") and _norm(el["menu"]) != _norm(st["menu"]):
                continue
            return el
    return None


def _field_matches(st: dict, el: dict | None) -> bool:
    want = _norm(st.get("label"))
    have = [_norm(el.get("label")), _norm(el.get("text"))] if el else []
    # the same field reached through its icon counts too ("To date" / "Pick to date")
    return bool(want) and any(h and (h == want or (len(want) >= 4 and want in h)) for h in have)


def suggest(state: dict, page: dict, host: str):
    """Next step of the workflow: (action to execute directly, or None; hint for the model)."""
    steps, i = state["steps"], state["cursor"]
    if i >= len(steps):
        return None, None
    st = steps[i]
    if st["action"] == "navigate":
        if host and st.get("host") and host != st["host"]:
            state["cursor"] = i + 1
            return {"action": "navigate", "url": st["url"], "thought": f"Following the {state['label']}: open the site."}, None
        state["cursor"] = i + 1
        return suggest(state, page, host)
    # a value step whose field is not on this page (already done, or the site skipped it): look a few steps ahead
    on_page = lambda x: _find(x, page) if x["action"] in FIXED_ACTIONS else next(
        (e for e in page.get("elements", []) if _field_matches(x, e)), None)
    if (st["action"] in VALUE_ACTIONS or st.get("param")) and not on_page(st):
        for j in range(i + 1, min(i + 4, len(steps))):
            if steps[j]["action"] != "navigate" and on_page(steps[j]):
                state["cursor"] = j
                return suggest(state, page, host)
    if st["action"] in FIXED_ACTIONS and not st.get("param"):
        # this step, or one of the next two fixed steps if the page skipped ahead (e.g. already on the form)
        for j in range(i, min(i + 3, len(steps))):
            sj = steps[j]
            if sj["action"] in VALUE_ACTIONS or sj.get("param"):
                break
            el = _find(sj, page)
            if el:
                return ({"action": sj["action"], "id": el["id"], "_macro_step": j,
                         "thought": f"Following the {state['label']}: {step_text(sj)}."}, None)
        state["misses"] = state.get("misses", 0) + 1
    return None, hint(state)


def hint(state: dict) -> str:
    steps, i = state["steps"], state["cursor"]
    lines = []
    for j, st in enumerate(steps):
        if st["action"] == "navigate":
            continue
        mark = "done" if j < i else "NEXT" if j == i else ""
        lines.append(f"{'✓' if j < i else '→' if j == i else ' '} {step_text(st)}" + (f"   ({mark})" if mark else ""))
    return (f"WORKFLOW THAT WORKED BEFORE ({state['label']}; the values must come from the GOAL, not from here):\n"
            + "\n".join(lines))


def advance(state: dict, act: dict, element: dict | None, fields_info: list[dict] | None = None):
    """Move the cursor past the steps the latest action covered."""
    steps, i = state["steps"], state["cursor"]
    if "_macro_step" in act:
        state["cursor"] = act["_macro_step"] + 1
        return
    targets = [(f.get("kind"), {"label": f.get("label")}) for f in (fields_info or [])] if act["action"] == "fill_form" \
        else [(act["action"], element)]
    for kind, el in targets:
        for j in range(state["cursor"], min(state["cursor"] + 6, len(steps))):
            st = steps[j]
            same_kind = (st["action"] in VALUE_ACTIONS and kind in VALUE_ACTIONS) or st["action"] == kind
            if same_kind and (_field_matches(st, el) or (el and _norm(st.get("text")) and
                                                          _norm(st.get("text")) == _norm(el.get("text")))):
                state["cursor"] = j + 1
                break


# ---------------------------------------------------------------- choosing a workflow for a new task

def pick_workflow(con, goal: str, playbooks: list[dict]):
    """A taught workflow for a matching playbook, else the closest successful run (experience)."""
    best = None
    for p in playbooks:
        if not p.get("macro"):
            continue
        s = similarity(goal, f"{p['task']} {p['steps']}")
        if s >= 0.3 and (not best or s > best[0]):
            best = (s, {"steps": json.loads(p["macro"]), "cursor": 0, "label": f"taught workflow '{p['task']}'",
                        "source": f"playbook:{p['id']}"})
    if best:
        return best[1]
    for r in con.execute("SELECT id, goal, site, steps, successes FROM experiences ORDER BY successes DESC, id DESC LIMIT 200"):
        s = similarity(goal, r["goal"])
        if s >= 0.6 and (not best or s > best[0]):
            best = (s, {"steps": json.loads(r["steps"]), "cursor": 0,
                        "label": f"successful run for '{r['goal'][:60]}'", "source": f"experience:{r['id']}"})
    return best[1] if best else None


def main_site(con, task_id: str) -> str:
    hosts = {}
    for r in con.execute("SELECT url FROM events WHERE task_id=? AND event_type='model_action'", (task_id,)):
        h = urlparse(r["url"] or "").hostname
        if h:
            hosts[h] = hosts.get(h, 0) + 1
    hosts.pop("intranet.office.local", None)
    return max(hosts, key=hosts.get) if hosts else ""


def learn_from_task(con, task_id: str, goal: str, now: str):
    """After a verified success: remember how it was done (structure only: labels and buttons, never values)."""
    steps = macro_from_run(con, task_id, goal)
    if len([s for s in steps if s["action"] != "navigate"]) < 2:
        return None
    site = main_site(con, task_id)
    sig = json.dumps(steps, sort_keys=True)
    for r in con.execute("SELECT id, steps FROM experiences WHERE site=?", (site,)):
        if json.dumps(json.loads(r["steps"]), sort_keys=True) == sig:
            con.execute("UPDATE experiences SET successes=successes+1, last_used=? WHERE id=?", (now, r["id"]))
            con.commit()
            return r["id"]
    cur = con.execute("INSERT INTO experiences (site, goal, steps, task_id, successes, created_at, last_used) "
                      "VALUES (?,?,?,?,1,?,?)", (site, goal, sig, task_id, now, now))
    con.commit()
    return cur.lastrowid


def health(con) -> list[dict]:
    """Per site and per workflow: how recent tasks went. Flags workflows that stopped matching the site."""
    out = {}
    for r in con.execute("SELECT * FROM task_outcomes ORDER BY ended_at"):
        for key in filter(None, [r["site"] and f"site:{r['site']}", r["workflow"]]):
            h = out.setdefault(key, {"key": key, "runs": 0, "completed": 0, "unverified": 0, "failed": 0, "cancelled": 0,
                                     "drift": 0, "recent": [], "last_problem": None})
            h["runs"] += 1
            h[r["status"] if r["status"] in ("completed", "unverified", "failed", "cancelled") else "failed"] += 1
            h["drift"] += r["drift"] or 0
            h["recent"] = (h["recent"] + [r["status"]])[-5:]
            if r["status"] != "completed":
                h["last_problem"] = {"when": r["ended_at"], "status": r["status"], "summary": r["summary"]}
    for h in out.values():
        recent_fail = [s for s in h["recent"] if s in ("failed", "unverified")]
        h["status"] = ("broken" if h["recent"][-3:] and all(s == "failed" for s in h["recent"][-3:]) and len(h["recent"]) >= 3
                       else "needs attention" if len(recent_fail) >= 2 or h["drift"] >= 2 else "ok")
        h["success_rate"] = round(h["completed"] / h["runs"], 2) if h["runs"] else None
    return sorted(out.values(), key=lambda h: (h["status"] == "ok", h["key"]))
