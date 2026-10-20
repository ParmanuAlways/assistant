// End-to-end test of the Letters feature in real Chrome: download letters from the dummy e-Office as a user would,
// check each lands in Downloads/eOffice/<sender>/, then pick reply options and generate service-format drafts.
// Chrome is started directly (not by Playwright) so its downloads go through the extension's filing like on a real PC.
// Usage: xvfb-run -a -s "-screen 0 1440x900x24" node letters-shots.mjs [outdir]
import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/user/browser-agent';
const EXT = `${ROOT}/extension/.output/chrome-mv3`;
const OUT = process.argv[2] || `${ROOT}/screenshots/letters`;
const E = 'http://eoffice.office.local:8600';
const W = 1440, H = 900, PANEL = 430, N = 20;
const PROFILE = '/tmp/claude-0/letters-shots-profile';
const DL = '/tmp/claude-0/letters-shots-downloads';
// a fresh browser profile: no letters filed yet (the assistant keeps them in the profile)
for (const d of [PROFILE, DL]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(`${PROFILE}/Default`, { recursive: true });
fs.mkdirSync(DL, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${PROFILE}/Default/Preferences`, JSON.stringify({
  credentials_enable_service: false, profile: { password_manager_enabled: false },
  download: { default_directory: DL, prompt_for_download: false, directory_upgrade: true },
  download_bubble: { partial_view_enabled: false },   // no pop-up over the page after each download
}));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const grab = (name) => execFileSync('import', ['-window', 'root', `${OUT}/${name}.png`]);
const checks = [];
const check = (name, ok, detail = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`); };
const walk = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];

const chrome = spawn('/opt/pw-browsers/chromium-1194/chrome-linux/chrome', [
  `--user-data-dir=${PROFILE}`, '--remote-debugging-port=9333', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  '--window-position=0,0', `--window-size=${W - PANEL},${H}`, '--no-first-run', '--no-default-browser-check', '--test-type',
  '--hide-crash-restore-bubble', '--no-sandbox',
  // the demo e-Office is plain HTTP; Chrome holds HTTP downloads for the user to OK (a real e-Office is HTTPS)
  `--unsafely-treat-insecure-origin-as-secure=${E}`, 'about:blank'], { stdio: 'ignore' });
