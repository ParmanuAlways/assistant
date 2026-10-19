#!/usr/bin/env bash
# Re-run the reviewed canteen playbook condition with the empty-value -> ask-the-user fix.
ROOT=/home/user/browser-agent
sleep 90
while pgrep -f "run-pipeline3.sh|run-reviewed-helpdesk.sh" >/dev/null; do sleep 30; done
mv "$ROOT/eval-results/teach-gemma4-e4b-canteen-reviewed" "$ROOT/eval-results-archive/teach-gemma4-e4b-canteen-reviewed-v1" 2>/dev/null
"$ROOT/tests/run-reviewed.sh"
echo "REVIEWED AGAIN FINISHED $(date +%T)"
