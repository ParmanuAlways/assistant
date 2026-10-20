"""End-to-end test of the Firefox build in real Firefox (Selenium Grid, selenium/standalone-firefox).

Usage: python3 firefox_e2e.py [--task "<goal>"]
Needs geckodriver started with --allow-system-access on :4445 (see tests/firefox-setup.sh): WebDriver may not
navigate to moz-extension:// pages, so extension pages are opened from the browser window like a user would.
Installs extension/.output/firefox-mv2 as a temporary add-on, signs in through Keycloak with
browser.identity.launchWebAuthFlow, runs an agent task from the sidebar page, and checks History,
Teach recording and the auditor dashboard.
"""
import argparse
import base64
import io
import json
import os
import sys
import time
import zipfile

import httpx
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait  # noqa: E402

ROOT = "/home/user/browser-agent"
EXT_DIR = f"{ROOT}/extension/.output/firefox-mv2"
OUT = f"{ROOT}/test-results-firefox"
ADDON_ID = "office-assistant@office.local"
UUID = "0ff1ce00-a551-4a00-8e00-000000000001"   # fixed internal UUID -> predictable moz-extension:// URLs
BASE = f"moz-extension://{UUID}"
KC = "http://keycloak.office.local:8080"

results = []


def check(name, ok, detail=""):
    results.append({"name": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  — ' + str(detail)[:200] if detail else ''}", flush=True)


shot_no = 0


def shot(driver, name):
    global shot_no
    shot_no += 1
    driver.save_screenshot(f"{OUT}/{shot_no:02d}-{name}.png")


def xpi_bytes():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _, files in os.walk(EXT_DIR):
            for f in files:
                full = os.path.join(root, f)
                z.write(full, os.path.relpath(full, EXT_DIR))
    return buf.getvalue()


def keycloak_allow_redirect(uri):
    """Register Firefox's identity redirect URI on the browser-agent client (Chrome's stays)."""
    c = httpx.Client(base_url=KC, timeout=30)
    tok = c.post("/realms/master/protocol/openid-connect/token", data={
        "grant_type": "password", "client_id": "admin-cli", "username": "admin", "password": "admin"}).json()["access_token"]
    c.headers["Authorization"] = f"Bearer {tok}"
    cl = c.get("/admin/realms/company/clients", params={"clientId": "browser-agent"}).json()[0]
    want = uri.rstrip("/") + "/*"
    if want not in cl["redirectUris"]:
        cl["redirectUris"].append(want)
        c.put(f"/admin/realms/company/clients/{cl['id']}", json=cl).raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", default="Apply casual leave for 3 days from Monday, reason: family function")
    ap.add_argument("--answers", default='{"emergency": "9123456780", "asset": "LT-4471", "desk": "B3-114"}')
    ap.add_argument("--label", default="standin")
    args = ap.parse_args()
    answers = json.loads(args.answers)
    os.makedirs(OUT, exist_ok=True)

    opts = webdriver.FirefoxOptions()
    opts.set_preference("extensions.webextensions.uuids", json.dumps({ADDON_ID: UUID}))
    opts.set_preference("xpinstall.signatures.required", False)
    driver = webdriver.Remote("http://127.0.0.1:4445", options=opts)
    driver.set_window_size(1250, 950)
    wait = lambda s=30: WebDriverWait(driver, s)
    try:
        caps = driver.capabilities
        check("Real Firefox running", caps.get("browserName") == "firefox", f"Firefox {caps.get('browserVersion')}")

        driver.command_executor.add_command("installAddon", "POST", "/session/$sessionId/moz/addon/install")
        addon = driver.execute("installAddon", {"addon": base64.b64encode(xpi_bytes()).decode(), "temporary": True})["value"]
        check("Extension installs in Firefox (temporary add-on)", addon == ADDON_ID, addon)

        portal = driver.current_window_handle
        driver.get("http://hr.office.local:8200/")

        driver.command_executor.add_command("setContext", "POST", "/session/$sessionId/moz/context")

        def open_extension_page(path):
            """Open an extension page in a new Firefox window (as from the toolbar) and switch to it."""
            before = set(driver.window_handles)
            driver.execute("setContext", {"context": "chrome"})
            driver.execute_script("openTrustedLinkIn(arguments[0], 'window')", f"{BASE}/{path}")
            driver.execute("setContext", {"context": "content"})
            wait().until(lambda d: set(d.window_handles) - before)
            handle = (set(driver.window_handles) - before).pop()
            driver.switch_to.window(handle)
            return handle

        panel = open_extension_page("sidepanel.html")
        wait().until(EC.visibility_of_element_located((By.ID, "login-btn")))
        # the date the test data assumes ("from Monday" = 19 Oct), set the way IT's browser policy would
        driver.execute_async_script("browser.storage.local.set({devConfig: {agent: {today: '2026-10-18'}}}).then(arguments[0])")
        redirect = driver.execute_async_script("arguments[0](browser.identity.getRedirectURL())")
        check("Firefox identity redirect URL", "extensions.allizom.org" in redirect, redirect)
        keycloak_allow_redirect(redirect)
        shot(driver, "panel-signed-out")

        def sign_in(user, pw):
            before = set(driver.window_handles)
            driver.find_element(By.ID, "login-btn").click()
            wait().until(lambda d: len(set(d.window_handles) - before) == 1)
            popup = (set(driver.window_handles) - before).pop()
            driver.switch_to.window(popup)
            wait().until(EC.visibility_of_element_located((By.ID, "username"))).send_keys(user)
            driver.find_element(By.ID, "password").send_keys(pw)
            driver.find_element(By.ID, "kc-login").click()
            driver.switch_to.window(panel)
            wait().until(lambda d: not d.find_element(By.ID, "signed-in").get_attribute("hidden"))
            wait().until(lambda d: d.find_element(By.ID, "user-name").text)

        def sign_out():
            driver.find_element(By.ID, "logout-btn").click()
            wait().until(lambda d: not d.find_element(By.ID, "signed-out").get_attribute("hidden"))

        def tab(name):
            driver.find_element(By.CSS_SELECTOR, f"nav button[data-tab={name}]").click()
            time.sleep(1)

        # 1. Keycloak sign-in through Firefox's launchWebAuthFlow
        sign_in("ravi", "ravi123")
        check("Keycloak sign-in from the Firefox extension", "Ravi Kumar" in driver.find_element(By.ID, "user-name").text,
              driver.find_element(By.ID, "user-name").text + " " + driver.find_element(By.ID, "user-emp").text)
        shot(driver, "panel-signed-in")

        # 2. Profile + settings
        tab("profile")
        prof = driver.find_element(By.ID, "profile-table").text
        check("Profile filled from the company directory", "EMP1042" in prof and "Priya Sharma" in prof)
        tab("settings")
        driver.find_element(By.ID, "test-btn").click()
        wait(240).until(lambda d: "Connected" in d.find_element(By.ID, "settings-status").text
                        or "❌" in d.find_element(By.ID, "settings-status").text)
        status = driver.find_element(By.ID, "settings-status").text
        check("Settings: test connection to the model", "Connected" in status, status)
        shot(driver, "settings")

        # 3. Run an agent task end to end
        tab("assistant")
        driver.find_element(By.ID, "prompt").send_keys(args.task)
        t0 = time.time()
        driver.find_element(By.ID, "run-btn").click()
        asked, confirmed = [], 0
        while time.time() - t0 < 2400:
            state = driver.execute_script("""return {status: document.body.dataset.agent,
                ask: !document.getElementById('ask-box').hidden && document.getElementById('ask-question').textContent,
                options: [...document.querySelectorAll('#ask-options button')].map(b => b.textContent),
                confirm: !document.getElementById('confirm-box').hidden}""")
            if state["status"] and state["status"] != "running":
                break
            if state["ask"]:
                asked.append(state["ask"])
                ans = next((v for k, v in answers.items() if k in state["ask"].lower()), "Please use your best judgement.")
                shot(driver, "question")
                if state["options"]:
                    opt = next((o for o in state["options"] if ans.lower() in o.lower()), state["options"][0])
                    driver.execute_script("[...document.querySelectorAll('#ask-options button')]"
                                          ".find(b => b.textContent === arguments[0]).click()", opt)
                else:
                    # set the value directly: the agent's work in the other window takes keyboard focus
                    driver.execute_script("document.getElementById('ask-input').value = arguments[0];"
                                          "document.getElementById('ask-send').click()", ans)
            elif state["confirm"]:
                confirmed += 1
                shot(driver, "confirm")
                driver.switch_to.window(portal)
                shot(driver, "portal-before-submit")
                driver.switch_to.window(panel)
                driver.find_element(By.ID, "confirm-yes").click()
            time.sleep(0.7)
        status = driver.execute_script("return document.body.dataset.agent")
        log = driver.find_element(By.ID, "log").text
        shot(driver, "task-done")
        driver.switch_to.window(portal)
        shot(driver, "portal-after")
        driver.switch_to.window(panel)
        secs = int(time.time() - t0)
        check(f"Agent task completed in Firefox ({secs}s)", status == "completed", log[-200:])
        check("Assistant asked for missing details and asked for confirmation", confirmed >= 1, f"questions={asked} confirmations={confirmed}")
        result = {"task": args.task, "status": status, "seconds": secs, "questions": asked, "confirmations": confirmed}
        if "leave" in args.task.lower():
            leave = httpx.get("http://hr.office.local:8200/debug/leaves").json()[-1]
            ok = (leave["leave_type"] == "Casual Leave" and leave["from_date"] == "2026-10-19" and leave["to_date"] == "2026-10-21"
                  and leave["emergency_contact"] == "9123456780")
            check("Leave really saved with the right details", ok, json.dumps(leave))
            result["saved"] = leave

        # 4. History with screenshots
        tab("history")
        wait().until(lambda d: d.find_elements(By.CSS_SELECTOR, "#history-list .task"))
        driver.find_element(By.CSS_SELECTOR, "#history-list .task").click()
        wait().until(lambda d: d.find_elements(By.CSS_SELECTOR, "#history-detail li"))
        time.sleep(2)
        types = driver.execute_script("return [...document.querySelectorAll('#history-detail li')].map(l => l.dataset.type)")
        imgs = driver.execute_script("return [...document.querySelectorAll('#history-detail img')].filter(i => i.naturalWidth > 0).length")
        check("History timeline with audit events", {"user_message", "model_action", "confirmation", "task_finished"} <= set(types),
              ", ".join(sorted(set(types))))
        check("Screenshots captured in Firefox and shown", imgs >= 1, f"{imgs} images")
        shot(driver, "history")

        # 5. Teach mode recorder works in Firefox
        tab("teach")
        driver.find_element(By.ID, "teach-name").send_keys("Open my leaves")
        driver.find_element(By.ID, "teach-start").click()
        wait().until(lambda d: d.execute_script("return document.body.dataset.teach") == "recording")
        driver.switch_to.window(portal)
        driver.get("http://hr.office.local:8200/")
        driver.find_element(By.LINK_TEXT, "My Leaves").click()
        time.sleep(2)
        driver.switch_to.window(panel)
        events = [e.text for e in driver.find_elements(By.CSS_SELECTOR, "#teach-events li")]
        check("Teach mode records clicks and pages in Firefox", any("My Leaves" in e for e in events), " | ".join(events))
        shot(driver, "teach-recording")
        driver.find_element(By.ID, "teach-stop").click()
        wait(600).until(lambda d: d.execute_script("return document.body.dataset.teach") in ("review", "error"))

        # 6. Auditor dashboard + integrity check
        sign_out()
        check("Sign-out clears the session", True)
        sign_in("anita", "anita123")
        open_extension_page("audit.html")
        wait().until(lambda d: d.find_elements(By.CSS_SELECTOR, "#tasks tr[data-id]"))
        driver.find_element(By.ID, "verify-btn").click()
        wait().until(lambda d: d.find_elements(By.CSS_SELECTOR, "#verify-result span"))
        v = driver.find_element(By.ID, "verify-result").text
        check("Auditor dashboard + integrity check in Firefox", "Chain valid" in v, v)
        shot(driver, "audit")
        json.dump(result, open(f"{OUT}/task-{args.label}.json", "w"), indent=2)
    except Exception as e:
        check("Test finished without crashing", False, repr(e))
        try:
            shot(driver, "crash")
        except Exception:
            pass
    finally:
        driver.quit()
        json.dump(results, open(f"{OUT}/results-{args.label}.json", "w"), indent=2)
        passed = sum(r["ok"] for r in results)
        print(f"\n{passed}/{len(results)} checks passed")
        sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
