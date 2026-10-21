# CLAUDE.md: start here

Office Assistant is an AI assistant for intranet websites (Indian government offices: e-Office, service-format
letters) that runs **as a browser extension only**. This file is the hand-over for a new session: what was decided, how
the code is laid out, how to run and test it, the traps in this environment, and what is still open.
Longer reading: `README.md` (features, how to deploy), `EVALUATION.md` (every test and measurement, Parts 1-7),
`release/INSTALL.md` (installing the packages).

## The user's decisions (keep to these)

- **No backend. That is the product's selling point.** Everything runs in the browser extension; the only network call
  of our own is to the office's AI model (OpenAI-compatible API: llama.cpp, Ollama, vLLM). Sign-in is the office's
  Keycloak. Admin rules come from browser policy. Do not add a server.
- **Model API keys**: none today. If a user types one in, it is kept for good (not per session), encrypted at rest
  (`extension/lib/local/secret.ts`).
- **The agent never types passwords**; sign-in pages are always left to the person.
- **Dummy data is marked as dummy** (every generated letter says DUMMY on each page).
- **Reply-letter format**: the user said they will send the exact format they want. Until then replies use the templates
  in `extension/lib/local/letters/reply.ts` (`OPTIONS`, `OUR_OFFICE`, `draftReply`). Keep them easy to replace.
- The user writes short messages and wants **plain-language answers**: what was done, what works, what does not, with
  test numbers. Show results as tables when comparing. Report failures honestly, with the cause.
- Commit and push to `main` of `ParmanuAlways/assistant` when asked. The user's clone for viewing is
  `/home/user/assistant` (run `git pull` there after pushing).

## Layout

```
extension/                     the product (TypeScript, WXT; Chrome MV3 + Firefox MV2)
  lib/api.ts                   api('/api/...') -> answered inside the browser by lib/local (no server)
  lib/local/router.ts          tiny router; routes/*.ts register handlers
  lib/local/store.ts           IndexedDB ("office-assistant-data"): tasks, events, profile, settings, letters, comms, files...
  lib/local/audit.ts           hash-chained audit log (logEvent, verifyChain, taskEvents)
  lib/local/identity.ts        user from the Keycloak token; today() (test date via config.agent.today)
  lib/local/model.ts           calls the model server directly (json modes, fallbacks, vision)
  lib/local/agent.ts           prompts, page description, checks before submit, provenance, vision locate
  lib/local/routes/tasks.ts    the step-by-step decision loop (/api/tasks/:id/step) + settings, teach, playbooks
  lib/local/skills.ts          workflows: taught playbooks and learned "experiences" (replayed steps)
  lib/local/comms.ts           communications index + plain-words search
  lib/local/letters/           e-Office letters: PDF text (pdf.js), parse, intent, deadline, reply drafts, Word (docx)
  lib/local/secret.ts          encrypts a typed-in API key
  lib/config.ts                settings and admin rules: defaults < browser policy (storage.managed) < devConfig*
  lib/agent.ts                 client loop in the panel: snapshot page -> /step -> act
  lib/page.ts                  reads the page (frames, Shadow DOM, menus) and acts (click/type/pick_date/upload...)
  entrypoints/sidepanel/       the panel UI (main.ts, letters.ts, index.html, style.css)
  entrypoints/background.ts    files e-Office downloads into Downloads/eOffice/<sender>/ (Chrome)
  entrypoints/offscreen/       reads PDFs for the background (Chrome MV3 service workers cannot run pdf.js)
  entrypoints/audit/           auditor dashboard
  public/managed-schema.json   every policy setting
portal/                        demo office sites (Python/FastAPI): HR :8200, intranet apps :8300 (+ /directory.json),
                               Legacy ERP :8500 (frames, dialogs, Shadow DOM, canvas seat map), e-Office :8600
portal/govletters.py           generates the 100 dummy service-format letters (fixed seed); samples/ has the PDFs
standin-model/server.py        rule-based fake "model" (OpenAI API) for tests :9100. NOT AI
infra/setup_keycloak.py        demo realm, client, users (ravi/ravi123, anita/anita123 auditor, admin1/admin123, priya)
tests/                         see "Testing"
release/                       INSTALL.md, policy examples, 0.2.0/ packages (crx, zips, xpi, checksums)
screenshots/                   feature screenshots (ui, letters, comms, hard-web)
eval-results/                  every real-model run (nb-* = after the backend was removed)
```

\* `devConfig` in `storage.local` is honoured **only for unpacked (developer) installs**. Tests use it to set the
model under test, the date and admin rules. An installed .crx/signed add-on ignores it.

## Run and test

Fresh machine: `MODELS=1 tests/setup-environment.sh` (installs Keycloak, Roundcube, Docker images, npm/pip packages,
llama.cpp + Gemma 4 E4B). Then:

