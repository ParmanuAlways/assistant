"""Rule-based stand-in for an LLM, speaking the OpenAI-compatible /v1/chat/completions API.

NOT AI. Used only because Hugging Face / Ollama downloads are blocked in the cloud test
environment. It reads exactly the same prompt a real model (Gemma, GLM...) gets — goal,
profile, playbook, previous steps and the page's element list — and answers with the same
JSON actions. Swap the URL in Settings to a real Ollama/vLLM server to use a real model.
"""
import json
import re
import time
from datetime import date, timedelta
from urllib.parse import urlparse

import os

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI(title="Stand-in model")

MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
EL_RE = re.compile(r'^\[(\d+)\] (\w+)(.*)$')


def section(text, name, next_names):
    m = re.search(rf"{name}:\n?(.*?)(?=\n\n(?:{'|'.join(next_names)})|\Z)", text, re.S)
    return m.group(1).strip() if m else ""


def parse_elements(block):
    els = []
    for line in block.splitlines():
        m = EL_RE.match(line.strip())
        if not m:
            continue
        rest = m.group(3)
        attr = lambda k: (re.search(rf'{k}="((?:[^"\\]|\\.)*)"', rest) or [None, ""])[1]
        opts = re.search(r"options=(\[.*?\])(?: |$)", rest)
        typ = re.search(r"type=(\S+)", rest)
        els.append({"id": int(m.group(1)), "tag": m.group(2), "type": typ.group(1) if typ else "",
                    "label": attr("label"), "text": attr("text"), "value": attr("value"), "href": attr("href"),
                    "required": " required" in rest, "options": json.loads(opts.group(1)) if opts else []})
    return els


def parse_date(s, today):
    s = s.strip().lower()
    if s == "today":
        return today
    if s == "tomorrow":
        return today + timedelta(days=1)
    for wd in WEEKDAYS:
        if s in (wd, f"next {wd}", f"this {wd}", wd[:3]):
            delta = (WEEKDAYS.index(wd) - today.weekday()) % 7 or 7
            return today + timedelta(days=delta)
    if m := re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", s):
        return date(int(m[1]), int(m[2]), int(m[3]))
    if m := re.fullmatch(r"(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})", s):
        return date(int(m[3]), int(m[2]), int(m[1]))
    if (m := re.fullmatch(r"(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3})[a-z]*,? ?(\d{4})?", s)) and m[2] in MONTHS:
        return date(int(m[3] or today.year), MONTHS[m[2]], int(m[1]))
    if (m := re.fullmatch(r"([a-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?,? ?(\d{4})?", s)) and m[1] in MONTHS:
        return date(int(m[3] or today.year), MONTHS[m[1]], int(m[2]))
    return None


MON = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*"
DATE_TOKEN = (r"(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|\d{1,2}(?:st|nd|rd|th)? " + MON + r",? ?(?:\d{4})?"
              r"|" + MON + r" \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?|today|tomorrow|(?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))")


def understand_goal(goal, today):
    g = goal.lower()
    dates = []
    for m in re.finditer(DATE_TOKEN, g):
        d = parse_date(m.group(1), today)
        if d:
            dates.append(d)
    start = dates[0] if dates else None
    end = dates[1] if len(dates) > 1 else None
    if start and not end:
        n = re.search(r"(\d+|one|two|three|four|five) days?", g)
        words = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}
        days = int(words.get(n.group(1), n.group(1))) if n else 1
        end = start + timedelta(days=days - 1)
    reason = None
    if m := re.search(r"reason\s*(?:is|:|-)?\s*(.+?)(?:[.;]|$)", goal, re.I):
        reason = m.group(1).strip()
    elif m := re.search(r"\b(?:because|due to)\s+(.+?)(?:[.;]|$)", goal, re.I):
        reason = m.group(1).strip()
    return {"start": start, "end": end, "reason": reason, "text": g}


