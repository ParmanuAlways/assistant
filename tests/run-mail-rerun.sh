#!/usr/bin/env bash
# After the pipeline: re-run Gemma 4 E4B's mail tasks with the fixed page reader (row labels).
ROOT=/home/user/browser-agent
while pgrep -f run-pipeline.sh >/dev/null; do sleep 30; done
mv "$ROOT/eval-results/mail-gemma4-e4b" "$ROOT/eval-results-archive/mail-gemma4-e4b-old-reader" 2>/dev/null
MODELS=gemma4-e4b "$ROOT/tests/run-mail.sh"
echo "MAIL RERUN FINISHED $(date +%T)"
