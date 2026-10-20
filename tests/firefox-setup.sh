#!/usr/bin/env bash
# Real Firefox for the tests: the Selenium Firefox image from Docker Hub (Mozilla's own download sites were
# blocked here), on the host network, with geckodriver allowed to open extension pages (port 4445).
docker rm -f ffgrid >/dev/null 2>&1
HOSTS=""; for h in keycloak ai hr llm intranet helpdesk expenses rooms visitors canteen mail legacy; do HOSTS="$HOSTS --add-host $h.office.local:127.0.0.1"; done
docker run -d --name ffgrid --network host --shm-size 2g $HOSTS -e SE_SCREEN_WIDTH=1300 -e SE_SCREEN_HEIGHT=1000 \
  selenium/standalone-firefox:latest >/dev/null
until curl -sf http://127.0.0.1:4444/status >/dev/null; do sleep 2; done
docker exec -d -e DISPLAY=:99.0 ffgrid sh -c 'geckodriver --host 127.0.0.1 --port 4445 --allow-system-access > /tmp/gecko.log 2>&1'
until curl -sf http://127.0.0.1:4445/status >/dev/null; do sleep 1; done
echo "Firefox ready (geckodriver on :4445)"
