"""Fast backend checks (no browser, no model): verifier, provenance, workflows, vision messages.
Usage: python3 tests/unit_backend.py"""
import json
import sys
import threading
from datetime import date
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
import agent  # noqa: E402
import skills  # noqa: E402

T = date(2026, 10, 19)
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  — {detail}" if detail and not ok else ""))


# ---- dates and numbers in requests
check("dates: '21 Oct 2026 to 23 Oct 2026'", agent.parse_dates("from 21 Oct 2026 to 23 Oct 2026", T) == {"2026-10-21", "2026-10-23"})
check("dates: field formats", agent.parse_dates("21-Oct-2026", T) == {"2026-10-21"} and agent.parse_dates("21/10/2026", T) == {"2026-10-21"})
check("dates: no year means this year", agent.parse_dates("on 2 Nov", T) == {"2026-11-02"})
check("numbers: amounts/IDs/phones, not dates", agent.goal_numbers("2 chairs at 8,500 each, PO-1077, 9123400000, on 21 Oct 2026", T)
      == ["8,500", "1077", "9123400000"])

# ---- verifier
fields = [{"label": "Destination", "value": "Pune"}, {"label": "From", "value": "21-Oct-2026"}, {"label": "To", "value": "22-Oct-2026"}]
c = agent.verify_submission("travel to Pune from 21 Oct 2026 to 23 Oct 2026", fields, T)
check("verifier: wrong 'to' date flagged", any("23 Oct 2026" in x for x in c), c)
check("verifier: masked phone accepted", agent.verify_submission("change mobile to 9123400000",
                                                                 [{"label": "Mobile", "value": "91234-00000"}], T) == [])
check("verifier: 1250 vs 1250.00 accepted", agent.verify_submission("claim 1250 rupees", [{"label": "Amount", "value": "1250.00"}], T) == [])
c = agent.verify_submission("approve PO-1077", [{"label": "Page says", "value": "..."}], T, "PO-1070 Acme 1,000 Pending")
check("verifier: wrong table row flagged", any("1077" in x for x in c), c)
check("verifier: right table row ok", agent.verify_submission("approve PO-1077", [{"label": "Page says", "value": "."}], T,
                                                              "PO-1077 Initech 82,287 Pending") == [])

check("verifier: a date shown on the page (not a field) is fine",
      agent.verify_submission("book a room on 21 Oct 2026", [{"label": "Meeting title", "value": "Sprint"}], T,
                              page_text="Tulip · Wed 21 Oct 2026, 15:00-16:00 · 6 people") == [])

# ---- provenance
p = agent.provenance([{"label": "Destination", "value": "Pune"}, {"label": "Phone", "value": "9876500011"},
                      {"label": "Purpose", "value": "Training"}, {"label": "Desk", "value": "B3-114"},
                      {"label": "Country", "value": "India"}],
                     "travel to Pune for a client visit", {"phone": "9876500011"}, ["B3-114"], ["Pune", "Training"], T)
src = {f["label"]: (f.get("source"), f.get("guess", False)) for f in p}
check("provenance: request / profile / answer / page / guess",
      src == {"Destination": ("from your request", False), "Phone": ("from your profile (phone)", False),
              "Purpose": ("chosen by the assistant", True), "Desk": ("you told me", False),
              "Country": ("already on the page", False)}, src)

p = agent.provenance([{"label": "Emergency Contact Number", "value": "9876500011"}, {"label": "Mobile", "value": "9876500011"}],
                     "apply casual leave", {"phone": "9876500011"}, [], ["9876500011"], T)
c = agent.verify_submission("apply casual leave", p, T)
check("verifier: own phone used as emergency contact is flagged, as mobile it is fine",
      len(c) == 1 and "Emergency Contact Number" in c[0], c)

p = agent.provenance([{"label": "Desk number", "value": "my desk"}], "deliver to my desk", {}, [], ["my desk"], T)
c = agent.verify_submission("deliver to my desk", p, T)
check("verifier: 'my desk' typed as a desk number is flagged", p[0].get("guess") and any(" but " in x for x in c), (p, c))

