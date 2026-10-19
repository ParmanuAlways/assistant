#!/usr/bin/env bash
# Teach-mode experiment: 3 runs without a taught playbook, teach the workflow once, 3 runs with it.
ROOT=/home/user/browser-agent
IFS=, read -ra CASE_LIST <<< "${CASES:-gemma4-e4b canteen,qwen3.5-4b helpdesk}"
for c in "${CASE_LIST[@]}"; do
  set -- $c; m=$1; task=$2
  "$ROOT/reset-data.sh"
  /home/user/models/serve.sh "/home/user/models/${m}-q4_k_m.gguf" || continue
  AGENT_TODAY=2026-10-18 AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME="$m" \
    "$ROOT/start-services.sh" >/dev/null
  if [ ! -f "$ROOT/eval-results/teach-$m-$task-before/results.json" ]; then
    echo "=================== $m $task: WITHOUT playbook  $(date +%T)"
    (cd "$ROOT/tests" && REPEAT=3 xvfb-run -a node eval.mjs "teach-$m-$task-before" "$task")
  fi
  echo "=================== $m $task: TEACHING  $(date +%T)"
  (cd "$ROOT/tests" && xvfb-run -a node teach.mjs "$m-$task" "$task")
  echo "=================== $m $task: WITH taught playbook  $(date +%T)"
  (cd "$ROOT/tests" && REPEAT=3 xvfb-run -a node eval.mjs "teach-$m-$task-after" "$task")
done
pkill -x llama-server
echo "TEACH FINISHED $(date +%T)"
