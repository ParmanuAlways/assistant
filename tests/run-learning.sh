#!/usr/bin/env bash
# Learning experiments on the Legacy ERP with Gemma 4 E4B:
#  1. experiences: each task twice in a row; the 2nd run can replay what worked in the 1st
#  2. teach: a person demonstrates a travel request once (different values), then the travel task twice
ROOT=/home/user/browser-agent
m=gemma4-e4b
start() {
  "$ROOT/reset-data.sh"
  /home/user/models/serve.sh "/home/user/models/${m}-q4_k_m.gguf" || exit 1
  AGENT_TODAY=2026-10-19 AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME="$m" \
    "$ROOT/start-services.sh" >/dev/null
}
start
echo "=================== experiences (REPEAT=2)  $(date +%T)"
(cd "$ROOT/tests" && TASKSET=legacy REPEAT=2 TASK_MINUTES=20 xvfb-run -a node eval.mjs "legacy-final-x2")
start
echo "=================== teach legacy travel  $(date +%T)"
(cd "$ROOT/tests" && xvfb-run -a node teach.mjs "$m-legacytravel" legacytravel)
echo "=================== travel with the taught workflow (x2)  $(date +%T)"
(cd "$ROOT/tests" && TASKSET=legacy REPEAT=2 TASK_MINUTES=20 xvfb-run -a node eval.mjs "legacy-taught-x2" L1-travel)
echo "LEARNING FINISHED $(date +%T)"
