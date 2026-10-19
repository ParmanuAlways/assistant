#!/usr/bin/env bash
cd /home/user/models
while read repo tag file; do
  [ -f "$file" ] && { echo "have $file"; continue; }
  echo "== $repo:$tag"; python3 pull_docker_model.py "$repo" "$tag" "$file" || echo "FAILED $repo:$tag"
done <<'LIST'
ai/gemma3 1b-q4_K_M gemma3-1b-q4_k_m.gguf
ai/qwen3.5 2b-q4_K_M qwen3.5-2b-q4_k_m.gguf
ai/gemma4 e2b-q4_K_M gemma4-e2b-q4_k_m.gguf
ai/llama3.2 3B-Q4_K_M llama3.2-3b-q4_k_m.gguf
ai/qwen3.5 4b-q4_K_M qwen3.5-4b-q4_k_m.gguf
ai/gemma4 e4b-q4_K_M gemma4-e4b-q4_k_m.gguf
ai/qwen3.5 9b-q4_K_M qwen3.5-9b-q4_k_m.gguf
LIST
echo ALL_DONE
