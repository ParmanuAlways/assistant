#!/usr/bin/env bash
# Vision fallback test: Gemma 4 E4B with its image projector, on the canvas seat map. Usage: run-vision.sh <label> [0|1]
ROOT=/home/user/browser-agent
LABEL="${1:-vision}"; VISION="${2:-1}"
"$ROOT/reset-data.sh"
MMPROJ=$([ "$VISION" = 1 ] && echo /home/user/models/gemma4-e4b-mmproj.gguf) /home/user/models/serve.sh /home/user/models/gemma4-e4b-q4_k_m.gguf || exit 1
AGENT_VISION=$VISION AGENT_TODAY=2026-10-19 AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 \
  DEFAULT_MODEL_NAME=gemma4-e4b "$ROOT/start-services.sh" >/dev/null
echo "=================== vision $LABEL (AGENT_VISION=$VISION) $(date +%T)"
(cd "$ROOT/tests" && TASKSET=vision TASK_MINUTES=20 REPEAT="${REPEAT:-1}" xvfb-run -a node eval.mjs "$LABEL")
echo "VISION FINISHED $(date +%T)"
