#!/usr/bin/env bash
# Fourth round: a retry click on a drawing at a new point is not taken for a repeated step. Seat map with Gemma 4 E4B,
# then the end-to-end test (stand-in model) as a regression check.
ROOT=/home/user/browser-agent
m=gemma4-e4b
(cd "$ROOT/extension" && npm run build >/dev/null 2>&1 && npm run build:firefox >/dev/null 2>&1) || { echo "BUILD FAILED"; exit 1; }
cd "$ROOT/tests"
"$ROOT/reset-data.sh" >/dev/null 2>&1
MMPROJ=/home/user/models/gemma4-e4b-mmproj.gguf /home/user/models/serve.sh "/home/user/models/${m}-q4_k_m.gguf" >/dev/null || exit 1
AGENT_VISION=1 AGENT_TODAY=2026-10-19 AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME="$m" \
  "$ROOT/start-services.sh" >/dev/null 2>&1 </dev/null
echo "=================== seat map (retry not taken for a repeat)  $(date +%T)"
TASKSET=vision REPEAT=2 TASK_MINUTES=20 xvfb-run -a node eval.mjs nb-fix4-vision
pkill -x llama-server
"$ROOT/reset-data.sh" >/dev/null 2>&1; export AGENT_TODAY=2026-10-18; "$ROOT/start-services.sh" >/dev/null 2>&1 </dev/null
echo "== e2e"; timeout 1200 xvfb-run -a node e2e.mjs 2>&1 | grep -E "FAIL|checks passed"
echo "FOLLOWUP4 FINISHED $(date +%T)"
