// End-to-end test: real Chromium + the built extension + Keycloak + HR portal. No assistant server: the extension
// keeps everything in the browser and only calls the model server.
// Run with: xvfb-run -a node e2e.mjs   (services must be running: ../start-services.sh)
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/user/browser-agent';
const EXT = `${ROOT}/extension/.output/chrome-mv3`;
const OUT = `${ROOT}/test-results`;
const PROFILE = `${OUT}/.chrome-profile`;
const EXPECTED_ID = fs.readFileSync(`${ROOT}/infra/keys/extension-id.txt`, 'utf8').trim();

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
let shotNo = 0;
async function shot(page, name) {
  const file = `${String(++shotNo).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: path.join(OUT, file), fullPage: true });
  return file;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portalLeaves = async () => (await fetch('http://hr.office.local:8200/debug/leaves')).json();

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1100, height: 900 },
});

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  check('Extension loads in Chrome with the fixed ID', extId === EXPECTED_ID, extId);

  const portal = await ctx.newPage();
  for (const p of ctx.pages()) if (p !== portal) await p.close().catch(() => {});
  await portal.goto('http://hr.office.local:8200/');
  await shot(portal, 'portal-before');

  // The side panel UI, opened as its own window so the portal tab stays visible
  async function openPanel() {
    const wait = ctx.waitForEvent('page', (p) => p.url().includes('sidepanel.html'));
    await sw.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL('sidepanel.html'), type: 'popup', width: 440, height: 900 }));
    const p = await wait;
    await p.setViewportSize({ width: 440, height: 900 });
    await p.waitForLoadState();
    return p;
  }
  let panel = await openPanel();
  await shot(panel, 'panel-signed-out');

  async function signIn(username, password) {
    const popupWait = ctx.waitForEvent('page', (p) => p.url().includes('keycloak.office.local'));
    await panel.click('#login-btn');
    const kc = await popupWait;
    await kc.waitForSelector('#username');
    await kc.fill('#username', username);
    await kc.fill('#password', password);
    await kc.click('#kc-login');
    await panel.waitForSelector('#signed-in:not([hidden])', { timeout: 20000 });
    await panel.waitForFunction(() => document.getElementById('user-name').textContent.length > 0);
  }
  async function signOut() {
    await panel.click('#logout-btn');
    await panel.waitForSelector('#signed-out:not([hidden])');
  }
  // Call the assistant's API (answered inside the extension) as the signed-in user
  const apiAs = (p, path, method = 'GET', body) => p.evaluate(async ({ path, method, body }) => {
    try {
      return { status: 200, body: await window.__officeAssistantDebug.api(path, method, body) };
    } catch (e) {
      return { status: e.status || 500, body: { detail: e.message } };
    }
  }, { path, method, body });
  // The audit log, read from the browser's storage
  const events = (p) => p.evaluate(() => window.__officeAssistantDebug.store.all('events'));
  const tasks = (p) => p.evaluate(() => window.__officeAssistantDebug.store.all('tasks'));
  // IT pushes admin rules through browser policy; a developer build lets the test set them the same way
  const setPolicy = (p, cfg) => p.evaluate(async (c) => {
    const { devConfig = {} } = await chrome.storage.local.get('devConfig');
    await chrome.storage.local.set({ devConfig: { ...devConfig, ...c, agent: { ...devConfig.agent, ...c.agent } } });
  }, cfg);
  // the date the test data assumes ("from Monday"), as ./start-services.sh was told (AGENT_TODAY)
  let started = {};
  try { started = JSON.parse(fs.readFileSync(`${ROOT}/infra/logs/run-env.json`, 'utf8')); } catch {}
  await setPolicy(panel, { agent: { today: process.env.AGENT_TODAY || started.AGENT_TODAY || '2026-10-18' } });
  async function tab(name) {
    await panel.click(`nav button[data-tab=${name}]`);
    await sleep(600);
  }

  // ------------------------------------------------------------ 1. Keycloak sign-in
  await signIn('ravi', 'ravi123');
  const hello = await panel.textContent('#user-name');
  check('Keycloak sign-in in the extension shows the user', hello.includes('Ravi Kumar') && (await panel.textContent('#user-emp')).includes('EMP1042'), `${hello} ${await panel.textContent('#user-emp')}`);
  check('Normal user does not see the Audit button', await panel.isHidden('#audit-btn'));
  await shot(panel, 'panel-signed-in-ravi');

  // ------------------------------------------------------------ 2. Profile from directory
  await tab('profile');
  const profText = await panel.textContent('#profile-table');
  check('Profile filled automatically from company directory', profText.includes('EMP1042') && profText.includes('Priya Sharma') && profText.includes('directory'));
  check('No emergency contact known yet', !profText.includes('emergency_contact'));
  await shot(panel, 'profile-from-directory');

  // ------------------------------------------------------------ 3. Settings + test connection
  await tab('settings');
  check('Settings shows the active model', (await panel.textContent('#active-model')).includes('stand-in'), await panel.textContent('#active-model'));
  check('Custom endpoint option hidden while admin policy forbids it', await panel.isHidden('#custom-fields'));
  await panel.click('#test-btn');
  await panel.waitForFunction(() => !document.getElementById('settings-status').textContent.includes('Testing'));
  const testStatus = await panel.textContent('#settings-status');
  check('Test connection to the model works', testStatus.includes('Connected'), testStatus);
  await shot(panel, 'settings');
  const customDenied = await apiAs(panel, '/api/settings', 'PUT', { mode: 'custom', custom_url: 'http://llm.office.local:9100/v1', custom_model: 'x' });
  check('A custom endpoint is refused when policy forbids it', customDenied.status === 403, customDenied.body?.detail);
  const notAdmin = await apiAs(panel, '/api/admin/policy', 'PUT', { allow_custom_endpoints: true });
  check('Admin rules cannot be changed from the assistant (only by browser policy)', notAdmin.status === 403);
  const notAuditor = await apiAs(panel, '/api/audit/verify');
  check('Normal user cannot use auditor functions', notAuditor.status === 403);

  // ------------------------------------------------------------ helper: run one task through the panel
  async function runTask(prompt, { answers = {}, confirm = true, label }) {
    await tab('assistant');
    await panel.evaluate(() => (document.getElementById('log').innerHTML = ''));
    await panel.fill('#prompt', prompt);
    await panel.click('#run-btn');
    const asked = [];
    let confirmed = null;
    let confirmations = 0;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const state = await panel.evaluate(() => ({
        status: document.body.dataset.agent,
        ask: !document.getElementById('ask-box').hidden && document.getElementById('ask-question').textContent,
        confirm: !document.getElementById('confirm-box').hidden,
      }));
      if (state.status && state.status !== 'running') break;
      if (state.ask) {
        asked.push(state.ask);
        if (/password|sign in/i.test(state.ask)) {
          // The assistant hands sign-in to the human: the person types the password on the page.
          await shot(panel, `${label}-asks-user-to-sign-in`);
          await portal.waitForSelector('#username');
          await portal.fill('#username', 'ravi');
          await portal.fill('#password', 'ravi123');
          await portal.click('#kc-login');
          await portal.waitForURL(/hr\.office\.local/);
          await panel.click('#ask-send');
        } else {
          const key = Object.keys(answers).find((k) => state.ask.toLowerCase().includes(k));
          await shot(panel, `${label}-question`);
          const optionBtn = await panel.$(`#ask-options button:has-text("${answers[key]}")`);
          if (optionBtn) await optionBtn.click();
          else {
            await panel.fill('#ask-input', answers[key] ?? '');
            await panel.click('#ask-send');
          }
        }
      } else if (state.confirm) {
        await shot(portal, `${label}-form-filled`);
        await shot(panel, `${label}-confirm`);
        confirmed = await panel.textContent('#confirm-table');
        confirmations++;
        await panel.click(confirm ? '#confirm-yes' : '#confirm-no');
      }
      await sleep(400);
    }
    const status = await panel.evaluate(() => document.body.dataset.agent);
    const logText = await panel.textContent('#log');
    await shot(panel, `${label}-panel-done`);
    await shot(portal, `${label}-portal-done`);
    return { status, asked, confirmed, confirmations, logText };
  }

  // ------------------------------------------------------------ 4. Task 1: apply casual leave
  const before1 = (await portalLeaves()).length;
  const t1 = await runTask('Apply casual leave for 3 days from Monday, reason: family function', {
    answers: { emergency: '9123456780' }, label: 'task1' });
  const leaves1 = await portalLeaves();
  const l1 = leaves1[leaves1.length - 1];
  check('Task 1 completed', t1.status === 'completed', t1.logText.slice(-160));
  check('Assistant asked for the missing emergency contact (and nothing else it already knew)',
    t1.asked.filter((q) => !/password|sign in/i.test(q)).length === 1 && /emergency/i.test(t1.asked.join(' ')), JSON.stringify(t1.asked));
  check('Asked for confirmation exactly once (only for the final submit, not for navigation)', t1.confirmations === 1, `${t1.confirmations} confirmation(s)`);
  check('Confirmation showed the filled form before submit', t1.confirmed && t1.confirmed.includes('2026-10-19') && t1.confirmed.includes('Casual Leave'), t1.confirmed);
  check('Leave really saved in the portal with correct details',
    leaves1.length === before1 + 1 && l1.leave_type === 'Casual Leave' && l1.from_date === '2026-10-19' && l1.to_date === '2026-10-21' &&
    l1.days === 3 && l1.emp_id === 'EMP1042' && l1.reason === 'family function' && l1.emergency_contact === '9123456780' && l1.manager === 'Priya Sharma',
    JSON.stringify(l1));
  check('Panel shows the leave reference to the user', t1.logText.includes(l1.ref), l1.ref);

  await tab('profile');
  const prof2 = await panel.textContent('#profile-table');
  check('Answer was learned into the profile', prof2.includes('emergency_contact') && prof2.includes('9123456780') && prof2.includes('learned'));
  await shot(panel, 'profile-learned');

  // ------------------------------------------------------------ 5. Task 2: uses learned detail, no question
  const t2 = await runTask('Apply sick leave on 2 Nov 2026 for 1 day, reason: medical checkup', { label: 'task2' });
  const leaves2 = await portalLeaves();
  const l2 = leaves2[leaves2.length - 1];
  check('Task 2 completed without asking any question', t2.status === 'completed' && t2.asked.length === 0, JSON.stringify(t2.asked));
  check('Task 2 saved correctly', l2.leave_type === 'Sick Leave' && l2.from_date === '2026-11-02' && l2.to_date === '2026-11-02' && l2.emergency_contact === '9123456780', JSON.stringify(l2));

  // ------------------------------------------------------------ 6. Task 3: user declines the final submit
  const count3 = (await portalLeaves()).length;
  const t3 = await runTask('Apply earned leave from 10 Dec 2026 to 12 Dec 2026, reason: vacation', { confirm: false, label: 'task3' });
  check('Declining the confirmation stops the task and submits nothing', t3.status === 'cancelled' && (await portalLeaves()).length === count3, t3.status);

  // ------------------------------------------------------------ 7. History tab
  await tab('history');
  const nTasks = await panel.$$eval('#history-list .task', (els) => els.length);
  check('History tab lists the user\'s tasks', nTasks === 3, `${nTasks} tasks`);
  await panel.click('#history-list .task:last-child'); // oldest = task 1
  await panel.waitForSelector('#history-detail:not([hidden]) li');
  await panel.waitForFunction(() => [...document.querySelectorAll('#history-detail img')].every((i) => i.complete && i.naturalWidth > 0));
  const types = await panel.$$eval('#history-detail li', (els) => els.map((e) => e.dataset.type));
  check('Timeline records request, pages, model decisions, results, answer, confirmation, screenshots',
    ['user_message', 'page_snapshot', 'model_action', 'action_result', 'user_answer', 'profile_learned', 'confirmation', 'screenshot', 'task_finished'].every((t) => types.includes(t)),
    [...new Set(types)].join(', '));
  check('Screenshots load in the timeline', (await panel.$$eval('#history-detail img', (i) => i.length)) >= 2);
  await shot(panel, 'history-timeline');

  // ------------------------------------------------------------ 8. Admin enables custom endpoints
  await signOut();
  check('Sign-out clears the token', (await panel.evaluate(async () => (await chrome.storage.session.get('tokens')).tokens)) === undefined);
  await signIn('admin1', 'admin123');
  const pol = await apiAs(panel, '/api/admin/policy', 'PUT', { allow_custom_endpoints: true });
  check('Even an admin changes rules through browser policy, not the assistant', pol.status === 403, pol.body?.detail);
  await setPolicy(panel, { allowCustomEndpoints: true });   // what IT's browser policy would do
  const pol2 = await apiAs(panel, '/api/admin/policy');
  check('The policy now allows custom model endpoints', pol2.status === 200 && pol2.body.allow_custom_endpoints === true, JSON.stringify(pol2.body));
  await signOut();
  await signIn('ravi', 'ravi123');

  // ------------------------------------------------------------ 9. User changes model URL
  await tab('settings');
  check('Custom endpoint option visible once allowed', await panel.isVisible('#custom-fields'));
  await panel.check('input[name=mode][value=custom]');
  await panel.fill('#custom-url', 'http://evil.example.com:11434/v1');
  await panel.fill('#custom-model', 'gemma3:12b');
  await panel.evaluate(() => (document.getElementById('settings-status').textContent = ''));
  await panel.click('#save-btn');
  await panel.waitForFunction(() => document.getElementById('settings-status').textContent.length > 0);
  const evil = await panel.textContent('#settings-status');
  check('Endpoint outside the allowed hosts is rejected', evil.includes('not an allowed model host'), evil);
  await shot(panel, 'settings-rejected-host');

  await panel.fill('#custom-url', 'http://llm.office.local:9100/v1');
  await panel.fill('#custom-model', 'stand-in-v1');
  await panel.evaluate(() => (document.getElementById('settings-status').textContent = ''));
  await panel.click('#test-btn');
  await panel.waitForFunction(() => /Connected|❌/.test(document.getElementById('settings-status').textContent));
  check('Custom endpoint test connection', (await panel.textContent('#settings-status')).includes('Connected'));
  await panel.click('#save-btn');
  await panel.waitForFunction(() => document.getElementById('active-model').textContent.includes('Custom'));
  check('Custom endpoint saved and active', (await panel.textContent('#active-model')).includes('llm.office.local:9100'));
  // an API key typed in for it: kept (for good) but encrypted in the browser's storage
  await apiAs(panel, '/api/settings', 'PUT', { mode: 'custom', custom_url: 'http://llm.office.local:9100/v1', custom_model: 'stand-in-v1', api_key: 'sk-e2e-secret-777' });
  const keyCheck = await panel.evaluate(async () => {
    const all = await window.__officeAssistantDebug.store.all('settings');
    return { sealed: all.every((x) => !x.custom_key || String(x.custom_key).startsWith('v1:')), plain: JSON.stringify(all).includes('sk-e2e-secret-777'),
      has: (await window.__officeAssistantDebug.api('/api/settings')).has_custom_key };
  });
  check('A typed-in API key is kept, encrypted (never in plain text)', keyCheck.sealed && !keyCheck.plain && keyCheck.has, JSON.stringify(keyCheck));
  await shot(panel, 'settings-custom-saved');

  // dead endpoint -> the assistant falls back to the admin's default model
  await panel.fill('#custom-url', 'http://llm.office.local:9999/v1');
  await panel.click('#save-btn');
  await panel.waitForFunction(() => document.getElementById('active-model').textContent.includes('9999'));
  const t4 = await runTask('Apply casual leave on 5 Jan 2027 for 1 day, reason: personal work', { label: 'task4' });
  const t4id = (await tasks(panel)).sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0].task_id;
  const t4events = (await events(panel)).filter((e) => e.task_id === t4id);
  const fallbackEvents = t4events.filter((e) => e.event_type === 'model_error');
  check('When the chosen model is down, it falls back to the default and logs it', t4.status === 'completed' && fallbackEvents.length > 0,
    JSON.stringify(fallbackEvents[0]?.payload || {}).slice(0, 160));
  // The rule-based stand-in clicks Submit on the form left over from the declined task (10-12 Dec): the pre-submit
  // verifier must notice that the request's date (5 Jan 2027) is not on the form, and tell the user
  const t4conf = t4events.filter((e) => e.event_type === 'confirmation').map((e) => e.payload);
  check('Pre-submit verifier flags a form that does not match the request', t4conf.some((c) => (c.checks || []).some((x) => x.includes('05 Jan 2027'))),
    JSON.stringify(t4conf.map((c) => c.checks)).slice(0, 200));
  await tab('settings');
  await panel.check('input[name=mode][value=list]');
  await panel.click('#save-btn');
  await sleep(500);
  const changes = (await events(panel)).filter((e) => e.event_type === 'settings_changed').length;
  check('Every settings change is in the audit log', changes >= 3, `${changes} settings_changed events`);

  // ------------------------------------------------------------ 10. Security checks on stored data
  const pwHits = (await events(panel)).filter((e) => /ravi123|admin123/.test(JSON.stringify(e))).length;
  check('No password ever reaches the audit log', pwHits === 0, `${pwHits} hits`);
  const leaked = await panel.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)) + JSON.stringify(
    await Promise.all(['tasks', 'profile', 'settings'].map((s) => window.__officeAssistantDebug.store.all(s)))));
  check('No password stored anywhere in the extension', !/ravi123|admin123/.test(leaked));

  // ------------------------------------------------------------ 11. Auditor dashboard
  await signOut();
  await signIn('anita', 'anita123');
  check('Auditor sees the Audit button', await panel.isVisible('#audit-btn'));
  const ownHist = await apiAs(panel, '/api/history');
  check('Auditor\'s own History shows only her tasks', ownHist.body.length === 0);
  const auditWait = ctx.waitForEvent('page', (p) => p.url().includes('audit.html'));
  await panel.click('#audit-btn');
  const audit = await auditWait;
  await audit.setViewportSize({ width: 1300, height: 1000 });
  await audit.waitForSelector('#tasks tr[data-id]');
  const auditRows = await audit.$$eval('#tasks tr[data-id]', (r) => r.length);
  check('Auditor dashboard lists everyone\'s tasks', auditRows === 4, `${auditRows} tasks`);
  await audit.click('#tasks tr[data-id]:last-child');
  await audit.waitForSelector('#detail li');
  await audit.click('#verify-btn');
  await audit.waitForSelector('#verify-result span');
  const v1 = await audit.textContent('#verify-result');
  check('Integrity check passes on the untouched log', v1.includes('Chain valid'), v1);
  await shot(audit, 'audit-dashboard-valid');

  // Simulate someone editing the history behind the assistant's back (e.g. with the browser's developer tools)
  await audit.evaluate(async () => {
    const db = await new Promise((ok) => { const r = indexedDB.open('office-assistant-data'); r.onsuccess = () => ok(r.result); });
    const t = db.transaction('events', 'readwrite');
    const s = t.objectStore('events');
    const all = await new Promise((ok) => { const r = s.getAll(); r.onsuccess = () => ok(r.result); });
    for (const e of all.filter((e) => e.event_type === 'user_answer')) {
      e.payload = JSON.parse(JSON.stringify(e.payload).replace('9123456780', '9000000000'));
      s.put(e);
    }
    await new Promise((ok) => (t.oncomplete = ok));
  });
  await audit.click('#verify-btn');
  await audit.waitForFunction(() => document.getElementById('verify-result').textContent.includes('TAMPER'));
  const v2 = await audit.textContent('#verify-result');
  check('Integrity check detects a tampered record', v2.includes('TAMPERING DETECTED') && v2.includes('user_answer'), v2);
  await shot(audit, 'audit-dashboard-tampered');
} catch (e) {
  check('Test run finished without crashing', false, e.stack);
  for (const p of ctx.pages()) await p.screenshot({ path: path.join(OUT, `crash-${ctx.pages().indexOf(p)}.png`) }).catch(() => {});
} finally {
  await ctx.close();
  const passed = results.filter((r) => r.ok).length;
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exitCode = passed === results.length ? 0 : 1;
}