```bash
tests/start-test-stack.sh                    # hosts, Keycloak, stand-in model, demo sites, Docker, mail server, webmail
for t in tests/local/*.test.ts; do tests/local/run.sh $t; done    # unit checks in Node (fake IndexedDB), ~1 min
cd extension && npm run build && npm run build:firefox            # -> extension/.output/
tests/run-fast-suite.sh                      # every browser test with the stand-in model, ~25 min
tests/run-nobackend-model.sh                 # real-model tasks (Gemma 4 E4B on CPU), ~2.5 h
```

Single tests (from `tests/`): `xvfb-run -a node e2e.mjs`, `QUIET=1 xvfb-run -a node probe.mjs`,
`xvfb-run -a -s "-screen 0 1440x900x24" node letters-shots.mjs` (also `comms-shots.mjs`, `ui-shots.mjs`),
`xvfb-run -a node teach.mjs <label> helpdesk`, `bash firefox-setup.sh && python3 firefox_e2e.py`,
`TASKSET=intranet|legacy|mail|vision REPEAT=2 xvfb-run -a node eval.mjs <label> [task-id]`.
The model and date for a run: start the services with e.g. `AGENT_TODAY=2026-10-19 DEFAULT_MODEL_URL=http://llm.office.local:9200/v1
DEFAULT_MODEL_NAME=gemma4-e4b ./start-services.sh`; it writes `infra/logs/run-env.json`, which the browser tests hand to
the extension (`tests/dev-config.mjs`). Serve a model: `/home/user/models/serve.sh /home/user/models/gemma4-e4b-q4_k_m.gguf`
(add `MMPROJ=/home/user/models/gemma4-e4b-mmproj.gguf` for vision).

Last results (0.2.0): unit 143/143, e2e 42/42, probe 7/7, letters 14/14, comms 8/8, ui 9/9, teach ok, Firefox 14/14;
real model: intranet 7/7, Legacy ERP 10/10, teach 3/3, seat map 2/2, webmail 5/5. See `EVALUATION.md` Part 7.

## Traps in this environment (learned the hard way)

- **The machine restarts** now and then: `/etc/hosts` entries and all services are gone (`ERR_NAME_NOT_RESOLVED`).
  Run `tests/start-test-stack.sh` again. Files under /home/user survive.
- **`pkill -f` can kill your own shell**: never put the pattern's text in the same command line (e.g. a command that
  contains "uvicorn intranet:app" and `pkill -f "intranet:app"`). Use `pkill -f "intranet:ap[p]"` or run it alone.
- **Background commands are stopped after 2 h**; long runs: `setsid nohup bash script.sh > log 2>&1 < /dev/null &`
  and watch the log. Scripts that start servers must not inherit your stdout (`> /dev/null 2>&1 < /dev/null`).
- **CPU**: 4 cores, no GPU. Gemma 4 E4B gives ~6 tokens/s when the machine is idle; anything else running (an animated
  page, the Firefox Docker container's VNC) slows it a lot. Never add endless CSS animations (see EVALUATION Part 7).
  `docker rm -f ffgrid` after the Firefox test.
- **Browser profiles**: tests that reuse a profile stay signed in to the demo sites; start from a fresh one.
- **Chrome holds plain-HTTP downloads**: the letters test passes `--unsafely-treat-insecure-origin-as-secure` for the demo
  e-Office (a real e-Office is HTTPS).
- **Git**: pushing `main` works; pushing tags and creating GitHub Releases is not allowed from these sessions (403).
- **Never commit** `infra/keys/extension-key.pem` (signs the .crx, fixes the extension ID). It is gitignored; a new
  machine does not have it, so a new .crx would need it copied over (or a new key = new extension ID, and the Keycloak
  redirect URI changes).
- The AI models (`/home/user/models`, several GB) are not in the repo: `MODELS=1 tests/setup-environment.sh`.
- Do not `rm -rf` with globs or variables in paths: a safety check blocks it. Use new folders instead.

## Open items

1. The user's reply-letter format (they will send it); then change `letters/reply.ts` and the letters tests.
2. "Choose folder" / "Tidy a folder" (Letters) use the folder picker, which automated tests cannot click: untested.
3. Real e-Office letters (scanned PDFs need OCR; Hindi or bilingual letters) are untested: tests use generated letters.
4. Webmail shows no "sent" message, so the model sometimes starts the same action again; the "you already approved
   this" warning stops a second send. A better done-check for mail would help.
5. Firefox package is unsigned: sign on addons.mozilla.org for Release Firefox.
6. Real-model results are 1-2 runs per task on one machine: spot checks, not statistics.

## Conventions

- Match the surrounding code: short comments that say why, plain names, no frameworks added.
- Every bug fix gets a unit check in `tests/local/*.test.ts`; browser behaviour gets a check in the browser tests.
- After changes: unit tests, build both browsers, the relevant browser test; update README/EVALUATION when behaviour or
  results change; keep `extension/public/managed-schema.json` in step with `lib/config.ts`.
