#!/usr/bin/env bash
# After pipeline 4: one more Gemma mail run with the page-settling fix.
ROOT=/home/user/browser-agent
sleep 60
while pgrep -f "run-pipeline4.sh" >/dev/null; do sleep 30; done
mv "$ROOT/eval-results/mail-gemma4-e4b" "$ROOT/eval-results-archive/mail-gemma4-e4b-before-settle" 2>/dev/null
MODELS=gemma4-e4b "$ROOT/tests/run-mail.sh"
echo "MAIL FINAL FINISHED $(date +%T)"
