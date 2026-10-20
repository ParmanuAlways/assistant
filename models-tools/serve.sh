#!/usr/bin/env bash
# Serve one GGUF model (MMPROJ=<projector.gguf> adds image input) with llama.cpp's OpenAI-compatible server on :9200 (CPU only).
M="$1"
pkill -x llama-server 2>/dev/null; sleep 2
cd /home/user/models
nohup llama.cpp/llama-b11721/llama-server -m "$M" ${MMPROJ:+--mmproj "$MMPROJ"} --host 0.0.0.0 --port 9200 -c 16384 -np 1 -t 4 \
  --jinja --reasoning-budget 0 > "llama-server-$(basename "$M" .gguf).log" 2>&1 &
for i in $(seq 600); do curl -sf http://127.0.0.1:9200/health >/dev/null && { echo "serving $M"; exit 0; }; sleep 1; done
echo "llama-server failed to start"; tail -20 "llama-server-$(basename "$M" .gguf).log"; exit 1
