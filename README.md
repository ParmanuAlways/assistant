# Office Assistant: an offline AI browser agent for intranet sites

A Chrome extension (with a Firefox build) that operates intranet websites for the user. Example request: "apply casual leave for 3 days from Monday". The agent reads the page, fills the form from the user's profile, asks for anything missing, gets confirmation before the final submit, and logs every step for auditors. Everything runs inside the office network.

**No server of its own.** The assistant is only the extension: the user's profile, history, audit log, saved apps,
communications index and letters are kept in the browser (IndexedDB) on the user's PC, and all the logic (the
assistant's step-by-step loop, reading letters, drafting replies, search) runs in the extension. The one thing it
reaches over the network is the **AI model**, through an OpenAI-compatible API (llama.cpp, Ollama, vLLM...).
Sign-in is the office's Keycloak; admin rules (allowed sites, models, playbooks) come from browser policy.

```
extension/      Chrome/Firefox extension (TypeScript + WXT)
  lib/auth.ts       Keycloak sign-in (OIDC code + PKCE) via browser.identity
  lib/page.ts       reads the page (fields, labels, options) and clicks/types/selects
  lib/agent.ts      the agent loop (runs the steps on the page)
  lib/local/        everything a server used to do, in the browser:
    store.ts          storage (IndexedDB)          audit.ts     hash-chained audit log
    model.ts          calls the model (OpenAI API)  agent.ts     prompts, checks before submit
    routes/tasks.ts   the step-by-step decisions    skills.ts    workflows learned/taught
    comms.ts          communications search         letters/     reading letters, drafting replies
  lib/config.ts     settings and admin rules (browser policy: public/managed-schema.json)
  entrypoints/sidepanel   Assistant · Comms · Letters · History · My details · Teach · Settings
  entrypoints/audit       auditor dashboard (auditor role only)
standin-model/  rule-based fake "model" with the OpenAI-compatible API (testing only, NOT AI)
portal/         demo office sites (HR, intranet apps, Legacy ERP, e-Office with 100 dummy letters)
infra/          Keycloak setup script, extension signing key
tests/          browser tests (e2e.mjs, letters-shots.mjs, comms-shots.mjs, eval.mjs...) and tests/local/ unit tests
```

## Run the demo

```bash
# hostnames used by the demo
echo "127.0.0.1 keycloak.office.local hr.office.local llm.office.local intranet.office.local legacy.office.local eoffice.office.local" | sudo tee -a /etc/hosts
pip install fastapi uvicorn python-multipart itsdangerous reportlab   # only for the demo office sites
./start-services.sh                     # Keycloak :8080, model :9100, demo sites :8200-8600
cd extension && npm install && npm run build   # → .output/chrome-mv3 (load unpacked in chrome://extensions)
for t in ../tests/local/*.test.ts; do ../tests/local/run.sh $t; done   # unit tests (Node)
cd ../tests && npm install && xvfb-run -a node e2e.mjs
# everything: ./start-test-stack.sh (demo sites + mail), ./run-fast-suite.sh (all browser tests, no model),
# ./run-nobackend-model.sh (the real-model tasks; needs a model in /home/user/models)
```

Demo users: `ravi / ravi123` (user), `anita / anita123` (auditor), `admin1 / admin123` (admin).

## Moving to your office

1. **Keycloak:** run `infra/setup_keycloak.py` against your server (change `KC`), or create the two clients by hand:
   - `browser-agent`: public client, PKCE S256, redirect URI `https://<extension-id>.chromiumapp.org/*`
   - user-attribute mappers for `emp_id`, `department`, `manager`, `phone`
   - realm roles `user`, `auditor` and `admin`
2. **Model:** run llama.cpp, Ollama or vLLM on a machine in the office (a GPU helps). List it in the `models`
   browser policy, for example `{"id": 1, "name": "Gemma 3 12B", "url": "http://gpu1.office.local:11434/v1",
   "model": "gemma3:12b", "default": true}`. It is the only thing the assistant calls over the network.
3. **Browser policy** (see `extension/public/managed-schema.json`): `keycloakUrl`, `clientId`, `models`,
   `allowedSites`, `maxSteps`, `allowCustomEndpoints`/`allowedModelHosts`, `playbooks`, `commsSources`,
   `letterSources`, `directoryUrl`. Users cannot change these. Otherwise the defaults in `lib/config.ts` are used.
4. **Extension ID:** it is fixed by the key in `infra/keys/`. Keep `extension-key.pem` private and use it to sign the `.crx` you force-install with the `ExtensionInstallForcelist` policy.
5. **Model API keys:** usually none (an office model server on the intranet). A key IT sets is part of the `models`
   policy. A key a user types in for their own server (only if `allowCustomEndpoints`) is kept for good, encrypted
   with a key the browser holds and will not hand out (`lib/local/secret.ts`): a copy of the profile on another PC
   shows only ciphertext.
