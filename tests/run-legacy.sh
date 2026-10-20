#!/usr/bin/env bash
# "Hard web" evaluation on the Legacy ERP. Usage: run-legacy.sh <label> [model]
ROOT=/home/user/browser-agent
LABEL="${1:-legacy}"; m="${2:-gemma4-e4b}"
"$ROOT/reset-data.sh"
/home/user/models/serve.sh "/home/user/models/${m}-q4_k_m.gguf" || exit 1
AGENT_TODAY=2026-10-19 AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME="$m" \
  "$ROOT/start-services.sh" >/dev/null
echo "=================== legacy $LABEL $m  $(date +%T)"
(cd "$ROOT/tests" && TASKSET=legacy TASK_MINUTES="${TASK_MINUTES:-20}" xvfb-run -a node eval.mjs "$LABEL" $ONLY)
echo "LEGACY FINISHED $(date +%T)"
