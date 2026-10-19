#!/usr/bin/env bash
# Qwen 3.5 4B on the helpdesk with the taught playbook after human review (3 runs).
ROOT=/home/user/browser-agent
"$ROOT/reset-data.sh"
/home/user/models/serve.sh /home/user/models/qwen3.5-4b-q4_k_m.gguf || exit 1
AGENT_TODAY=2026-10-18 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME=qwen3.5-4b \
  "$ROOT/start-services.sh" >/dev/null
python3 - <<'PY'
import sqlite3, datetime
steps = """Start URL: http://intranet.office.local:8300/
1. Click link "IT Service Desk"
2. Click link "Sign in with company account" if shown
3. Click link "Raise a Ticket"
4. Select the Category that fits the problem: Hardware (laptop, screen, keyboard), Software (apps), Network, Access / Accounts
5. Click the Priority radio button that matches the request (urgent = High; down for everyone = Critical; otherwise Medium)
6. Type a short Subject describing the problem
7. Type the problem from the request into "Describe the problem"
8. Ask the user for their laptop's Asset Tag (sticker under the laptop, looks like LT-1234) and type it into "Asset Tag"
9. Click button "Raise Ticket"
10. The page shows "Ticket raised" with a reference number (INC-xxxx)"""
con = sqlite3.connect("/home/user/browser-agent/backend/agent.db", timeout=30)
con.execute("INSERT INTO site_playbooks (site, task, steps, updated_by, updated_at, status, source) VALUES "
            "('helpdesk.office.local', 'Raise an IT support ticket', ?, 'EMP0001 (reviewed)', ?, 'active', 'teach')",
            (steps, datetime.datetime.utcnow().isoformat()))
con.commit()
PY
echo "=================== qwen3.5-4b helpdesk: WITH REVIEWED playbook  $(date +%T)"
(cd "$ROOT/tests" && REPEAT=3 xvfb-run -a node eval.mjs "teach-qwen3.5-4b-helpdesk-reviewed" helpdesk)
pkill -x llama-server
echo "REVIEWED HELPDESK FINISHED $(date +%T)"
