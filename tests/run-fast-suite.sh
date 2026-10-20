#!/usr/bin/env bash
# Fast suite: every browser test that needs no real AI model (the stand-in model answers). Needs ./start-test-stack.sh.
cd /home/user/browser-agent/tests
echo '{"AGENT_TODAY":"2026-10-18"}' > ../infra/logs/run-env.json
echo "== unit"; for t in local/*.test.ts; do echo "$t: $(local/run.sh $t 2>/dev/null | tail -1)"; done
X='xvfb-run -a -s "-screen 0 1440x900x24"'
echo "== e2e"; timeout 1200 xvfb-run -a node e2e.mjs 2>&1 | grep -E "FAIL|checks passed"
echo "== probe"; QUIET=1 timeout 600 xvfb-run -a node probe.mjs 2>&1 | grep -E "PASS|FAIL|checks passed|Error"
echo "== letters"; timeout 900 xvfb-run -a -s "-screen 0 1440x900x24" node letters-shots.mjs 2>&1 | grep -E "FAIL|checks passed|Error"
echo "== comms"; rm -rf /tmp/claude-0/comms-shots-profile; timeout 600 xvfb-run -a -s "-screen 0 1440x900x24" node comms-shots.mjs 2>&1 | grep -E "FAIL|checks passed|Error"
echo "== ui (two tasks: home screen learns what you do)"; rm -rf /tmp/claude-0/ui-shots-profile
timeout 1800 xvfb-run -a -s "-screen 0 1440x900x24" node ui-shots.mjs ../screenshots/ui "Apply casual leave for 3 days from Monday, reason: family function || Apply casual leave on 2 Nov 2026 for 1 day, reason: personal work" 2>&1 | grep -E "PASS|FAIL|checks passed|Error"
echo "== teach (stand-in model)"; timeout 900 xvfb-run -a node teach.mjs fast-standin helpdesk 2>&1 | grep -E "SAVED|CRASH"
echo "== firefox"; (bash firefox-setup.sh >/dev/null 2>&1 </dev/null) ; timeout 1200 python3 firefox_e2e.py 2>&1 | grep -E "FAIL|checks passed|Traceback"
docker rm -f ffgrid >/dev/null 2>&1   # its virtual screen keeps using CPU
echo "== FAST DONE"
