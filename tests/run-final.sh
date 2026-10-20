#!/usr/bin/env bash
# Regression test, then the final webmail runs for both models with every fix.
ROOT=/home/user/browser-agent
"$ROOT/reset-data.sh"; pkill -x llama-server
export AGENT_TODAY=2026-10-18; "$ROOT/start-services.sh" >/dev/null
(cd "$ROOT/tests" && xvfb-run -a node e2e.mjs 2>&1 | grep -E "FAIL|checks passed" | sed 's/^/E2E /')
for m in gemma4-e4b qwen3.5-4b; do MODELS=$m "$ROOT/tests/run-mail.sh"; done
echo "FINAL FINISHED $(date +%T)"
