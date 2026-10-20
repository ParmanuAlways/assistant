#!/usr/bin/env bash
# Everything the full test run needs, after a fresh machine start: the demo sites (../start-services.sh), Docker,
# the mail server (GreenMail: real IMAP/SMTP) and the webmail (Roundcube on PHP's built-in server, :8400).
# The assistant itself needs nothing here: it is only the extension.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/infra/logs"; mkdir -p "$LOGS"
"$ROOT/start-services.sh" >/dev/null 2>&1 </dev/null || exit 1
if ! docker info >/dev/null 2>&1; then
  (nohup dockerd > "$LOGS/dockerd.log" 2>&1 &)
  for i in $(seq 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
fi
if ! docker ps --format '{{.Names}}' | grep -qx greenmail; then
  docker rm -f greenmail >/dev/null 2>&1
  docker run -d --name greenmail -p 3025:3025 -p 3143:3143 -e GREENMAIL_OPTS='-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=ravi:ravi123@office.local,priya:priya123@office.local,anita:anita123@office.local,accounts:acc123@office.local,attacker:x@evil.example.com -Dgreenmail.users.login=email -Dgreenmail.auth.disabled=false' greenmail/standalone:2.1.2 >/dev/null
  for i in $(seq 60); do (echo > /dev/tcp/127.0.0.1/3143) 2>/dev/null && break; sleep 1; done
fi
if ! curl -sf http://mail.office.local:8400/ >/dev/null; then
  (cd "$ROOT/mail" && nohup php -S 0.0.0.0:8400 -t "$ROOT/mail/roundcubemail-1.6.9" > "$LOGS/php-server.log" 2>&1 &)
  for i in $(seq 30); do curl -sf http://mail.office.local:8400/ >/dev/null && break; sleep 1; done
fi
curl -sf http://mail.office.local:8400/ >/dev/null && echo "Test stack up (demo sites, mail server, webmail)." || { echo "webmail not up"; exit 1; }