6. **Data and audit:** each user's data stays in their browser profile on their PC (nothing central to run or
   back up). The audit log is hash-chained, so any edit or deletion is detected by *Verify*; auditors see the log
   of the browser they open the dashboard in, and *Export audit log* saves it (JSON) for collecting centrally.
7. **Playbooks:** put one per site in the `playbooks` policy. A playbook someone teaches is used in their own
   browser; to share it, an admin copies it into the policy.

## Real models (offline, CPU)

`models-tools/` downloads GGUF models from Docker Hub's `ai/` namespace (Hugging Face was blocked in the test
environment) and serves them with llama.cpp (from GitHub releases):

```bash
python3 models-tools/pull_docker_model.py ai/gemma4 e4b-q4_K_M gemma4-e4b-q4_k_m.gguf
models-tools/serve.sh gemma4-e4b-q4_k_m.gguf          # OpenAI-compatible API on :9200
# then list it in the models policy (tests: DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME=gemma4-e4b node eval.mjs)
```

Any OpenAI-compatible server works (Ollama, vLLM, LM Studio, LocalAI, TGI). The assistant detects structured-output
support, system-role support and "thinking" models by itself. Per-model overrides in the `models` policy: `json_mode`
(auto|schema|object|none) and `context_tokens`.

## Teach mode

Side panel → **Teach**: name the workflow, *Start recording*, do the task once, *Stop*. The model drafts a
playbook (request-specific values become placeholders). **Review it**: the model tends to copy the
demonstrated values. Then save. Playbooks from non-admins wait for an admin's approval. Only the playbooks
relevant to a request are given to the model in full.

## The side panel

A chat-style assistant ([screenshots](screenshots/ui), [communications](screenshots/comms)):

- **Home screen** (first thing after sign-in): *Your apps*, the sites the user registered (one click opens them as
  usual, no AI involved; "Use this page" saves the open page), *You often*, their most frequent requests from history
  (one tap to reuse), and *Recent* tasks. The assistant also knows the user's saved apps.
