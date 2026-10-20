#!/usr/bin/env bash
# Second round of fixes: e-mail addresses only from the request / directory (guesses flagged), teams found in the
# directory, a click on a drawing that picks a neighbour is retried. Webmail and the seat map with Gemma 4 E4B,
# then the fast suite on the final build.
ROOT=/home/user/browser-agent
m=gemma4-e4b
start() {
  "$ROOT/reset-data.sh" >/dev/null 2>&1
  MMPROJ="${MMPROJ:-}" /home/user/models/serve.sh "/home/user/models/${m}-q4_k_m.gguf" >/dev/null || exit 1
  env $2 AGENT_TODAY="$1" AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME="$m" \
    "$ROOT/start-services.sh" >/dev/null 2>&1 </dev/null
}
(cd "$ROOT/extension" && npm run build >/dev/null 2>&1 && npm run build:firefox >/dev/null 2>&1) || { echo "BUILD FAILED"; exit 1; }
cd "$ROOT/tests"
start 2026-10-18
echo "=================== webmail (addresses from the directory, guesses flagged)  $(date +%T)"
TASKSET=mail TASK_MINUTES=20 xvfb-run -a node eval.mjs nb-fix2-mail
MMPROJ=/home/user/models/gemma4-e4b-mmproj.gguf start 2026-10-19 AGENT_VISION=1
echo "=================== seat map (a neighbour picked by mistake is retried)  $(date +%T)"
TASKSET=vision REPEAT=2 TASK_MINUTES=20 xvfb-run -a node eval.mjs nb-fix2-vision
pkill -x llama-server
"$ROOT/reset-data.sh" >/dev/null 2>&1; export AGENT_TODAY=2026-10-18; "$ROOT/start-services.sh" >/dev/null 2>&1 </dev/null
echo "=================== fast suite on the final build  $(date +%T)"
"$ROOT/tests/run-fast-suite.sh"
echo "FOLLOWUP2 FINISHED $(date +%T)"
