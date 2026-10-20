#!/usr/bin/env bash
# The real-model evaluations again, now that the assistant has no server (Gemma 4 E4B on CPU), each compared with
# the run before the move: intranet apps, hard web apps with learning (each task twice), teach + replay, vision on
# a canvas, webmail with a prompt-injection email.  Labels: nb-*
ROOT=/home/user/browser-agent
m=gemma4-e4b
start() {   # $1 = date the task data assumes, $2 = extra env
  "$ROOT/reset-data.sh" >/dev/null 2>&1
  MMPROJ="${MMPROJ:-}" /home/user/models/serve.sh "/home/user/models/${m}-q4_k_m.gguf" >/dev/null || exit 1
  env $2 AGENT_TODAY="$1" AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME="$m" \
    "$ROOT/start-services.sh" >/dev/null 2>&1 </dev/null
}
cmp() { python3 "$ROOT/tests/regress.py" "$ROOT/eval-results/$1" "$ROOT/eval-results/$2" 2>&1 | tail -15; }
cd "$ROOT/tests"
start 2026-10-18
echo "=================== intranet  $(date +%T)"
TASKSET=intranet TASK_MINUTES=20 xvfb-run -a node eval.mjs nb-intranet; cmp final-intranet nb-intranet
start 2026-10-19
echo "=================== hard web apps, each twice (learning)  $(date +%T)"
TASKSET=legacy REPEAT=2 TASK_MINUTES=20 xvfb-run -a node eval.mjs nb-legacy-x2; cmp legacy-final-x2 nb-legacy-x2
start 2026-10-19
echo "=================== teach legacy travel, then travel twice  $(date +%T)"
xvfb-run -a node teach.mjs "nb-$m-legacytravel" legacytravel | grep -E "DRAFT QUALITY|SAVED|CRASH"
TASKSET=legacy REPEAT=2 TASK_MINUTES=20 xvfb-run -a node eval.mjs nb-legacy-taught-x2 L1-travel; cmp legacy-taught-x2 nb-legacy-taught-x2
MMPROJ=/home/user/models/gemma4-e4b-mmproj.gguf start 2026-10-19 AGENT_VISION=1
echo "=================== vision on  $(date +%T)"
TASKSET=vision REPEAT=2 TASK_MINUTES=20 xvfb-run -a node eval.mjs nb-vision-on; cmp vision-on nb-vision-on
start 2026-10-18
echo "=================== webmail  $(date +%T)"
TASKSET=mail TASK_MINUTES=20 xvfb-run -a node eval.mjs nb-mail; cmp mail-gemma4-e4b nb-mail
pkill -x llama-server
echo "MODEL RUNS FINISHED $(date +%T)"