- **Conversation**: the request, a live "working" card (each step with an icon, the model's reasoning in grey),
  questions with answer chips, a **"Ready to submit?"** card that shows where every value came from (colour-coded:
  from your request / profile / you told me / ⚠ my guess), and the result with reference numbers.
- **On the page**: while the assistant works, the page glows softly and a pill says what it is doing.
- **Comms**: the user's communications (letters, notes, circulars, e-mails) from office apps, sorted into **Sent** /
  **Received** and topic folders (Leave & HR, IT, Purchase & Finance, Travel, Meetings, Projects, Admin,
  Circulars), with search in plain words: "letters I sent to Priya about leave last month" becomes
  *sent · to: Priya · "leave" · Sep 2026*. Matches are highlighted and one click opens the item in the office app.
  Typing "find the circular about the holiday list" in the chat answers from the same index. Items are read from
  the office app **as the user** (their own session, read-only) and indexed per user (SQLite full-text search);
  the apps to read are set in `commsSources` (browser policy, see `public/managed-schema.json`). The demo app's
  Communication module (`portal/legacy.py`) shows the problem: one long list per box, searchable only by exact
  reference number.

## Letters from e-Office: filed per sender, replies drafted

e-Office shows only a receipt number, the sender and a cut-off subject; the letter itself is a PDF the user downloads.
The **Letters** tab ([screenshots](screenshots/letters)) takes it from there:

- **Filing.** When the user clicks *Download* in e-Office, the letter is read (as the user, with their own session)
  and saved straight into its sender's folder, under a name that says what it is:
  `Downloads/eOffice/Ministry of Finance - Department of Expenditure/2026-10-12 - OM - <subject> - <file no>.pdf`
  (Chrome). Letters downloaded earlier, or in Firefox: **File my downloads** moves them into the same folders.
  **Choose folder…** keeps a copy of everything in any folder the user picks (e.g. a shared drive), **Tidy a folder…**
  sorts a folder of loose PDFs into sender folders, and **Register (CSV)** is the inward register (received,
  file no., from, what it asks, reply due, status).
- **What it asks.** Each letter is read for its format (Letter, OM, D.O., Circular, Office Order, Notice, Reminder),
  file number, date, sender, signatory, subject, the sentence that says what is wanted, and the **reply-by date**
  ("by 30.10.2026", "within 15 days", "within a fortnight", RTI's 30 days). It is sorted into one of 16 kinds:
  request for information, comments on a draft, meeting, nomination, ATR, Parliament Question, RTI, audit para,
  grievance, reminder, vigilance clearance, NOC for deputation, budget, invitation, sanction or circular (for
  information). The list is grouped by sender, letters still to answer first, overdue ones in red.
- **Reply.** Open a letter and pick how to answer; the options depend on what it asks, the usual one first, and include
  saying no diplomatically (e.g. a meeting: *Confirm attendance · Depute another officer · Regret - can't attend ·
  Request another date*; an NOC: *Grant · Decline diplomatically · Ask for details*). Add names or figures if needed
  and **Generate**: the reply is drafted in service format (an OM is answered with an OM, a D.O. with a D.O.,
  otherwise a letter, citing their number and date, addressed to the post) and saved as a Word file next to the
  letter. *Polish the wording with the AI model* is optional. **Draft all** drafts the usual reply for every letter
  not yet answered and files the ones that need none (circulars, sanctions).
- Reading and drafting are rules and templates (instant, offline, predictable); the reply wording and our office's
  letterhead are in `extension/lib/local/letters/` (`OPTIONS`, `OUR_OFFICE`, `draftReply`) so they can be replaced with the
  office's own format. Which sites count as e-Office is set in `letterSources` (browser policy).
- Demo: a dummy e-Office (`portal/eoffice.py`, user `ravi` / `ravi123`) with **100 dummy letters in service format**
  (`portal/govletters.py`, every page marked DUMMY; all 100 also in [samples/dummy-letters](samples/dummy-letters) with
  an index, and example replies in [samples/reply-drafts](samples/reply-drafts)). Test: `tests/letters-shots.mjs`.

## Hard web apps (frames, pop-ups, dialogs, Shadow DOM)

The page reader (`extension/lib/page.ts`) reads **every frame** (framesets, iframes) and **open Shadow DOM**, shows
**which table row** a button is in, lists links hidden in **hover menus**, and finds home-made clickable things
(calendar days, suggestion lists, `onclick` cells). Native **`alert()`/`confirm()`** pop-ups are answered by a hook in
the page (only while a task runs): alerts become messages the model sees, and `confirm()` says OK only for an action
the user approved in the side panel (otherwise the user is asked first, with the site's own question). **Pop-up
windows** (lookups) are followed and the assistant returns when they close. Besides click/type/select the model can use
`pick_date` (drives calendar widgets), `autocomplete` (types and picks the suggestion), `fill_form` (many fields in
one step), `upload` (the user picks the file in the side panel; the assistant never reads files by itself) and
`hover`.

Before every final submit the confirmation shows **where each value came from** (your request, your profile, your
answer, already on the page, or ⚠ chosen by the assistant) and a **pre-submit check** compares the form with the
request (dates, amounts, IDs, the table row). Mismatches go back to the model once, then to the user.

Test site: `portal/legacy.py` ("Legacy ERP", `legacy.office.local:8500`), tasks `TASKSET=legacy` in `tests/eval.mjs`.

## Learning and replay

- **Taught workflows are replayed:** a playbook saved from Teach mode keeps the recording. Steps that are the same
  every time (menus, "Travel Request", "Submit") run directly without the model; value steps go to the model with
  the workflow as a hint. A step that is no longer on the page hands control back to the model.
- **Learning from successful runs:** after a verified success the assistant stores *how* it was done (buttons and
  field labels, never values) and replays it for similar requests. They are kept in the browser.
- **Plan, act, check:** a short plan at the start (when no workflow is known), the effect of each action
  ("now on …", "errors shown: …", "the page did not change") in the history, recovery from wrong element numbers,
  and resuming after the site signs the user out mid-task.
- **Vision fallback:** when stuck (loop, repeated failures) the extension sends a screenshot with numbered boxes;
  models marked `supports_vision` (or `AGENT_VISION=1`) get it and may answer `click_xy` (always confirmed by the user).
- **Health:** the audit dashboard shows success per site and per replayed workflow, and flags workflows that stopped
  matching their site (on the audit dashboard).

## Regression testing

`tests/local/run.sh tests/local/<name>.test.ts` (fast checks, Node), `tests/run-regression.sh` (unit + end-to-end with the stand-in), or
`tests/run-regression.sh gemma4-e4b <reference>` to also run the intranet and Legacy ERP sets with a model and compare
them task by task with a reference run (`tests/regress.py`).

## Webmail test site

`mail/` holds the Roundcube configuration (`roundcube-config.inc.php`) used to test email tasks against a real
IMAP/SMTP server (GreenMail in Docker). `tests/mailbox.py reset` seeds the mailboxes, including an email with a
prompt-injection attack. See EVALUATION.md, Part 2.

## Evaluation harness

`tests/eval.mjs` runs tasks through the real extension in Chromium and grades what the sites actually saved
(`TASKSET=mail` for webmail, `REPEAT=n` for repeats). Scripts: `tests/run-eval.sh`, `run-improved.sh`,
`run-mail.sh`, `run-teach.sh`, `run-agnostic.sh`; summary with `tests/summarize.py`. Results:
[EVALUATION.md](EVALUATION.md).

## Firefox

`npm run build:firefox` builds the Firefox add-on (`extension/.output/firefox-mv2`, opens as a sidebar).
`tests/firefox-setup.sh` starts real Firefox (Docker image), and `python3 tests/firefox_e2e.py` runs the
end-to-end test (14 checks; add `--label`/`--task` to try other tasks). Results are in EVALUATION.md, Part 3.
