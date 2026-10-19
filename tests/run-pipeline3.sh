#!/usr/bin/env bash
# Remaining experiments in sequence (after the loop-guard fix).
ROOT=/home/user/browser-agent
CASES="qwen3.5-4b helpdesk" "$ROOT/tests/run-teach.sh"
"$ROOT/tests/run-reviewed.sh"
"$ROOT/tests/run-agnostic.sh"
for m in gemma4-e4b qwen3.5-4b; do
  mv "$ROOT/eval-results/mail-$m" "$ROOT/eval-results-archive/mail-$m-before-fixes" 2>/dev/null
  MODELS=$m "$ROOT/tests/run-mail.sh"
done
echo "PIPELINE3 FINISHED $(date +%T)"
