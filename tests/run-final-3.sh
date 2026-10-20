#!/usr/bin/env bash
# Final numbers with the final code: intranet regression, Legacy ERP, vision.
ROOT=/home/user/browser-agent
m=gemma4-e4b
start() {
  "$ROOT/reset-data.sh"
  MMPROJ="${MMPROJ:-}" /home/user/models/serve.sh "/home/user/models/${m}-q4_k_m.gguf" || exit 1
  env $1 AGENT_TODAY="${TODAY:-2026-10-19}" AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 \
    DEFAULT_MODEL_NAME="$m" "$ROOT/start-services.sh" >/dev/null
}
TODAY=2026-10-18 start ""
echo "=================== intranet regression (final)  $(date +%T)"
(cd "$ROOT/tests" && TASKSET=intranet TASK_MINUTES=20 xvfb-run -a node eval.mjs "final-intranet")
python3 "$ROOT/tests/regress.py" "$ROOT/eval-results/gemma4-e4b+fixes" "$ROOT/eval-results/final-intranet"
start ""
echo "=================== legacy (final)  $(date +%T)"
(cd "$ROOT/tests" && TASKSET=legacy TASK_MINUTES=20 xvfb-run -a node eval.mjs "legacy-final")
python3 "$ROOT/tests/regress.py" "$ROOT/eval-results/legacy-baseline-fair" "$ROOT/eval-results/legacy-final"
MMPROJ=/home/user/models/gemma4-e4b-mmproj.gguf start "AGENT_VISION=1"
echo "=================== vision ON (final)  $(date +%T)"
(cd "$ROOT/tests" && TASKSET=vision REPEAT=2 TASK_MINUTES=20 xvfb-run -a node eval.mjs "vision-on")
pkill -x llama-server
echo "FINAL-3 FINISHED $(date +%T)"