# ---- confirmation: postback links are buttons, rows are shown
page = {"elements": [{"id": 1, "tag": "a", "text": "Submit", "href": "javascript:__doPostBack('btnSubmit','')", "frame": "main"},
                     {"id": 2, "tag": "input", "label": "Destination", "value": "Pune", "frame": "main"},
                     {"id": 3, "tag": "a", "text": "Travel Request", "href": "http://x/travel", "frame": "nav"},
                     {"id": 4, "tag": "button", "type": "submit", "text": "Approve", "row": "PO-1077 Initech 82,287", "frame": "main"}],
        "text": ""}
c = agent.needs_confirmation({"action": "click", "id": 1}, page)
check("confirm: javascript: postback link needs confirmation, fields from its frame",
      c and c["fields"] == [{"label": "Destination", "value": "Pune"}], c)
check("confirm: plain menu link does not", agent.needs_confirmation({"action": "click", "id": 3}, page) is None)
c = agent.needs_confirmation({"action": "click", "id": 4}, page)
check("confirm: row shown for a row button", c and c["fields"][0] == {"label": "Row", "value": "PO-1077 Initech 82,287"}, c)

# ---- wrong row -> right row, or next page
pg = {"elements": [{"id": 1, "tag": "button", "text": "Approve", "row": "PO-1057 Initech 67,667 Pending", "frame": "main"},
                   {"id": 2, "tag": "button", "text": "Approve", "row": "PO-1058 Umbrella 68,398 Pending", "frame": "main"},
                   {"id": 3, "tag": "a", "text": "Next »", "frame": "main"}]}
f = agent.row_fix({"action": "click", "id": 1}, pg, "approve purchase order PO-1077", T)
check("row fix: target row not on this page -> next page", f and f["id"] == 3, f)
pg["elements"].append({"id": 4, "tag": "button", "text": "Approve", "row": "PO-1077 Initech 82,287 Pending", "frame": "main"})
f = agent.row_fix({"action": "click", "id": 1}, pg, "approve purchase order PO-1077", T)
check("row fix: same button in the matching row", f and f["id"] == 4, f)
check("row fix: right row left alone", agent.row_fix({"action": "click", "id": 4}, pg, "approve purchase order PO-1077", T) is None)

# ---- parser
a = agent.parse_action('{"action":"fill_form","fields":{"12":"Pune","13":"Training"}}')
check("parser: fill_form dict form", a["fields"] == [{"id": 12, "value": "Pune"}, {"id": 13, "value": "Training"}], a)
check("parser: new actions", all(agent.parse_action(json.dumps({"action": x, "id": 1, "value": "2026-10-21"}))["action"] == x
                                 for x in ("pick_date", "autocomplete", "hover", "upload")))

# ---- workflows from a recording
events = [{"kind": "navigate", "url": "http://legacy.office.local:8500/"},
          {"kind": "fill", "label": "User name", "value": "ravi", "url": "http://legacy/login"},
          {"kind": "fill", "label": "Password", "value": "(hidden)", "url": "http://legacy/login"},
          {"kind": "click", "tag": "a", "text": "Travel Request", "menu": "Requests"},
          {"kind": "fill", "label": "Destination city", "value": "Pune"},
          {"kind": "click", "tag": "img", "text": "Pick from date"},
          {"kind": "click", "tag": "td", "text": "21"},
          {"kind": "date", "label": "From date", "value": "21-Oct-2026", "readonly": True},
          {"kind": "click", "tag": "td", "text": "23"},
          {"kind": "choose", "label": "Purpose", "value": "Client visit"},
          {"kind": "click", "tag": "a", "text": "Submit"}]
m = skills.macro_from_teach(events)
acts = [(s["action"], s.get("text") or s.get("label"), bool(s.get("param"))) for s in m]
check("workflow: recording -> fixed and value steps (sign-in left out, calendar clicks folded into pick_date)", acts == [
    ("navigate", None, False), ("click", "Travel Request", False), ("type", "Destination city", True),
    ("pick_date", "From date", True), ("select", "Purpose", True), ("click", "Submit", False)], acts)
