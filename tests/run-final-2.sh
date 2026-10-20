#!/usr/bin/env bash
# Remaining measurements after the fixes found in run-final-all.sh.
ROOT=/home/user/browser-agent
m=gemma4-e4b
start() {
  "$ROOT/reset-data.sh"
  MMPROJ="${MMPROJ:-}" /home/user/models/serve.sh "/home/user/models/${m}-q4_k_m.gguf" || exit 1
  env $1 AGENT_TODAY="${TODAY:-2026-10-19}" AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 \
    DEFAULT_MODEL_NAME="$m" "$ROOT/start-services.sh" >/dev/null
}
start ""
echo "=================== teach legacy travel  $(date +%T)"
(cd "$ROOT/tests" && xvfb-run -a node teach.mjs "$m-legacytravel" legacytravel)
echo "=================== travel with the taught workflow (x2)  $(date +%T)"
(cd "$ROOT/tests" && TASKSET=legacy REPEAT=2 TASK_MINUTES=20 xvfb-run -a node eval.mjs "legacy-taught-x2" L1-travel)
MMPROJ=/home/user/models/gemma4-e4b-mmproj.gguf start "AGENT_VISION=1"
echo "=================== vision ON  $(date +%T)"
(cd "$ROOT/tests" && TASKSET=vision REPEAT=2 TASK_MINUTES=20 xvfb-run -a node eval.mjs "vision-on")
TODAY=2026-10-18 start ""
echo "=================== intranet regression  $(date +%T)"
(cd "$ROOT/tests" && TASKSET=intranet TASK_MINUTES=20 xvfb-run -a node eval.mjs "final-intranet")
python3 "$ROOT/tests/regress.py" "$ROOT/eval-results/gemma4-e4b+fixes" "$ROOT/eval-results/final-intranet"
pkill -x llama-server
echo "FINAL-2 FINISHED $(date +%T)"
