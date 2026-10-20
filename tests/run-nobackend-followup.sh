#!/usr/bin/env bash
# After the fixes found by run-nobackend-model.sh: the failed tasks again, taught playbooks used in the same browser
# and shared through policy to another browser (Gemma 4 E4B), then the fast suite (stand-in model).
ROOT=/home/user/browser-agent
m=gemma4-e4b
start() {   # $1 = date the task data assumes, $2 = extra env
  "$ROOT/reset-data.sh" >/dev/null 2>&1
  MMPROJ="${MMPROJ:-}" /home/user/models/serve.sh "/home/user/models/${m}-q4_k_m.gguf" >/dev/null || exit 1
  env $2 AGENT_TODAY="$1" AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME="$m" \
    "$ROOT/start-services.sh" >/dev/null 2>&1 </dev/null
}
(cd "$ROOT/extension" && npm run build >/dev/null 2>&1 && npm run build:firefox >/dev/null 2>&1) || { echo "BUILD FAILED"; exit 1; }
cd "$ROOT/tests"
start 2026-10-18
echo "=================== visitors again (required choice is asked)  $(date +%T)"
TASKSET=intranet TASK_MINUTES=20 xvfb-run -a node eval.mjs nb-fix-visitors visitors
start 2026-10-19
echo "=================== purchase twice again (suggestion pick, lookup button)  $(date +%T)"
TASKSET=legacy REPEAT=2 TASK_MINUTES=20 xvfb-run -a node eval.mjs nb-fix-purchase L2-purchase
start 2026-10-19
P=/tmp/claude-0/taught-browser; rm -rf "$P"
echo "=================== teach, then travel twice in the same browser  $(date +%T)"
PROFILE_DIR="$P" xvfb-run -a node teach.mjs "nb-same-$m-legacytravel" legacytravel | grep -E "DRAFT QUALITY|SAVED|CRASH"
PROFILE_DIR="$P" TASKSET=legacy REPEAT=2 TASK_MINUTES=20 xvfb-run -a node eval.mjs nb-taught-same-browser L1-travel
start 2026-10-19
echo "=================== the taught playbook shared through policy, used in another browser  $(date +%T)"
SHARED_PLAYBOOKS="$ROOT/eval-results/teach-nb-same-$m-legacytravel/playbook-policy.json" TASKSET=legacy TASK_MINUTES=20 \
  xvfb-run -a node eval.mjs nb-taught-via-policy L1-travel
MMPROJ=/home/user/models/gemma4-e4b-mmproj.gguf start 2026-10-19 AGENT_VISION=1
echo "=================== seat map again (a missed click is retried closer)  $(date +%T)"
TASKSET=vision REPEAT=2 TASK_MINUTES=20 xvfb-run -a node eval.mjs nb-fix-vision
start 2026-10-18
echo "=================== webmail again (a colleague's address is not flagged as yours)  $(date +%T)"
TASKSET=mail TASK_MINUTES=20 xvfb-run -a node eval.mjs nb-fix-mail
pkill -x llama-server
"$ROOT/reset-data.sh" >/dev/null 2>&1; export AGENT_TODAY=2026-10-18; "$ROOT/start-services.sh" >/dev/null 2>&1 </dev/null
echo "=================== fast suite again  $(date +%T)"
"$ROOT/tests/run-fast-suite.sh"
echo "FOLLOWUP FINISHED $(date +%T)"
