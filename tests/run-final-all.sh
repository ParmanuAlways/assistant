#!/usr/bin/env bash
# Final measurements after the improvements (Gemma 4 E4B, CPU).
ROOT=/home/user/browser-agent
m=gemma4-e4b
start() {   # $1 = extra env for the backend
  "$ROOT/reset-data.sh"
  MMPROJ="${MMPROJ:-}" /home/user/models/serve.sh "/home/user/models/${m}-q4_k_m.gguf" || exit 1
  env $1 AGENT_TODAY="${TODAY:-2026-10-19}" AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 \
    export DEFAULT_MODEL_NAME="$m"; "$ROOT/start-services.sh" >/dev/null
}
# 1. teach the travel workflow once, then the travel task twice with it
start ""
echo "=================== teach legacy travel  $(date +%T)"
(cd "$ROOT/tests" && xvfb-run -a node teach.mjs "$m-legacytravel" legacytravel)
echo "=================== travel with the taught workflow (x2)  $(date +%T)"
(cd "$ROOT/tests" && TASKSET=legacy REPEAT=2 TASK_MINUTES=20 xvfb-run -a node eval.mjs "legacy-taught-x2" L1-travel)
# 2. vision fallback on the canvas seat map: without, then with the image projector
start "AGENT_VISION=0"
echo "=================== vision OFF  $(date +%T)"
(cd "$ROOT/tests" && TASKSET=vision TASK_MINUTES=15 xvfb-run -a node eval.mjs "vision-off")
MMPROJ=/home/user/models/gemma4-e4b-mmproj.gguf start "AGENT_VISION=1"
echo "=================== vision ON  $(date +%T)"
(cd "$ROOT/tests" && TASKSET=vision REPEAT=2 TASK_MINUTES=20 xvfb-run -a node eval.mjs "vision-on")
# 3. regression: the original intranet tasks, compared with the best earlier run
TODAY=2026-10-18 start ""
echo "=================== intranet regression  $(date +%T)"
(cd "$ROOT/tests" && TASKSET=intranet TASK_MINUTES=20 xvfb-run -a node eval.mjs "final-intranet")
python3 "$ROOT/tests/regress.py" "$ROOT/eval-results/gemma4-e4b+fixes" "$ROOT/eval-results/final-intranet"
pkill -x llama-server
# 4. end-to-end test with the stand-in model
"$ROOT/reset-data.sh"; export AGENT_TODAY=2026-10-18; "$ROOT/start-services.sh" >/dev/null
(cd "$ROOT/tests" && xvfb-run -a node e2e.mjs 2>&1 | grep -E "FAIL|checks passed" | sed 's/^/E2E /')
echo "FINAL-ALL FINISHED $(date +%T)"
