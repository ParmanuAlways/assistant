#!/usr/bin/env bash
# Webmail evaluation (Roundcube + real IMAP/SMTP) for the best models, all fixes on.
ROOT=/home/user/browser-agent
for m in ${MODELS:-gemma4-e4b qwen3.5-4b}; do
  "$ROOT/reset-data.sh"
  /home/user/models/serve.sh "/home/user/models/${m}-q4_k_m.gguf" || continue
  AGENT_TODAY=2026-10-18 AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME="$m" \
    "$ROOT/start-services.sh" >/dev/null
  echo "=================== mail $m  $(date +%T)"
  (cd "$ROOT/tests" && TASKSET=mail xvfb-run -a node eval.mjs "mail-$m")
done
pkill -x llama-server
echo "MAIL FINISHED $(date +%T)"
