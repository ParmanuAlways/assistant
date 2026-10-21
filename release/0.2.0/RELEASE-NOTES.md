**Office Assistant 0.2.0**: the AI assistant for intranet sites, now with no server of its own: just the browser extension, your Keycloak, and an OpenAI-compatible AI model server in the office.

**Download**
- `office-assistant-0.2.0.crx`: Chrome / Edge, signed (extension ID `abkbnfmigkhijkaakbjmdnddinokicop`), for installing on every PC through policy
- `office-assistant-0.2.0-chrome.zip`: Chrome, to try it (unzip, then Load unpacked in `chrome://extensions`)
- `office-assistant-0.2.0-firefox.xpi`: Firefox, **unsigned**: Release Firefox needs it signed on addons.mozilla.org; Firefox ESR / Developer Edition can install it with signature checks off; or load it as a temporary add-on
- `office-assistant-0.2.0-sources.zip`: source code (Mozilla asks for it when signing)
- `INSTALL.md`, `chrome-policy-example.json`, `update.xml`, `firefox-policies-example.json`: how to install, examples for IT
- `SHA256SUMS.txt`: checksums

**What's in it**
- Assistant panel: home screen with your apps, frequent and recent tasks; chat; review card showing where each value came from before anything is submitted
- Does office tasks on intranet sites (forms, tables, frames, pop-ups, dialogs, uploads), learns from past runs, teach mode, playbooks shared through policy
- Comms: sent/received, folders, plain-words search
- Letters: e-Office downloads filed per sender, what each letter asks and when the reply is due, reply options (including declining diplomatically), service-format Word drafts
- Audit log in the browser, hash-chained (tampering detected), auditor dashboard and export
- All data stays in the browser on the user's PC; admin rules come from browser policy; a user's model API key is kept encrypted

**Tested**: unit checks 143/143; end-to-end in Chrome 42/42 on this build; Firefox 14/14; with a real model (Gemma 4 E4B on CPU): intranet tasks 7/7, Legacy ERP 10/10, webmail 5/5 (prompt-injection email ignored), vision seat map 2/2. Details in EVALUATION.md, Part 7.

Without IT's policy it points at the demo hosts (`*.office.local`): set your Keycloak, model server and sites as in INSTALL.md.
