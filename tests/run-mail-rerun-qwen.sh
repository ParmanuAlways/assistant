#!/usr/bin/env bash
# After Gemma's mail rerun: re-run Qwen 3.5 4B's mail tasks with every fix in place.
ROOT=/home/user/browser-agent
sleep 120
while pgrep -f "run-mail-rerun.sh|run-pipeline.sh" >/dev/null; do sleep 30; done
mv "$ROOT/eval-results/mail-qwen3.5-4b" "$ROOT/eval-results-archive/mail-qwen3.5-4b-old" 2>/dev/null
MODELS=qwen3.5-4b "$ROOT/tests/run-mail.sh"
echo "MAIL RERUN QWEN FINISHED $(date +%T)"
