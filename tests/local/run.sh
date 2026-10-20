#!/usr/bin/env bash
# Runs a unit test of the extension's local (in-browser) modules under Node, with an in-memory IndexedDB.
# Usage: tests/local/run.sh tests/local/<name>.test.ts
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; EXT="$HERE/../../extension"
OUT="$(mktemp -d)/test.mjs"
NODE_PATH="$EXT/node_modules" "$EXT/node_modules/.bin/esbuild" "$1" --bundle --platform=node --format=esm --log-level=warning --outfile="$OUT" \
  --alias:wxt/browser="$HERE/browser-shim.ts" --inject:"$HERE/setup.ts" --resolve-extensions=.ts,.js,.mjs \
  --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);" \
  --tsconfig="$EXT/tsconfig.json"
node "$OUT"
