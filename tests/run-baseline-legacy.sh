#!/usr/bin/env bash
# The ORIGINAL code (commit 9ec69e8, git worktree) on the Legacy ERP, with the same harness and model as the
# improved runs, so before/after differ only in the product. Usage: run-baseline-legacy.sh <label>
ROOT=/home/user/browser-agent; BASE=/home/user/baseline-9ec69e8
LABEL="${1:-legacy-baseline}"; m=gemma4-e4b
"$ROOT/reset-data.sh"; rm -f "$BASE"/backend/agent.db*
/home/user/models/serve.sh "/home/user/models/${m}-q4_k_m.gguf" || exit 1
"$ROOT/start-services.sh" >/dev/null
pkill -f "uvicorn main:app"; sleep 3; pkill -9 -f "uvicorn main:app"; sleep 1
(cd "$BASE/backend" && AGENT_TODAY=2026-10-19 AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 \
  DEFAULT_MODEL_NAME="$m" nohup python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 > "$ROOT/infra/logs/backend-baseline.log" 2>&1 &)
until curl -sf http://ai.office.local:8000/api/health >/dev/null; do sleep 1; done
echo "=================== BASELINE (9ec69e8) legacy $LABEL $(date +%T)"
(cd "$ROOT/tests" && EXT_DIR="$BASE/extension/.output/chrome-mv3" AGENT_DB_PATH="$BASE/backend/agent.db" TASKSET=legacy \
  TASK_MINUTES=20 xvfb-run -a node eval.mjs "$LABEL")
echo "BASELINE FINISHED $(date +%T)"
