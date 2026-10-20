#!/usr/bin/env bash
# Model-agnostic checks: same agent, different model servers, nothing configured per server.
ROOT=/home/user/browser-agent
M=/home/user/models
# A) Gemma 4 E4B served by Ollama (instead of llama.cpp); structured-output support is auto-detected
"$ROOT/reset-data.sh"; pkill -x llama-server; pkill -x ollama; sleep 2
mkdir -p "$M/ollama/store"
(OLLAMA_MODELS="$M/ollama/store" OLLAMA_HOST=0.0.0.0:11434 OLLAMA_CONTEXT_LENGTH=16384 OLLAMA_NUM_PARALLEL=1 \
  nohup "$M/ollama/bin/ollama" serve > "$M/ollama/serve.log" 2>&1 &)
until curl -sf http://127.0.0.1:11434/api/version >/dev/null; do sleep 1; done
if ! OLLAMA_HOST=127.0.0.1:11434 "$M/ollama/bin/ollama" list | grep -q gemma4-e4b; then
  printf 'FROM %s\n' "$M/gemma4-e4b-q4_k_m.gguf" > "$M/ollama/Modelfile"
  OLLAMA_HOST=127.0.0.1:11434 "$M/ollama/bin/ollama" create gemma4-e4b -f "$M/ollama/Modelfile"
fi
AGENT_TODAY=2026-10-18 DEFAULT_MODEL_URL=http://llm.office.local:11434/v1 DEFAULT_MODEL_NAME=gemma4-e4b \
  "$ROOT/start-services.sh" >/dev/null
echo "=================== agnostic: gemma4-e4b on OLLAMA  $(date +%T)"
(cd "$ROOT/tests" && xvfb-run -a node eval.mjs "agnostic-ollama-gemma4-e4b")
pkill -x ollama
# B) a minimal server with no JSON mode and no system role (rule-based stand-in in strict mode), HR tasks
"$ROOT/reset-data.sh"
(cd "$ROOT/standin-model" && STANDIN_STRICT=1 nohup python3 -m uvicorn server:app --port 9101 > "$ROOT/infra/logs/strict.log" 2>&1 &)
sleep 3
export AGENT_TODAY=2026-10-18 DEFAULT_MODEL_URL=http://llm.office.local:9101/v1; "$ROOT/start-services.sh" >/dev/null
echo "=================== agnostic: STRICT minimal server  $(date +%T)"
(cd "$ROOT/tests" && xvfb-run -a node eval.mjs "agnostic-strict-server" hr-casual,hr-sick)
echo "AGNOSTIC FINISHED $(date +%T)"
