// Screenshots of the whole screen: a real Chrome window with the Office Assistant panel docked on the right.
// Usage: xvfb-run -a -s "-screen 0 1440x900x24" node ui-shots.mjs [outdir] ["task 1 || task 2 || ..."]
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const ROOT = '/home/user/browser-agent';
const EXT = `${ROOT}/extension/.output/chrome-mv3`;
const OUT = process.argv[2] || `${ROOT}/screenshots/ui`;
const TASK = process.argv[3] || 'Apply casual leave for 3 days from Monday, reason: family function';
const TASKS = TASK.split('||').map((t) => t.trim());
const START = process.env.START || 'http://intranet.office.local:8300/';
const W = 1440, H = 900, PANEL = 430;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const grab = (name) => execFileSync('import', ['-window', 'root', `${OUT}/${name}.png`]);

const ctx = await chromium.launchPersistentContext('/tmp/claude-0/ui-shots-profile', {
  headless: false, executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', viewport: null,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--window-position=0,0', `--window-size=${W - PANEL},${H}`,
         '--hide-crash-restore-bubble', '--test-type', '--no-default-browser-check'],
  ignoreDefaultArgs: ['--enable-automation'],
});
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const portal = ctx.pages()[0] || await ctx.newPage();
  for (const p of ctx.pages()) if (p !== portal) await p.close();
  await portal.goto(START);
  const panelWait = ctx.waitForEvent('page', (p) => p.url().includes('sidepanel.html'));
  // two windows side by side: the browser on the left, the assistant docked on the right
  await sw.evaluate(async ([l, w, h]) => {
    const [main] = await chrome.windows.getAll({ windowTypes: ['normal'] });
    await chrome.windows.update(main.id, { left: 0, top: 0, width: l, height: h, state: 'normal' });
    const win = await chrome.windows.create({ url: chrome.runtime.getURL('sidepanel.html'), type: 'popup', left: l, top: 0, width: w, height: h });
    await chrome.windows.update(win.id, { left: l, top: 0, width: w, height: h });
  }, [W - PANEL, PANEL, H]);
  const panel = await panelWait;
  await panel.waitForLoadState();
  await sleep(1200);
  grab('01-sign-in');

  const kcWait = ctx.waitForEvent('page', (p) => p.url().includes('keycloak.office.local'));
  await panel.click('#login-btn');
  const kc = await kcWait;
  await kc.fill('#username', 'ravi');
  await kc.fill('#password', 'ravi123');
  await kc.click('#kc-login');
  await panel.waitForSelector('#signed-in:not([hidden])', { timeout: 20000 });
  await sleep(1500);
  grab('02-home-first-time');

  // Register apps: one from the page that's open ("Use this page"), the rest by typing the address
  await panel.click('#add-link-btn');
  await panel.click('#link-current');
  await panel.fill('#link-title', 'Intranet');
  await sleep(400);
  grab('03-add-app');
  await panel.click('#link-form button[type=submit]');
  for (const [title, url] of [['Leave portal', 'http://hr.office.local:8200/'], ['IT helpdesk', 'http://helpdesk.office.local:8300/'],
    ['Rooms', 'http://rooms.office.local:8300/'], ['Webmail', 'http://mail.office.local:8400/'], ['Legacy ERP', 'http://legacy.office.local:8500/'],
    ['Canteen', 'http://canteen.office.local:8300/'], ['Expenses', 'http://expenses.office.local:8300/']]) {
    await panel.click('#add-link-btn');
    await panel.fill('#link-title', title);
    await panel.fill('#link-url', url);
    await panel.click('#link-form button[type=submit]');
    await sleep(300);
  }
  await sleep(600);
  grab('04-home-with-apps');

  // Opening an app is just opening the site
  const opened = ctx.waitForEvent('page');
  await panel.click('a.app[data-url="http://hr.office.local:8200/"]');
  const site = await opened;
  await site.waitForLoadState();
  await sleep(800);
  grab('05-app-opened');
  await site.close();
  await portal.bringToFront();
  await portal.goto(START);
  await panel.bringToFront();

  for (let run = 1; run <= TASKS.length; run++) {
    const first = run === 1;
    await panel.fill('#prompt', TASKS[run - 1]);
    await panel.click('#run-btn');
    let working = false, asked = false, reviewed = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 25 * 60 * 1000) {
      const s = await panel.evaluate(() => ({
        status: document.body.dataset.agent,
        ask: !document.getElementById('ask-box').hidden, confirm: !document.getElementById('confirm-box').hidden,
        steps: document.querySelectorAll('.work li.action').length,
      }));
      if (s.status !== 'running') break;
      // the page glows and shows what the assistant is doing
      const glowing = await portal.evaluate(() => !!document.getElementById('__oa_working')).catch(() => false);
      if (first && !working && glowing && s.steps >= 3 && !s.ask && !s.confirm) {
        working = true;
        grab('06-working');
      }
      if (s.ask) {
        if (first && !asked) { asked = true; await sleep(400); grab('07-question'); }
        if (await portal.$('#login_user')) {
          await portal.fill('#login_user', 'ravi'); await portal.fill('#login_pass', 'ravi123'); await portal.click('#login_btn');
        }
        const opts = await panel.$$('#ask-options button');
        if (opts.length) await opts[0].click();
        else if (await panel.isVisible('#ask-input')) { await panel.fill('#ask-input', '9123456780'); await panel.click('#ask-send'); }
        else await panel.click('#ask-send');
      } else if (s.confirm) {
        if (first && !reviewed) { reviewed = true; await sleep(400); grab('08-review'); }
        await panel.click('#confirm-yes');
      }
      await sleep(200);
    }
    await sleep(1200);
    if (first) {
      grab('09-done');
      await panel.click('.work-head');          // open the finished step list
      await sleep(500);
      grab('10-steps-expanded');
    }
    await panel.click('#home-btn');
    await portal.goto(START);
    await sleep(800);
  }
  grab('11-home-personalised');
  await panel.click('nav button[data-tab=history]');
  await sleep(1200);
  grab('12-history');
  await panel.click('nav button[data-tab=profile]');
  await sleep(1000);
  grab('13-my-details');
  console.log('shots in', OUT);
} finally {
  await ctx.close();
}
