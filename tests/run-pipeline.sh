#!/usr/bin/env bash
# Waits for the mail evaluation, rebuilds the extension, then runs the teach and model-agnostic experiments.
ROOT=/home/user/browser-agent
while pgrep -f run-mail.sh >/dev/null; do sleep 30; done
(cd "$ROOT/extension" && npm run build >/dev/null 2>&1) && echo "extension rebuilt $(date +%T)"
"$ROOT/tests/run-teach.sh"
"$ROOT/tests/run-agnostic.sh"
echo "PIPELINE FINISHED $(date +%T)"
