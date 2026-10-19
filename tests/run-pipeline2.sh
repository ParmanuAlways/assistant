#!/usr/bin/env bash
# Remaining experiments, one after another: teach mode, model-agnostic checks, mail reruns with all fixes.
ROOT=/home/user/browser-agent
"$ROOT/tests/run-teach.sh"
"$ROOT/tests/run-agnostic.sh"
for m in gemma4-e4b qwen3.5-4b; do
  mv "$ROOT/eval-results/mail-$m" "$ROOT/eval-results-archive/mail-$m-before-fixes" 2>/dev/null
  MODELS=$m "$ROOT/tests/run-mail.sh"
done
echo "PIPELINE2 FINISHED $(date +%T)"