def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def decide(prompt):
    goal = section(prompt, "GOAL", ["TODAY"])
    today = date.fromisoformat(section(prompt, "TODAY", ["USER PROFILE"])[:10])
    profile = json.loads(section(prompt, "USER PROFILE", ["SITE PLAYBOOKS"]) or "{}")
    playbooks = section(prompt, "SITE PLAYBOOKS", ["PREVIOUS STEPS"])
    previous = section(prompt, "PREVIOUS STEPS", ["CURRENT PAGE"])
    page = section(prompt, "CURRENT PAGE", ["Reply with"])
    url = (re.search(r"URL: (\S*)", page) or [None, ""])[1]
    text = page.split("ELEMENTS:")[0]
    els = parse_elements(page.split("ELEMENTS:")[-1])
    g = understand_goal(goal, today)
    answers = {}
    for line in previous.splitlines():
        if '"user_answered"' in line:
            a = json.loads(line.split(". ", 1)[1])["user_answered"]
            answers[a.get("field")] = a.get("answer")

    submitted_now = '"action": "click"' in previous and "Submit" in previous
    if submitted_now and re.search(r"submitted successfully", text, re.I):
        msg = re.search(r"(Leave request .*?submitted successfully\..*?)(?:\n|$)", text)
        return {"action": "done", "summary": (msg.group(1) if msg else "Task completed.").strip(),
                "thought": "The page confirms success."}
    if any(e["type"] == "password" for e in els):
        if "user_action" in answers and previous.count('"field": "user_action"') > 3:
            return {"action": "fail", "summary": "Still on the sign-in page.", "thought": "Login did not complete."}
        return {"action": "ask_user", "field": "user_action", "remember": False,
                "question": "This site is asking for your password. Please sign in on the page yourself, then press Continue.",
                "thought": "I never type passwords."}
    err = re.search(r"^(.*(?:does not match|cannot be|must be|Please enter|Please select).*)$", text, re.M)
    if err and "Submit" in previous:
        return {"action": "fail", "summary": f"The site rejected the form: {err.group(1).strip()}",
                "thought": "Validation error after submit."}

    start_url = (re.search(r"Start URL: (\S+)", playbooks) or [None, None])[1]
    if start_url and urlparse(url).netloc != urlparse(start_url).netloc:
        return {"action": "navigate", "url": start_url, "thought": "Open the site from the playbook."}

    fields = [e for e in els if e["tag"] in ("input", "select", "textarea") and e["type"] not in ("submit", "button", "hidden")]
    if fields:
        for e in fields:
            if e["value"]:
                continue
            label = norm(e["label"] or e["text"])
            act = fill_value(e, label, g, profile, answers)
            if act:
                return act
        submit = next((e for e in els if e["type"] == "submit" or re.search(r"submit|apply|save|send", norm(e["text"]))
                       and e["tag"] == "button"), None)
        if submit:
            return {"action": "click", "id": submit["id"], "thought": "All required fields are filled; submit."}

    links = [e for e in els if e["tag"] in ("a", "button")]
    if re.search(r"sign in|log in|login", text, re.I):
        for e in links:
            if re.search(r"login|log in|sign in|sso", norm(e["text"])):
                return {"action": "click", "id": e["id"], "thought": "Sign in with company SSO first."}
    goal_words = set(norm(goal).split())
    best, best_score = None, 0
    for e in links:
        words = set(norm(e["text"]).split())
        score = len(words & goal_words) / (len(words) or 1)
        if score > best_score:
            best, best_score = e, score
    if best and best_score >= 0.5:
        return {"action": "click", "id": best["id"], "thought": f"'{best['text']}' matches the goal."}
    return {"action": "fail", "summary": "I could not work out the next step on this page.", "thought": "No match."}


def fill_value(e, label, g, profile, answers):
    def act(value, why):
        kind = "select" if e["tag"] == "select" else "type"
        return {"action": kind, "id": e["id"], "value": value, "thought": why}

    def ask(field, question, remember, options=None):
        if field in answers and answers[field]:
            return act(answers[field], f"You told me {field} earlier.")
        q = {"action": "ask_user", "field": field, "question": question, "remember": remember, "thought": "Not in goal or profile."}
        if options:
            q["options"] = options
        return q

    if e["tag"] == "select":
        opts = [o for o in e["options"] if o and not o.startswith("--")]
        for o in opts:
            if norm(o).split()[0] in g["text"]:
                return act(o, f"Goal mentions {o}.")
        return ask(re.sub(" ", "_", label), f"Which {e['label'] or 'option'}?", False, opts)
    if "employee" in label and "id" in label:
        return act(profile["employee_id"], "Employee ID from profile.") if profile.get("employee_id") else ask("employee_id", "What is your employee ID?", True)
    if e["type"] == "date" or "date" in label:
        if re.search(r"\b(from|start)\b", label) and g["start"]:
            return act(g["start"].isoformat(), "Start date from the goal.")
        if re.search(r"\b(to|end|till|until)\b", label) and g["end"]:
            return act(g["end"].isoformat(), "End date from the goal.")
        return ask(label.replace(" ", "_"), f"What should I enter for {e['label']}?", False)
    if "reason" in label:
        return act(g["reason"], "Reason from the goal.") if g["reason"] else ask("reason", "What reason should I give?", False)
    if "emergency" in label:
        return act(profile["emergency_contact"], "Emergency contact from profile.") if profile.get("emergency_contact") \
            else ask("emergency_contact", "What is your emergency contact number (10 digits)? I'll remember it for next time.", True)
    if "manager" in label:
        return act(profile["manager"], "Manager from profile.") if profile.get("manager") else ask("manager", "Who is your reporting manager?", True)
    for key, value in profile.items():
        if norm(key) and norm(key) in label:
            return act(value, f"{key} from profile.")
    if e["required"]:
        field = label.replace(" ", "_")
        return ask(field, f"What should I enter for '{e['label']}'?", True)
    return None


STRICT = os.environ.get("STANDIN_STRICT") == "1"   # behave like a minimal server: no JSON mode, no system role


@app.post("/v1/chat/completions")
def chat(body: dict):
    if STRICT and body.get("response_format"):
        return JSONResponse({"error": "response_format is not supported by this server"}, status_code=400)
    if STRICT and any(m["role"] == "system" for m in body["messages"]):
        return JSONResponse({"error": "System role not supported by the chat template"}, status_code=400)
    prompt = body["messages"][-1]["content"]
    if "GOAL:" not in prompt:
        content = "OK"
    else:
        content = json.dumps(decide(prompt))
    return {"id": f"standin-{time.time_ns()}", "object": "chat.completion", "model": body.get("model", "stand-in-v1"),
            "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}]}


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": "stand-in-v1", "object": "model"}]}