state = {"steps": m, "cursor": 0, "label": "taught workflow 'travel'"}
pg = {"elements": [{"id": 5, "tag": "a", "text": "Travel Request", "menu": "Requests"}]}
act, hint = skills.suggest(state, pg, "intranet.office.local")
check("workflow: opens the site first", act and act["action"] == "navigate", act)
act, hint = skills.suggest(state, pg, "legacy.office.local")
check("workflow: replays the menu click without the model", act and act["action"] == "click" and act["id"] == 5, act)
skills.advance(state, act, pg["elements"][0])
act, hint = skills.suggest(state, {"elements": [{"id": 7, "tag": "input", "label": "Destination city"}]}, "legacy.office.local")
check("workflow: value steps go to the model with a hint", act is None and "→ type 'Destination city'" in (hint or ""), hint)
check("learned workflow: a suggestion / lookup entry from the request is a value step",
      skills.is_param_click("Priya Sharma (Engineering)", None, {"priya sharma"}, "", {"tag": "div", "type": "clickable"})
      and skills.is_param_click("Engineering - Bangalore", None, set(), "cost centre Engineering - Bangalore", {"tag": "a", "href": "http://x/lookup#"}))
check("learned workflow: a site/menu link named in the request stays a fixed step",
      not skills.is_param_click("Legacy ERP", None, set(), "In the Legacy ERP, ...", {"tag": "a", "href": "http://legacy/"})
      and not skills.is_param_click("Purchase Request", None, set(), "create a purchase request", {"tag": "a", "menu": "Requests", "href": "http://x/p"}))
st2 = {"steps": [{"action": "type", "label": "User name", "param": True},
                 {"action": "click", "text": "Travel Request", "menu": "Requests", "param": False}], "cursor": 0, "label": "t"}
act, _ = skills.suggest(st2, {"elements": [{"id": 3, "tag": "a", "text": "Travel Request", "menu": "Requests"}]}, "legacy.office.local")
check("workflow: a step whose field is not on the page is skipped", act and act["id"] == 3, act)
st3 = {"steps": [{"action": "click", "text": "Travel Request", "menu": "Requests", "param": False}], "cursor": 0, "label": "t"}
skills.advance(st3, {"action": "click", "id": 3}, {"tag": "input", "type": "submit", "text": "Sign in", "label": None})
check("workflow: an unrelated click (Sign in) does not skip a step", st3["cursor"] == 0, st3)
st4 = {"steps": [{"action": "pick_date", "label": "To date", "param": True}, {"action": "click", "text": "Submit", "param": False}],
       "cursor": 0, "label": "t"}
skills.advance(st4, {"action": "pick_date", "id": 9}, {"tag": "img", "type": "clickable", "text": "Pick to date"})
check("workflow: a field reached through its icon counts as done", st4["cursor"] == 1, st4)
check("workflow: similarity", skills.similarity("raise a travel request to Mumbai for training",
                                                "raise a travel request to Pune for a client visit") >= 0.6)

# ---- vision: the screenshot reaches an OpenAI-compatible server as image_url
seen = {}


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        out = json.dumps({"choices": [{"message": {"content": '{"action":"click_xy","x":10,"y":20,"thought":"t"}'},
                                       "finish_reason": "stop"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


srv = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
msgs = agent.build_messages("click the chart", {}, [], [], {"url": "http://x", "elements": []}, T, image_b64="iVBORw0KGgo=")
reply = agent.call_model({"url": f"http://127.0.0.1:{srv.server_port}/v1", "model": "m"}, msgs)
user = seen["body"]["messages"][-1]["content"]
check("vision: image sent as image_url data URI", isinstance(user, list) and user[1]["image_url"]["url"].startswith("data:image/png;base64,"))
check("vision: click_xy parsed", agent.parse_action(reply) == {"action": "click_xy", "x": 10, "y": 20, "thought": "t"})
srv.shutdown()

print(f"\n{sum(results)}/{len(results)} unit checks passed")
sys.exit(0 if all(results) else 1)
