#!/usr/bin/env bash
# Third condition: the taught canteen playbook after a human review (copied demo values generalised,
# desk-number step made explicit), 3 runs with Gemma 4 E4B.
ROOT=/home/user/browser-agent
"$ROOT/reset-data.sh"
/home/user/models/serve.sh /home/user/models/gemma4-e4b-q4_k_m.gguf || exit 1
AGENT_TODAY=2026-10-18 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME=gemma4-e4b \
  "$ROOT/start-services.sh" >/dev/null
python3 - <<'PY'
import sqlite3, datetime
steps = """Start URL: http://intranet.office.local:8300/
1. Click link "Canteen Orders"
2. Click link "Sign in with company account"
3. Click link "Order Food"
4. For each item in the request, click its "Add one <item>" button (once per portion)
5. Click the meal slot button from the request (Breakfast, Lunch or Snacks)
6. Click button "Deliver to my desk" (or "Pick up at counter" if the request says so)
7. Ask the user for their desk number (it is NOT the employee ID or asset tag) and type it into "Desk number"
8. Click button "Place Order"
9. A confirmation pop-up appears: click button "Yes, place order"
10. The page shows "Order placed" with a reference number"""
con = sqlite3.connect("/home/user/browser-agent/backend/agent.db", timeout=30)
con.execute("INSERT INTO site_playbooks (site, task, steps, updated_by, updated_at, status, source) VALUES "
            "('canteen.office.local', 'Order food from the canteen', ?, 'EMP0001 (reviewed)', ?, 'active', 'teach')",
            (steps, datetime.datetime.utcnow().isoformat()))
con.commit()
PY
echo "=================== gemma4-e4b canteen: WITH REVIEWED playbook  $(date +%T)"
(cd "$ROOT/tests" && REPEAT=3 xvfb-run -a node eval.mjs "teach-gemma4-e4b-canteen-reviewed" canteen)
pkill -x llama-server
echo "REVIEWED FINISHED $(date +%T)"
