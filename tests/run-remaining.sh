#!/usr/bin/env bash
# Finishes the improved runs that the container restart interrupted.
ROOT=/home/user/browser-agent
run() {  # model label tasks
  "$ROOT/reset-data.sh"
  /home/user/models/serve.sh "/home/user/models/$1-q4_k_m.gguf" || return
  AGENT_TODAY=2026-10-18 AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME="$1" \
    "$ROOT/start-services.sh" >/dev/null
  echo "=================== $2  $(date +%T)"
  (cd "$ROOT/tests" && xvfb-run -a node eval.mjs "$2" "$3")
}
run qwen3.5-4b "qwen3.5-4b+fixes-part2" rooms,visitors,canteen
run gemma4-e4b "gemma4-e4b+fixes-visitors" visitors
pkill -x llama-server
echo "REMAINING FINISHED $(date +%T)"
