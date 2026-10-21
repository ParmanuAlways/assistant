# Installing Office Assistant 0.2.0

The files are in [`release/0.2.0/`](0.2.0) of this repository.

The assistant is only a browser extension: no server of its own. It needs your Keycloak (sign-in) and an
OpenAI-compatible AI model server in the office (llama.cpp, Ollama, vLLM...). Everything else stays in the browser.

| File | For |
|---|---|
| `office-assistant-0.2.0.crx` | Chrome / Edge, signed with the project key: extension ID `abkbnfmigkhijkaakbjmdnddinokicop` |
| `office-assistant-0.2.0-chrome.zip` | Chrome: trying it (Load unpacked), or uploading to the Chrome Web Store |
| `office-assistant-0.2.0-firefox.xpi` | Firefox (unsigned, see below) |
| `office-assistant-0.2.0-sources.zip` | the source, as Mozilla asks for when signing |
| `chrome-policy-example.json`, `update.xml`, `firefox-policies-example.json` | examples for IT |

## Try it on one PC

- **Chrome:** unzip `office-assistant-0.2.0-chrome.zip`, open `chrome://extensions`, turn on Developer mode,
  *Load unpacked*, pick the folder. Click the toolbar icon to open the panel.
- **Firefox:** `about:debugging` → This Firefox → *Load Temporary Add-on* → pick the `.xpi` (removed when Firefox closes).

Without settings from IT it points at the demo hosts (`*.office.local`), so set the policy below for your servers.
A copy loaded unpacked counts as a developer install and also reads test settings from the browser's storage;
for real users use the installed `.crx` / signed add-on, which only follow IT's policy.

## For every PC (IT)

**Chrome / Edge.** Put the `.crx` and `update.xml` (edit its address) on an intranet web server. Push
`ExtensionInstallForcelist` and the settings under `3rdparty → extensions → <id>` — see `chrome-policy-example.json`
(on Linux as a JSON file in `/etc/opt/chrome/policies/managed/`; on Windows by Group Policy, the extension settings under
`HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\<id>\policy`; Edge: `...\Microsoft\Edge\...`). All
settings are described in `managed-schema.json` inside the package.

**Firefox.** Release Firefox installs only add-ons signed by Mozilla: sign the `.xpi` on addons.mozilla.org
(unlisted is fine), or use Firefox ESR / Developer Edition with `xpinstall.signatures.required` set to false.
Then push `firefox-policies-example.json` as `policies.json`.

**Keycloak.** A public client `browser-agent` (PKCE S256) with redirect URIs
`https://abkbnfmigkhijkaakbjmdnddinokicop.chromiumapp.org/*` (Chrome) and
`https://<id>.extensions.allizom.org/*` (Firefox; the panel shows it), user attributes `emp_id`, `department`,
`manager`, `phone`, and roles `auditor`, `admin` where needed.

**Model.** List your model server(s) in `models`. If it needs an API key, put it in the policy (`key`).