let browser;
for (let i = 0; i < 40 && !browser; i++) {
  await sleep(500);
  browser = await chromium.connectOverCDP('http://127.0.0.1:9333').catch(() => null);
}
const ctx = browser.contexts()[0];
// Playwright takes over downloads when it connects; hand them back to Chrome (and so to the extension)
await (await browser.newBrowserCDPSession()).send('Browser.setDownloadBehavior', { behavior: 'default' });
try {
  // the extension's fixed ID comes from its public key (wxt.config.ts)
  const key = fs.readFileSync(`${ROOT}/extension/wxt.config.ts`, 'utf8').match(/EXTENSION_KEY = '([^']+)'/)[1];
  const extId = [...crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  const eo = ctx.pages()[0];
  // the person signs in to e-Office as usual
  await eo.goto(`${E}/`);
  await eo.fill('#eo_user', 'ravi');
  await eo.fill('#eo_pass', 'ravi123');
  await eo.click('#eo_login');
  await eo.waitForSelector('table');
  // three letters downloaded before signing in to the assistant: nothing can file them, they stay loose in Downloads
  await eo.goto(`${E}/?page_no=2`);
  const loose = (await eo.$$eval('a[href$="/download"]', (as) => as.map((a) => a.getAttribute('href')))).slice(0, 3);
  for (const href of loose) { await eo.click(`a[href="${href}"]`); await sleep(1500); }
  await sleep(1500);
  const looseFiles = fs.readdirSync(DL).filter((f) => f.endsWith('.pdf'));
  check('signed out: downloads stay as they are', looseFiles.length === 3, looseFiles.join(', '));
  await eo.goto(`${E}/`);
  const opener = await ctx.newPage();
  await opener.goto(`chrome-extension://${extId}/sidepanel.html`);
  const panelWait = ctx.waitForEvent('page', (p) => p.url().includes('sidepanel.html') && p !== opener);
  await opener.evaluate(async ([l, w, h]) => {
    const [main] = await chrome.windows.getAll({ windowTypes: ['normal'] });
    await chrome.windows.update(main.id, { left: 0, top: 0, width: l, height: h, state: 'normal' });
    const win = await chrome.windows.create({ url: chrome.runtime.getURL('sidepanel.html'), type: 'popup', left: l, top: 0, width: w, height: h });
    await chrome.windows.update(win.id, { left: l, top: 0, width: w, height: h });
  }, [W - PANEL, PANEL, H]);
  const panel = await panelWait;
  await opener.close();
  await panel.waitForLoadState();
  const kcWait = ctx.waitForEvent('page', (p) => p.url().includes('keycloak.office.local'));
  await panel.click('#login-btn');
  const kc = await kcWait;
  await kc.fill('#username', 'ravi');
  await kc.fill('#password', 'ravi123');
  await kc.click('#kc-login');
  await panel.waitForSelector('#signed-in:not([hidden])', { timeout: 20000 });
  await panel.click('nav button[data-tab=letters]');
  await sleep(800);
  await eo.bringToFront();
  grab('01-eoffice-inbox');   // the e-Office list: receipt no., sender, a cut-off subject; the letter itself is a PDF

  // download the first page of letters, one click each, like the user would
  const truth = await (await fetch(`${E}/debug/truth`)).json();
  const links = await eo.$$eval('a[href$="/download"]', (as) => as.map((a) => a.getAttribute('href')));
  for (const href of links.slice(0, N)) {
    await eo.click(`a[href="${href}"]`);
    await sleep(700);
  }
  await eo.evaluate(() => window.scrollTo(0, 0));
  const deadline = Date.now() + 60000;
  let files = [];
  while (Date.now() < deadline) {
    files = walk(`${DL}/eOffice`).filter((f) => f.endsWith('.pdf'));
    if (files.length >= N) break;
    await sleep(1000);
  }
  await sleep(1500);
  files = walk(DL).filter((f) => f.endsWith('.pdf') && !looseFiles.includes(path.basename(f)));
  check(`${N} downloads saved`, files.length === N, `${files.length} files: ${files.slice(0, 3).join(', ')}`);
  const filed = files.filter((f) => f.startsWith(`${DL}/eOffice/`) && path.relative(`${DL}/eOffice`, f).split(path.sep).length === 2);
  check('every letter filed as Downloads/eOffice/<sender>/<file>', filed.length === N, files.filter((f) => !filed.includes(f)).join(', '));
  const ids = links.slice(0, N).map((h) => Number(h.match(/receipt\/(\d+)/)[1]));
  const wantFolders = new Set(ids.map((id) => truth.find((t) => t.id === id)).map((t) =>
    t.sender_office && !t.sender_parent.toLowerCase().includes(t.sender_office.toLowerCase()) ? `${t.sender_parent} - ${t.sender_office}` : t.sender_parent)
    .map((s) => s.replace(/[\\/:*?"<>|]+/g, '-')));
  const gotFolders = new Set(filed.map((f) => path.basename(path.dirname(f))));
  check('sender folders match the letters', [...wantFolders].every((f) => gotFolders.has(f)) && gotFolders.size === wantFolders.size,
    `want ${[...wantFolders].join(' | ')}\n got ${[...gotFolders].join(' | ')}`);
  const named = filed.every((f) => /^\d{4}-\d{2}-\d{2} - (OM|DO|Letter|Circular|Notice|Reminder|Office Order) - .+\.pdf$/.test(path.basename(f)));
  check('file names: date - type - subject - file no.', named, filed.map((f) => path.basename(f)).slice(0, 3).join(' | '));

  // the folder as the user sees it
  const tree = await ctx.newPage();
  await tree.goto(`file://${DL}/eOffice/`);
  await sleep(800);
  grab('02-downloads-eoffice-folders');
  const biggest = [...gotFolders].sort((a, b) => filed.filter((f) => f.includes(`/${b}/`)).length - filed.filter((f) => f.includes(`/${a}/`)).length)[0];
  await tree.goto(`file://${DL}/eOffice/${encodeURIComponent(biggest)}/`);
  await sleep(800);
  grab('03-one-sender-folder');
  await tree.close();

  // the Letters tab: grouped by sender, what each asks, when the reply is due
  await panel.click('nav button[data-tab=assistant]');
  await panel.click('nav button[data-tab=letters]');
  await panel.waitForSelector('.letter', { timeout: 15000 });
  await sleep(800);
  const cards = await panel.$$eval('.letter', (l) => l.length);
  check('Letters tab lists every filed letter', cards === N, `${cards}`);
  const groups = (await panel.$$('.lt-group')).length, dues = (await panel.$$('.chip2.due, .chip2.late')).length;
  check('grouped by sender with due dates', groups === wantFolders.size && dues > 0, `${groups} groups, ${dues} due chips`);
  await eo.bringToFront();
  grab('04-letters-tab');

  // a meeting notice: say no, diplomatically
  const meetingId = ids.find((id) => truth.find((t) => t.id === id).intent === 'meeting');
  const subj = truth.find((t) => t.id === meetingId).subject;
  await panel.fill('#lt-q', subj.split(' ').slice(0, 4).join(' '));
  await sleep(300);
  await panel.click('.letter');
  await panel.waitForSelector('#lt-detail:not([hidden])');
  const opts = await panel.$$eval('#lt-options button', (b) => b.map((x) => x.textContent));
  check('meeting: options include a polite regret', opts.some((o) => /regret/i.test(o)), opts.join(' | '));
  grab('05-letter-options');
  await panel.click('#lt-options button[data-o=regret]');
  await panel.click('#lt-generate');
  await panel.waitForSelector('#lt-draft:not([hidden])', { timeout: 20000 });
  await sleep(1500);
  const preview = await panel.textContent('#lt-preview');
  check('reply drafted in service format', /Government of India/.test(preview) && /prior official engagements/.test(preview) &&
    /(OFFICE MEMORANDUM|Yours faithfully|Yours sincerely)/.test(preview), preview.slice(0, 200));
  grab('06-reply-regret');
  const docx = walk(DL).filter((f) => f.endsWith('REPLY DRAFT.docx'));
  check('Word reply saved next to the letter', docx.length === 1 && filed.some((f) => path.dirname(f) === path.dirname(docx[0])), docx.join(', '));

  // a reply with the user's own details
  await panel.click('#lt-back');
  const ndId = ids.find((id) => ['nomination', 'deputation_noc', 'info_request'].includes(truth.find((t) => t.id === id).intent));
  const nd = truth.find((t) => t.id === ndId);
  await panel.fill('#lt-q', nd.subject.split(' ').slice(0, 4).join(' '));
  await sleep(300);
  await panel.click('.letter');
  await panel.waitForSelector('#lt-detail:not([hidden])');
  await panel.click('#lt-options button:nth-child(2)');
  const person = (nd.subject.match(/(Shri|Smt\.) [A-Z][a-z]+ [A-Z][a-z]+/) || ['the officer'])[0];
  await panel.fill('#lt-notes', nd.intent === 'nomination' ? 'Shri Anil Verma, Under Secretary' : person);
  await panel.click('#lt-generate');
  await panel.waitForSelector('#lt-draft:not([hidden])', { timeout: 20000 });
  await sleep(1200);
  grab('07-reply-second-option');
  await panel.click('#lt-back');
  await panel.fill('#lt-q', '');

  // everything else: the usual reply for each
  await panel.click('#lt-all');
  await panel.waitForFunction(() => /^Drafted \d+/.test(document.querySelector('#lt-info')?.textContent || ''), null, { timeout: 120000 });
  await sleep(1500);
  const info = await panel.textContent('#lt-info');
  const todo = await panel.textContent('#n-todo');
  check('Draft all: nothing left to reply', todo === '0', `${info} / to reply ${todo}`);
  const drafts = walk(DL).filter((f) => f.endsWith('REPLY DRAFT.docx'));
  check('a Word draft beside each letter that needs a reply', drafts.length >= N - 6, `${drafts.length}`);
  grab('08-draft-all');

  // the loose ones from before: one click files them like the rest (also how Firefox files letters)
  await panel.click('#lt-file');
  await panel.waitForFunction(() => /^(Filed \d+|No new)/.test(document.querySelector('#lt-info')?.textContent || ''), null, { timeout: 60000 });
  await sleep(1500);
  const rootLeft = fs.readdirSync(DL).filter((f) => f.endsWith('.pdf'));
  const nowFiled = walk(`${DL}/eOffice`).filter((f) => f.endsWith('.pdf')).length;
  check('File my downloads: loose letters moved into sender folders', rootLeft.length === 0 && nowFiled === N + 3,
    `${await panel.textContent('#lt-info')} / left ${rootLeft.join(', ')} / filed ${nowFiled}`);
  check('… and listed to reply', (await panel.textContent('#n-todo')) === '3', await panel.textContent('#n-todo'));
  grab('09-file-my-downloads');

  // one draft as it prints (Word file converted to PDF for the picture)
  const pick = docx[0];
  execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', '/tmp/claude-0/letters-pdf', pick], { stdio: 'ignore' });
  const pdf = `/tmp/claude-0/letters-pdf/${path.basename(pick).replace(/\.docx$/, '.pdf')}`;
  const view = await ctx.newPage();
  await view.goto(`file://${pdf}`);
  await sleep(2500);
  grab('10-reply-as-printed');
  const letter = filed.find((f) => path.dirname(f) === path.dirname(pick));
  await view.goto(`file://${letter}`);
  await sleep(2500);
  grab('11-the-letter-received');
  await view.close();
  fs.writeFileSync(`${OUT}/tree.txt`, walk(`${DL}/eOffice`).map((f) => path.relative(DL, f)).sort().join('\n') + '\n');
  console.log(`${checks.filter(Boolean).length}/${checks.length} checks passed; shots in ${OUT}`);
} finally {
  await browser.close().catch(() => {});
  chrome.kill();
}
