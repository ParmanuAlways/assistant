#!/usr/bin/env bash
# Stops the Python services and wipes demo data (agent DB, portal DB, screenshots). Keycloak keeps running.
ROOT="$(cd "$(dirname "$0")" && pwd)"
pkill -f "uvicorn (server|main|app|intranet|legacy):app" || true
sleep 3
pkill -9 -f "uvicorn (server|main|app|intranet|legacy):app" || true   # a server stuck finishing a request
sleep 1
rm -f "$ROOT/backend"/agent.db* "$ROOT/portal/portal.db" "$ROOT/portal/intranet.db"
rm -rf "$ROOT/backend/screenshots"
