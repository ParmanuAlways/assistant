#!/usr/bin/env bash
# Regression suite: backend unit checks, end-to-end test (stand-in model), then optional model runs compared
# with a reference run. Usage: run-regression.sh [model] [reference-label-prefix]
#   tests/run-regression.sh                       # unit + e2e only (fast, no AI model)
#   tests/run-regression.sh gemma4-e4b final      # also intranet + legacy with the model, compared to "final-*" runs
ROOT=/home/user/browser-agent
fail=0
python3 "$ROOT/tests/unit_backend.py" | tail -1 || fail=1
"$ROOT/reset-data.sh"; pkill -x llama-server
AGENT_TODAY=2026-10-18 "$ROOT/start-services.sh" >/dev/null
(cd "$ROOT/tests" && xvfb-run -a node e2e.mjs 2>&1 | grep -E "FAIL|checks passed" | sed 's/^/E2E /') | tee /tmp/e2e.out
grep -q "FAIL" /tmp/e2e.out && fail=1
if [ -n "$1" ]; then
  m="$1"; ref="$2"; stamp=$(date +%m%d-%H%M)
  "$ROOT/reset-data.sh"
  /home/user/models/serve.sh "/home/user/models/${m}-q4_k_m.gguf" || exit 1
  AGENT_TODAY=2026-10-18 AGENT_CALENDAR=1 AGENT_SCHEMA=1 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME="$m" \
    "$ROOT/start-services.sh" >/dev/null
  (cd "$ROOT/tests" && TASKSET=intranet xvfb-run -a node eval.mjs "regress-intranet-$stamp")
  "$ROOT/tests/run-legacy.sh" "regress-legacy-$stamp" "$m"
  if [ -n "$ref" ]; then
    python3 "$ROOT/tests/regress.py" "$ROOT/eval-results/$ref-intranet" "$ROOT/eval-results/regress-intranet-$stamp" || fail=1
    python3 "$ROOT/tests/regress.py" "$ROOT/eval-results/$ref-legacy" "$ROOT/eval-results/regress-legacy-$stamp" || fail=1
  fi
fi
echo "REGRESSION $([ $fail = 0 ] && echo PASSED || echo FAILED)"
exit $fail
