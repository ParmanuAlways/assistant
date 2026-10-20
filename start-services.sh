#!/usr/bin/env bash
# Starts the demo stack: Keycloak :8080, stand-in model :9100, backend :8000, HR portal :8200.
# Hostnames *.office.local must resolve to this machine (see /etc/hosts).
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGS="$ROOT/infra/logs"; mkdir -p "$LOGS"

# Demo hostnames (the sandbox can reset /etc/hosts, so re-add them every start)
HOSTS="keycloak ai hr llm intranet helpdesk expenses rooms visitors canteen mail legacy eoffice"
for h in $HOSTS; do
  grep -qE "[[:space:]]$h\.office\.local([[:space:]]|$)" /etc/hosts || echo "127.0.0.1 $h.office.local" >> /etc/hosts
done

if ! curl -sf http://keycloak.office.local:8080/realms/master >/dev/null; then
  (cd "$ROOT/infra/keycloak-26.0.7" && KC_BOOTSTRAP_ADMIN_USERNAME=admin KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
    nohup bin/kc.sh start-dev --http-port 8080 > "$LOGS/keycloak.log" 2>&1 &)
  until curl -sf http://keycloak.office.local:8080/realms/master >/dev/null; do sleep 2; done
fi
python3 "$ROOT/infra/setup_keycloak.py"

(cd "$ROOT/standin-model" && nohup python3 -m uvicorn server:app --host 0.0.0.0 --port 9100 > "$LOGS/model.log" 2>&1 &)
(cd "$ROOT/backend" && DEFAULT_MODEL_URL="${DEFAULT_MODEL_URL:-http://llm.office.local:9100/v1}" DEFAULT_MODEL_NAME="$DEFAULT_MODEL_NAME" AGENT_CALENDAR="${AGENT_CALENDAR:-1}" AGENT_SCHEMA="${AGENT_SCHEMA:-}" AGENT_JSON_MODE="${AGENT_JSON_MODE:-}" AGENT_TODAY="${AGENT_TODAY:-}" nohup python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 > "$LOGS/backend.log" 2>&1 &)
(cd "$ROOT/portal" && nohup python3 -m uvicorn app:app --host 0.0.0.0 --port 8200 > "$LOGS/portal.log" 2>&1 &)
(cd "$ROOT/portal" && nohup python3 -m uvicorn intranet:app --host 0.0.0.0 --port 8300 > "$LOGS/intranet.log" 2>&1 &)
(cd "$ROOT/portal" && nohup python3 -m uvicorn legacy:app --host 0.0.0.0 --port 8500 > "$LOGS/legacy.log" 2>&1 &)
(cd "$ROOT/portal" && nohup python3 -m uvicorn eoffice:app --host 0.0.0.0 --port 8600 > "$LOGS/eoffice.log" 2>&1 &)
for u in http://llm.office.local:9100/v1/models http://ai.office.local:8000/api/health http://hr.office.local:8200/ http://intranet.office.local:8300/ http://legacy.office.local:8500/debug/state http://eoffice.office.local:8600/login; do
  until curl -sf "$u" >/dev/null; do sleep 1; done
done
echo "All services up."
