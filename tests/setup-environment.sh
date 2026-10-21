#!/usr/bin/env bash
# Everything the demo and the tests need that is not in the repository, on a fresh Linux machine (Ubuntu, root).
# Safe to run again: each step is skipped when its result is already there.
#   tests/setup-environment.sh            # demo sites, Keycloak, webmail, test tools (no AI model)
#   MODELS=1 tests/setup-environment.sh   # also llama.cpp and the Gemma 4 E4B model (~6 GB) for the real-model runs
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== system packages (Java for Keycloak, PHP for the webmail, X tools for screenshots)"
command -v java >/dev/null && command -v php >/dev/null && command -v xvfb-run >/dev/null && command -v import >/dev/null || {
  apt-get update -q
  apt-get install -y -q openjdk-21-jre-headless php-cli php-sqlite3 php-mbstring php-xml php-intl xvfb imagemagick \
    sqlite3 zstd unzip libreoffice-writer-nogui docker.io || true
}

echo "== Python packages (demo office sites, test helpers)"
pip install -q fastapi uvicorn httpx python-multipart itsdangerous jinja2 reportlab pypdf pillow selenium

echo "== Node packages (extension, browser tests)"
(cd extension && npm install --no-audit --no-fund >/dev/null)
(cd tests && npm install --no-audit --no-fund >/dev/null)

echo "== Keycloak 26.0.7 (sign-in for the demo)"
[ -d infra/keycloak-26.0.7 ] || {
  curl -sSL -o /tmp/kc.zip https://github.com/keycloak/keycloak/releases/download/26.0.7/keycloak-26.0.7.zip
  unzip -q /tmp/kc.zip -d infra/ && rm -f /tmp/kc.zip
}

echo "== Roundcube 1.6.9 (the webmail test site) on SQLite"
[ -d mail/roundcubemail-1.6.9 ] || {
  curl -sSL -o /tmp/rc.tgz https://github.com/roundcube/roundcubemail/releases/download/1.6.9/roundcubemail-1.6.9-complete.tar.gz
  tar -xzf /tmp/rc.tgz -C mail/ && rm -f /tmp/rc.tgz
}
cp mail/roundcube-config.inc.php mail/roundcubemail-1.6.9/config/config.inc.php
[ -f mail/roundcube.db ] || (cd mail/roundcubemail-1.6.9 && php bin/initdb.sh --dir="$PWD/SQL")
chmod 666 mail/roundcube.db 2>/dev/null || true

echo "== Docker images (mail server, Firefox for the Firefox test)"
docker info >/dev/null 2>&1 || { (nohup dockerd > /tmp/dockerd.log 2>&1 &); for i in $(seq 60); do docker info >/dev/null 2>&1 && break; sleep 2; done; }
docker image inspect greenmail/standalone:2.1.2 >/dev/null 2>&1 || docker pull -q greenmail/standalone:2.1.2
docker image inspect selenium/standalone-firefox:latest >/dev/null 2>&1 || docker pull -q selenium/standalone-firefox:latest

echo "== Chromium for the browser tests (Playwright)"
[ -x /opt/pw-browsers/chromium-1194/chrome-linux/chrome ] || (cd tests && npx playwright install chromium)

if [ "${MODELS:-0}" = 1 ]; then
  echo "== llama.cpp b11721 (CPU) and Gemma 4 E4B (+ image projector for the vision test)"
  mkdir -p /home/user/models/llama.cpp
  [ -x /home/user/models/llama.cpp/llama-b11721/llama-server ] || {
    # (the archive unpacks to llama-b11721/)
    curl -sSL -o /tmp/llama.tgz https://github.com/ggml-org/llama.cpp/releases/download/b11721/llama-b11721-bin-ubuntu-x64.tar.gz
    tar -xzf /tmp/llama.tgz -C /home/user/models/llama.cpp && rm -f /tmp/llama.tgz
  }
  cp models-tools/serve.sh models-tools/pull_docker_model.py /home/user/models/
  # Hugging Face was blocked here, so models come from Docker Hub's ai/ namespace
  [ -f /home/user/models/gemma4-e4b-q4_k_m.gguf ] || (cd /home/user/models && python3 pull_docker_model.py ai/gemma4 e4b-q4_K_M gemma4-e4b-q4_k_m.gguf)
  [ -f /home/user/models/gemma4-e4b-mmproj.gguf ] || (cd /home/user/models && python3 pull_docker_model.py ai/gemma4 e4b-q4_K_M gemma4-e4b-mmproj.gguf --smallest)
fi

echo "== build the extension"
(cd extension && npm run build >/dev/null && npm run build:firefox >/dev/null)
echo "Done. Next: tests/start-test-stack.sh, then tests/run-fast-suite.sh"
