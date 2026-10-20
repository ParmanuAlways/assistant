// Teach-mode test: a person (scripted) records a workflow once through the Teach tab, the model drafts
// a playbook, the user saves it and it is used from then on (in this browser; admins share it through policy). Usage: xvfb-run -a node teach.mjs <label> <demo>
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { applyDevConfig } from './dev-config.mjs';

const [LABEL, DEMO] = process.argv.slice(2);
const ROOT = '/home/user/browser-agent';
const EXT = `${ROOT}/extension/.output/chrome-mv3`;
const OUT = `${ROOT}/eval-results/teach-${LABEL}`;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Demonstrations deliberately use DIFFERENT values from the evaluation tasks
const DEMOS = {
  // Legacy ERP: frames, hover menu, calendar widget, postback link with a native confirm()
  legacytravel: {
    name: 'Raise a travel request in the Legacy ERP',
    demoValues: ['Mumbai', 'Training', '04-Nov', '06-Nov'],
    async run(p) {
      await fetch('http://legacy.office.local:8500/debug/reset', { method: 'POST' });
      p.on('dialog', (d) => d.accept());                // the person clicks OK on "Submit travel request...?"
      await p.click('text=Legacy ERP');
      await p.fill('#login_user', 'ravi');               // the person signs in (not recorded: passwords never are)
      await p.fill('#login_pass', 'ravi123');
      await p.click('#login_btn');
      await p.waitForSelector('frame[name=main]');
      await sleep(800);
      const nav = p.frame({ name: 'nav' });
      await nav.hover('text=Requests');
      await nav.click('text=Travel Request');
      await sleep(1000);
      const main = p.frame({ name: 'main' });
      await main.fill('#dest', 'Mumbai');
      await main.click('img[alt="Pick from date"]');
      await main.click('#cal td >> text=">"');
      await main.click('#cal td:text-is("4")');
      await main.click('img[alt="Pick to date"]');
      await main.click('#cal td >> text=">"');
      await main.click('#cal td:text-is("6")');
      await main.selectOption('select[name=purpose]', 'Training');
      await main.click('#btnSubmit');
      await main.waitForSelector('text=submitted for approval');
    },
  },
  canteen: {
    name: 'Order food from the canteen',
    demoValues: ['A1-001', 'Masala Dosa', 'Filter Coffee', 'Snacks'],
    async run(p) {
      await p.click('text=Canteen Orders');
      await p.click('text=Sign in with company account');
      await p.click('text=Order Food');
      await p.waitForSelector('[aria-label="Add one Masala Dosa"]');
      await p.click('[aria-label="Add one Masala Dosa"]');
      await p.click('[aria-label="Add one Filter Coffee"]');
      await p.click('button[data-slot="Snacks"]');
      await p.click('button[data-mode="Desk"]');
      await p.fill('#desk', 'A1-001');
      await p.click('#place');
      await p.click('#yes');
      await p.waitForSelector('text=Order placed');
    },
  },
  helpdesk: {
    name: 'Raise an IT support ticket',
    demoValues: ['LT-9999', 'Outlook', 'calendar', 'Software'],
    async run(p) {
      await p.click('text=IT Service Desk');
      await p.click('text=Sign in with company account');
      await p.click('text=Raise a Ticket');
      await p.selectOption('#cat', 'Software');
      await p.check('input[name=priority][value=Low]');
      await p.fill('#subj', 'Outlook keeps crashing');
      await p.fill('#desc', 'Outlook closes by itself when I open the calendar.');
      await p.fill('#asset', 'LT-9999');
      await p.click('text=Raise Ticket');
      await p.waitForSelector('text=Ticket raised');
    },
  },
};

const ctx = await chromium.launchPersistentContext(`${OUT}/.profile`, {
  headless: false, executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1100, height: 900 },
});
const result = { label: LABEL, demo: DEMO };
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const portal = await ctx.newPage();
  for (const p of ctx.pages()) if (p !== portal) await p.close().catch(() => {});
  await portal.goto('http://intranet.office.local:8300/');
  const panelWait = ctx.waitForEvent('page', (p) => p.url().includes('sidepanel.html'));
  await sw.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL('sidepanel.html'), type: 'popup', width: 460, height: 1000 }));
  const panel = await panelWait;
  await panel.setViewportSize({ width: 460, height: 1000 });
  async function signIn(user, pw) {
    const kcWait = ctx.waitForEvent('page', (p) => p.url().includes('keycloak.office.local'));
    await panel.click('#login-btn');
    const kc = await kcWait;
    await kc.fill('#username', user);
    await kc.fill('#password', pw);
    await kc.click('#kc-login');
    await panel.waitForSelector('#signed-in:not([hidden])', { timeout: 20000 });
  }

  // 1. Ravi records the workflow
  await applyDevConfig(panel);   // the model under test (as browser policy would set it)
  await signIn('ravi', 'ravi123');
  await panel.click('nav button[data-tab=teach]');
  await panel.fill('#teach-name', DEMOS[DEMO].name);
  await panel.click('#teach-start');
  await panel.waitForFunction(() => document.body.dataset.teach === 'recording');
  await DEMOS[DEMO].run(portal);
  await sleep(1500);
  await portal.screenshot({ path: path.join(OUT, '1-demo-finished.png') });
  result.recorded = await panel.$$eval('#teach-events li', (l) => l.map((x) => x.textContent));
  await panel.screenshot({ path: path.join(OUT, '2-recording.png'), fullPage: true });
  await panel.click('#teach-stop');
  await panel.waitForFunction(() => ['review', 'error'].includes(document.body.dataset.teach), null, { timeout: 900000 });
  result.draft = await panel.inputValue('#teach-draft');
  // Draft quality: a reusable playbook must not copy the demonstrated values
  const lines = result.draft.split('\n').filter((l) => l.trim());
  result.quality = {
    has_start_url: /start url:\s*http/i.test(result.draft),
    steps: lines.length - 1,
    copied_demo_values: DEMOS[DEMO].demoValues.filter((v) => result.draft.toLowerCase().includes(v.toLowerCase())),
  };
  console.log('DRAFT QUALITY:', JSON.stringify(result.quality));
  await panel.screenshot({ path: path.join(OUT, '3-draft-playbook.png'), fullPage: true });
  await panel.click('#teach-save');
  await panel.waitForFunction(() => document.body.dataset.teach === 'saved');
  result.saved_status = await panel.textContent('#teach-status');

  // 2. It is active straight away (there is no server where an admin would approve it)
  await panel.waitForSelector('#playbook-list .task');
  result.active = (await panel.textContent('#playbook-list')).includes('active');
  await panel.screenshot({ path: path.join(OUT, '4-active.png'), fullPage: true });
  console.log('RECORDED:\n  ' + result.recorded.join('\n  '));
  console.log('DRAFT PLAYBOOK:\n' + result.draft);
  console.log('SAVED:', result.saved_status, '| active:', result.active);
} catch (e) {
  result.error = String(e.stack || e);
  console.error('TEACH CRASH', e);
} finally {
  fs.writeFileSync(path.join(OUT, 'teach.json'), JSON.stringify(result, null, 2));
  await ctx.close();
  fs.rmSync(`${OUT}/.profile`, { recursive: true, force: true });
}
