#!/usr/bin/env bash
# After the clean improved runs finish, re-run Gemma 4 E4B's visitor task with the completed scripted user.
ROOT=/home/user/browser-agent
while pgrep -f run-improved.sh >/dev/null; do sleep 30; done
"$ROOT/reset-data.sh"
/home/user/models/serve.sh /home/user/models/gemma4-e4b-q4_k_m.gguf || exit 1
AGENT_TODAY=2026-10-18 AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME=gemma4-e4b \
  "$ROOT/start-services.sh" >/dev/null
echo "=================== gemma4-e4b+fixes-visitors  $(date +%T)"
(cd "$ROOT/tests" && xvfb-run -a node eval.mjs "gemma4-e4b+fixes-visitors" visitors)
pkill -x llama-server
echo "FOLLOWUP FINISHED $(date +%T)"
