# Office Assistant: an offline AI browser agent for intranet sites

A Chrome extension (with a Firefox build) that operates intranet websites for the user. Example request: "apply casual leave for 3 days from Monday". The agent reads the page, fills the form from the user's profile, asks for anything missing, gets confirmation before the final submit, and logs every step for auditors. Everything runs inside the office network.

```
extension/      Chrome/Firefox extension (TypeScript + WXT)
  lib/auth.ts       Keycloak sign-in (OIDC code + PKCE) via browser.identity
  lib/page.ts       reads the page (fields, labels, options) and clicks/types/selects
  lib/agent.ts      the agent loop
  entrypoints/sidepanel   Assistant · History · My details · Settings
  entrypoints/audit       auditor dashboard (auditor role only)
backend/        FastAPI: token check, agent loop + prompt, profiles, model settings, audit log
standin-model/  rule-based fake "model" with the OpenAI-compatible API (testing only, NOT AI)
portal/         sample HR Leave Portal used as the test target (signs in through Keycloak)
infra/          Keycloak setup script, extension signing key
tests/e2e.mjs   end-to-end test driving real Chromium
```

## Run the demo

```bash
# hostnames used by the demo
echo "127.0.0.1 keycloak.office.local ai.office.local hr.office.local llm.office.local legacy.office.local" | sudo tee -a /etc/hosts
pip install fastapi uvicorn httpx pyjwt cryptography python-multipart itsdangerous pillow
./start-services.sh                     # Keycloak :8080, model :9100, backend :8000, portal :8200
cd extension && npm install && npm run build   # → .output/chrome-mv3 (load unpacked in chrome://extensions)
cd ../tests && npm install && xvfb-run -a node e2e.mjs
```

Demo users: `ravi / ravi123` (user), `anita / anita123` (auditor), `admin1 / admin123` (admin).

## Moving to your office

1. **Keycloak:** run `infra/setup_keycloak.py` against your server (change `KC`), or create the two clients by hand:
   - `browser-agent`: public client, PKCE S256, redirect URI `https://<extension-id>.chromiumapp.org/*`
   - user-attribute mappers for `emp_id`, `department`, `manager`, `phone`
   - realm roles `user`, `auditor` and `admin`
2. **Real model:** run Ollama or vLLM on a GPU machine. As admin, add it with `POST /api/admin/models` (`is_default: true`), for example `http://gpu1.office.local:11434/v1` with model `gemma3:12b`.
3. **Server addresses:** push `apiUrl`, `keycloakUrl` and `clientId` to every PC through browser policy (see `extension/public/managed-schema.json`). Otherwise the defaults in `lib/config.ts` are used.
4. **Extension ID:** it is fixed by the key in `infra/keys/`. Keep `extension-key.pem` private and use it to sign the `.crx` you force-install with the `ExtensionInstallForcelist` policy.
5. **Database:** swap SQLite for PostgreSQL in production. The SQL is plain, and append-only is enforced with triggers here (use `REVOKE UPDATE, DELETE` in PostgreSQL).
6. **Playbooks:** add one per site with `PUT /api/admin/playbooks/{id}`.

## Real models (offline, CPU)

`models-tools/` downloads GGUF models from Docker Hub's `ai/` namespace (Hugging Face was blocked in the test
environment) and serves them with llama.cpp (from GitHub releases):

```bash
python3 models-tools/pull_docker_model.py ai/gemma4 e4b-q4_K_M gemma4-e4b-q4_k_m.gguf
models-tools/serve.sh gemma4-e4b-q4_k_m.gguf          # OpenAI-compatible API on :9200
DEFAULT_MODEL_URL=http://llm.office.local:9200/v1 DEFAULT_MODEL_NAME=gemma4-e4b ./start-services.sh
```

Any OpenAI-compatible server works (Ollama, vLLM, LM Studio, LocalAI, TGI). The backend detects structured-output
support, system-role support and "thinking" models by itself. Per-model overrides: `json_mode`
(auto|schema|object|none) and `context_tokens` when an admin adds a model (`POST /api/admin/models`).

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
- **Learning from successful runs:** after a verified success the backend stores *how* it was done (buttons and
  field labels, never values) and replays it for similar requests. Admins: `GET/DELETE /api/admin/experiences`.
- **Plan, act, check:** a short plan at the start (when no workflow is known), the effect of each action
  ("now on …", "errors shown: …", "the page did not change") in the history, recovery from wrong element numbers,
  and resuming after the site signs the user out mid-task.
- **Vision fallback:** when stuck (loop, repeated failures) the extension sends a screenshot with numbered boxes;
  models marked `supports_vision` (or `AGENT_VISION=1`) get it and may answer `click_xy` (always confirmed by the user).
- **Health:** the audit dashboard shows success per site and per replayed workflow, and flags workflows that stopped
  matching their site (`GET /api/admin/playbook-health`).

## Regression testing

`python3 tests/unit_backend.py` (fast checks), `tests/run-regression.sh` (unit + end-to-end with the stand-in), or
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
