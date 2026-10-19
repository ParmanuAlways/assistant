#!/usr/bin/env bash
# Re-runs models with the calendar + JSON-schema improvements switched on.
ROOT=/home/user/browser-agent
for m in ${MODELS:-gemma4-e4b qwen3.5-4b}; do
  echo "=================== $m+fixes  $(date +%T)"
  "$ROOT/reset-data.sh"
  /home/user/models/serve.sh "/home/user/models/${m}-q4_k_m.gguf" || continue
  AGENT_TODAY=2026-10-18 AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME="$m" \
    "$ROOT/start-services.sh" >/dev/null
  (cd "$ROOT/tests" && xvfb-run -a node eval.mjs "$m+fixes")
done
pkill -x llama-server
echo "IMPROVED FINISHED $(date +%T)"
