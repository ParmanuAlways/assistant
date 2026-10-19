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
echo "127.0.0.1 keycloak.office.local ai.office.local hr.office.local llm.office.local" | sudo tee -a /etc/hosts
pip install fastapi uvicorn httpx pyjwt cryptography python-multipart itsdangerous
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
