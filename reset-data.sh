#!/usr/bin/env bash
# Stops the demo sites and wipes their data. Keycloak keeps running. (The assistant keeps its data in each browser profile.)
ROOT="$(cd "$(dirname "$0")" && pwd)"
pkill -f "uvicorn (server|app|intranet|legacy|eoffice):app" || true
sleep 3
pkill -9 -f "uvicorn (server|main|app|intranet|legacy|eoffice):app" || true   # a server stuck finishing a request
sleep 1
rm -f "$ROOT/portal/portal.db" "$ROOT/portal/intranet.db"
