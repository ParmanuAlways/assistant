// Probe the page reader on the Legacy ERP without a model: snapshot each page and try the high-level actions.
// Usage: xvfb-run -a node probe.mjs
import { chromium } from 'playwright';
const ROOT = '/home/user/browser-agent';
const EXT = `${ROOT}/extension/.output/chrome-mv3`;
const L = 'http://legacy.office.local:8500';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await fetch(`${L}/debug/reset`, { method: 'POST' });
const ctx = await chromium.launchPersistentContext('/tmp/claude-0/probe-profile', {
  headless: false, executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1100, height: 900 },
});
const dialogs = [];
ctx.on('page', (p) => p.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); }));
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const page = await ctx.newPage();
const extId = sw.url().split('/')[2];
const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await page.bringToFront();
const snap = () => panel.evaluate(async () => {
  const d = window.__officeAssistantDebug; const t = await d.targetTab(); const s = await d.snapshot(t.id); window.__last = s; return s;
});
const act = (a) => panel.evaluate(async (a) => {
  const d = window.__officeAssistantDebug; const t = await d.targetTab(); return d.act(t.id, window.__last, a);
}, a);
const find = (s, pred) => s.elements.find(pred);
const show = (s) => console.log(s.url, '|', s.title, '| frames', JSON.stringify(s.frames), '\n',
  s.elements.map((e) => `[${e.id}] ${e.tag}${e.type ? ' ' + e.type : ''} ${e.label || ''} "${e.text || ''}"${e.value !== undefined ? ` value="${e.value}"` : ''}${e.menu ? ` menu=${e.menu}` : ''}${e.row ? ` row="${e.row.slice(0, 40)}"` : ''}${e.readonly ? ' readonly' : ''}${e.frame ? ' frame=' + e.frame : ''}`).join('\n '),
  '\n notices', JSON.stringify(s.notices), 'errors', JSON.stringify(s.errors));

await page.goto(`${L}/`);
await page.fill('#login_user', 'ravi'); await page.fill('#login_pass', 'ravi123'); await page.click('#login_btn');
await page.waitForLoadState(); await sleep(800);
let s = await snap(); show(s);
const travel = find(s, (e) => e.text === 'Travel Request');
console.log('click travel', await act({ action: 'click', id: travel.id })); await sleep(1000);
s = await snap(); show(s);
console.log(await act({ action: 'type', id: find(s, (e) => e.label === 'Destination city').id, value: 'Pune' }));
console.log(await act({ action: 'pick_date', id: find(s, (e) => e.label === 'From date').id, value: '2026-10-21' }));
console.log(await act({ action: 'pick_date', id: find(s, (e) => e.label === 'To date').id, value: '2026-12-02' }));
console.log(await act({ action: 'select', id: find(s, (e) => e.label === 'Purpose').id, value: 'Client visit' }));
s = await snap();
const submit = find(s, (e) => e.text === 'Submit');
console.log('submit unapproved', await act({ action: 'click', id: submit.id })); await sleep(800);
s = await snap();
console.log('submit approved', await act({ action: 'click', id: find(s, (e) => e.text === 'Submit').id, approved: true })); await sleep(1500);
s = await snap(); show(s);
// purchase: autocomplete + popup + mask
s = await snap();
await act({ action: 'click', id: find(s, (e) => e.text === 'Purchase Request').id }); await sleep(1000);
s = await snap(); show(s);
console.log(await act({ action: 'type', id: find(s, (e) => e.label === 'Unit price (INR)').id, value: '8500' }));
console.log(await act({ action: 'autocomplete', id: find(s, (e) => e.label === 'Approver').id, value: 'Priya Sharma' }));
console.log('submit w/o cc', await act({ action: 'click', id: find(s, (e) => e.text === 'Create Request').id })); await sleep(800);
s = await snap(); console.log('notices', s.notices);
console.log(await act({ action: 'click', id: find(s, (e) => e.text === 'Lookup...').id })); await sleep(1500);
console.log('pages', ctx.pages().map((p) => p.url()));
s = await snap(); show(s);
console.log(await act({ action: 'click', id: find(s, (e) => e.text === 'Engineering - Bangalore').id })); await sleep(1000);
s = await snap(); show(s);
console.log(await act({ action: 'type', id: find(s, (e) => e.label === 'Item description').id, value: 'Ergonomic chair' }));
console.log(await act({ action: 'type', id: find(s, (e) => e.label === 'Quantity').id, value: '2' }));
console.log('create approved', await act({ action: 'click', id: find(s, (e) => e.text === 'Create Request').id, approved: true })); await sleep(1500);
s = await snap(); console.log(s.text.slice(-200));
// approvals: shadow dom + rows
s = await snap();
await act({ action: 'click', id: find(s, (e) => e.text === 'Purchase Orders').id }); await sleep(1000);
s = await snap(); show(s);
await act({ action: 'click', id: find(s, (e) => e.text === '3').id }); await sleep(1000);
s = await snap();
const ap = find(s, (e) => e.text === 'Approve' && e.row.startsWith('PO-1077'));
console.log('approve 1077', await act({ action: 'click', id: ap.id, approved: true })); await sleep(1200);
s = await snap(); console.log(s.text.slice(-300));
await act({ action: 'click', id: find(s, (e) => e.text === 'Upload Timesheet').id }); await sleep(1000);
s = await snap(); show(s);
const fs = await import('node:fs');
const data = fs.readFileSync(`${ROOT}/tests/fixtures/timesheet-sep-2026.pdf`).toString('base64');
console.log(await act({ action: 'select', id: find(s, (e) => e.label === 'Month').id, value: 'September 2026' }));
console.log(await act({ action: 'upload', id: find(s, (e) => e.type === 'file').id, file: { name: 'timesheet-sep-2026.pdf', type: 'application/pdf', data } }));
console.log(await act({ action: 'click', id: find(s, (e) => e.text === 'Upload').id })); await sleep(1500);
s = await snap(); console.log(s.notices, s.text.slice(-120));
console.log('native dialogs that reached the browser:', dialogs);
await ctx.close();
