// Screenshots of the Communications feature: the office app's own list (hard to search) next to the assistant's
// folders and search. Usage: xvfb-run -a -s "-screen 0 1440x900x24" node comms-shots.mjs [outdir]
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const ROOT = '/home/user/browser-agent';
const EXT = `${ROOT}/extension/.output/chrome-mv3`;
const OUT = process.argv[2] || `${ROOT}/screenshots/comms`;
const L = 'http://legacy.office.local:8500';
const W = 1440, H = 900, PANEL = 430;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const grab = (name) => execFileSync('import', ['-window', 'root', `${OUT}/${name}.png`]);
const checks = [];
const check = (name, ok) => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };

// a test profile without Chrome's "Save password?" bubble
const PROFILE = '/tmp/claude-0/comms-shots-profile';
fs.mkdirSync(`${PROFILE}/Default`, { recursive: true });
fs.writeFileSync(`${PROFILE}/Default/Preferences`, JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false } }));
const ctx = await chromium.launchPersistentContext(PROFILE, {
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
  // the person signs in to the office app as usual
  await portal.goto(`${L}/`);
  await portal.fill('#login_user', 'ravi');
  await portal.fill('#login_pass', 'ravi123');
  await portal.click('#login_btn');
  await portal.goto(`${L}/?main=/comms%3Fbox%3Dout`);
  const panelWait = ctx.waitForEvent('page', (p) => p.url().includes('sidepanel.html'));
  await sw.evaluate(async ([l, w, h]) => {
    const [main] = await chrome.windows.getAll({ windowTypes: ['normal'] });
    await chrome.windows.update(main.id, { left: 0, top: 0, width: l, height: h, state: 'normal' });
    const win = await chrome.windows.create({ url: chrome.runtime.getURL('sidepanel.html'), type: 'popup', left: l, top: 0, width: w, height: h });
    await chrome.windows.update(win.id, { left: l, top: 0, width: w, height: h });
  }, [W - PANEL, PANEL, H]);
  const panel = await panelWait;
  await panel.waitForLoadState();
  const kcWait = ctx.waitForEvent('page', (p) => p.url().includes('keycloak.office.local'));
  await panel.click('#login-btn');
  const kc = await kcWait;
  await kc.fill('#username', 'ravi');
  await kc.fill('#password', 'ravi123');
  await kc.click('#kc-login');
  await panel.waitForSelector('#signed-in:not([hidden])', { timeout: 20000 });
  await sleep(1000);
  grab('01-office-app-outward-list');   // the app's own list: one long table, search by exact reference only

  await panel.click('nav button[data-tab=comms]');
  await panel.waitForSelector('.comm', { timeout: 20000 });
  await sleep(600);
  const n = await panel.$$eval('.comm', (l) => l.length);
  check('Communications read from the office app and listed', n > 0);
  check('Folders with counts are visible', await panel.isVisible('.folder.on'));
  grab('02-comms-all');

  await panel.click('#comms-dir button[data-dir=sent]');
  await sleep(700);
  const sentOnly = await panel.$$eval('.comm .dir', (l) => l.every((x) => x.textContent.includes('Sent')));
  check('Sent shows only what you sent', sentOnly);
  grab('03-comms-sent');

  await panel.click('#comms-dir button[data-dir=""]');
  await panel.fill('#comms-q', 'letters I sent to Priya about leave');
  await sleep(900);
  check('Plain-words search finds a letter to Priya, with highlights',
    (await panel.textContent('#comms-results')).includes('Priya') && (await panel.$$('.comm mark')).length > 0);
  grab('04-search-plain-words');

  await panel.fill('#comms-q', 'holiday');
  await sleep(500);
  await panel.click('.folder[data-f="Circulars"]');
  await sleep(700);
  check('Folder + search: circulars about holidays', (await panel.textContent('#comms-results')).toLowerCase().includes('holiday'));
  grab('05-folder-circulars');

  const opened = ctx.waitForEvent('page');
  await panel.click('.comm');
  const item = await opened;
  await item.waitForLoadState();
  await sleep(1200);
  check('Clicking a result opens it in the office app', (await item.url()).includes('/comms/'));
  grab('06-opened-in-app');
  await item.close();

  // the same thing from the chat
  await panel.click('.folder[data-f=""]');
  await panel.click('nav button[data-tab=assistant]');
  await panel.fill('#prompt', 'Find the circular about the holiday list');
  await panel.click('#run-btn');
  await panel.waitForSelector('.comm-results-bubble', { timeout: 20000 });
  await sleep(800);
  check('Asking in the chat answers from the communications', (await panel.$$('.comm-results-bubble .comm')).length > 0);
  grab('07-chat-search');
  console.log(`${checks.filter(Boolean).length}/${checks.length} checks passed; shots in ${OUT}`);
} finally {
  await ctx.close();
}
