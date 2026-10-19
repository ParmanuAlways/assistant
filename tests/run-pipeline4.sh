#!/usr/bin/env bash
# Remaining experiments in sequence.
ROOT=/home/user/browser-agent
"$ROOT/tests/run-agnostic.sh"
"$ROOT/tests/run-reviewed.sh"
"$ROOT/tests/run-reviewed-helpdesk.sh"
for m in gemma4-e4b qwen3.5-4b; do
  mv "$ROOT/eval-results/mail-$m" "$ROOT/eval-results-archive/mail-$m-before-fixes" 2>/dev/null
  MODELS=$m "$ROOT/tests/run-mail.sh"
done
echo "PIPELINE4 FINISHED $(date +%T)"
