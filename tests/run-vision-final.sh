#!/usr/bin/env bash
# Vision fallback on the canvas seat map, twice, Gemma 4 E4B with its image projector.
ROOT=/home/user/browser-agent
"$ROOT/reset-data.sh"
MMPROJ=/home/user/models/gemma4-e4b-mmproj.gguf /home/user/models/serve.sh /home/user/models/gemma4-e4b-q4_k_m.gguf || exit 1
AGENT_VISION=1 AGENT_TODAY=2026-10-19 AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 \
  DEFAULT_MODEL_NAME=gemma4-e4b "$ROOT/start-services.sh" >/dev/null
echo "=================== vision ON (final)  $(date +%T)"
(cd "$ROOT/tests" && TASKSET=vision REPEAT=2 TASK_MINUTES=20 xvfb-run -a node eval.mjs "vision-on")
pkill -x llama-server
echo "VISION FINISHED $(date +%T)"
