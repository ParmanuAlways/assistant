#!/usr/bin/env bash
# Runs the 7-task evaluation for each model in turn (fresh data per model).
ROOT=/home/user/browser-agent
MODELS="${MODELS:-standin gemma3-1b qwen3.5-2b gemma4-e2b llama3.2-3b qwen3.5-4b gemma4-e4b qwen3.5-9b}"
for m in $MODELS; do
  echo "=================== $m  $(date +%T)"
  "$ROOT/reset-data.sh"
  if [ "$m" = standin ]; then
    pkill -x llama-server; "$ROOT/start-services.sh" >/dev/null
  else
    f="/home/user/models/${m}-q4_k_m.gguf"
    while [ ! -f "$f" ]; do sleep 30; done      # still downloading
    /home/user/models/serve.sh "$f" || continue
    DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME="$m" "$ROOT/start-services.sh" >/dev/null
  fi
  (cd "$ROOT/tests" && xvfb-run -a node eval.mjs "$m")
done
pkill -x llama-server
echo "EVAL FINISHED $(date +%T)"
