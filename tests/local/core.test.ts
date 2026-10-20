// Core and communications, answered in the browser: profile, apps, home screen, history, audit trail, comms search.
import { signIn } from './browser-shim';
import { check, summary } from './check';
import { api } from '../../extension/lib/api';
import * as comms from '../../extension/lib/local/comms';
import * as store from '../../extension/lib/local/store';

const T = new Date(2026, 9, 19);   // 19 Oct 2026
const status = async (p: Promise<any>) => { try { await p; return 200; } catch (e: any) { return e.status; } };

// ---- comms (the same checks the Python backend had)
const q = comms.parseQuery('letters I sent to Priya about leave last month', T);
check('comms: query parsed into filters', q.direction === 'sent' && q.type === 'Letter' && q.to === 'priya' && q.terms.join() === 'leave'
  && q.after === '2026-09-01' && q.before === '2026-09-30', q);
check('comms: folders', comms.folderFor({ type: 'Circular', subject: 'x' }) === 'Circulars'
  && comms.folderFor({ type: 'Note', subject: 'Purchase of chairs PR-1234' }) === 'Purchase & Finance');
await comms.sync('E1', 'App', [
  { id: 1, box: 'out', type: 'Letter', date: '2026-09-10', from: 'Ravi', to: 'Priya Sharma', subject: 'Leave on 12 Sep', body: 'Requesting casual leave.' },
  { id: 2, box: 'in', type: 'Circular', date: '2026-09-11', from: 'HR Department', to: 'All staff', subject: 'Holiday list', body: 'List of holidays for 2027.' },
  { id: 3, box: 'out', type: 'Note', date: '2026-08-01', from: 'Ravi', to: 'Travel Desk', subject: 'Travel request to Pune', body: 'Travel to Pune for a client visit.' }]);
let r = await comms.search('E1', 'letters I sent to Priya about leave', '', '', T);
check('comms: finds the sent letter, highlighted', r.results.map((x) => x.ext_id).join() === '1' && r.results[0].snip.includes('<mark>'), r.results);
r = await comms.search('E1', 'travel to Pune', '', '', T);
check('comms: a place name is a search word, not a recipient', r.results.map((x) => x.ext_id).join() === '3', r.query);
r = await comms.search('E1', 'holidays in March', '', '', T);
check('comms: nothing in that period -> other dates, said so', r.relaxed === 'dates' && r.results.map((x) => x.ext_id).join() === '2', r);
check('comms: counts per box', r.sent === 2 && r.received === 1);
await comms.sync('E1', 'App', [{ id: 1, box: 'out', type: 'Letter', date: '2026-09-10', from: 'Ravi', to: 'Priya Sharma', subject: 'Leave on 12 Sep (revised)', body: 'x' }]);
check('comms: syncing again updates, no duplicates', (await store.all('comms', 'emp_id', 'E1')).length === 3);

// the realistic set (as the Legacy ERP serves it): names, CC ranking, soft "letters", folders
const items = [
  { id: 10, box: 'out', type: 'Note', date: '2026-10-01', from: 'Ravi Kumar', to: 'Priya Sharma', cc: '', subject: 'Leave application for 05 Oct 2026', body: 'Requesting casual leave on 05 Oct 2026 for a family function.' },
  { id: 11, box: 'out', type: 'Letter', date: '2026-09-20', from: 'Ravi Kumar', to: 'Finance Department', cc: 'Priya Sharma', subject: 'Leave encashment', body: 'Request for leave encashment.' },
  { id: 12, box: 'out', type: 'Note', date: '2026-09-21', from: 'Ravi Kumar', to: 'Priyanka Rao', cc: '', subject: 'Leave plan', body: 'My leave plan for December.' },
  { id: 13, box: 'in', type: 'E-mail', date: '2026-10-02', from: 'IT Service Desk', to: 'Ravi Kumar', cc: '', subject: 'Laptop replacement request LT-4411', body: 'Your laptop LT-4411 will be replaced.' },
  { id: 14, box: 'in', type: 'Letter', date: '2026-10-03', from: 'Purchase Section', to: 'Ravi Kumar', cc: '', subject: 'Approval of purchase order PO-7781', body: 'Purchase order PO-7781 for INR 9,000 from Acme Supplies has been approved.' },
];
await comms.sync('E2', 'Legacy ERP', items);
r = await comms.search('E2', 'leave I sent to Priya', '', '', T);
check('comms: "Priya" is not "Priyanka"', !r.results.some((x) => x.recipients.includes('Priyanka')), r.results.map((x) => x.recipients));
check('comms: sent to her directly ranks above copied to her', r.results[0]?.ext_id === '10' && r.results.some((x) => x.ext_id === '11'),
  r.results.map((x) => x.ext_id));
r = await comms.search('E2', 'what did I send to Priya', '', '', T);
check('comms: "send" means sent', r.query.direction === 'sent' && r.results.length === 2);
r = await comms.search('E2', 'letters about leave', '', '', T);
check('comms: "letters" is soft: letters first, notes too', r.results[0]?.type === 'Letter' && r.results.length === 3, r.results.map((x) => x.type));
r = await comms.search('E2', 'PO-7781', '', '', T);
check('comms: a reference number is found whole', r.results.map((x) => x.ext_id).join() === '14');
r = await comms.search('E2', '', 'IT', '', T);
check('comms: folder filter', r.results.map((x) => x.ext_id).join() === '13' && r.folders.IT === 1 && r.folders['Leave & HR'] === 3, r.folders);
r = await comms.search('E2', '', '', 'received', T);
check('comms: received box', r.results.length === 2 && r.received === 2 && r.sent === 3);
r = await comms.search('E2', 'laptops', '', '', T);
check('comms: plural finds singular (stemming)', r.results.map((x) => x.ext_id).join() === '13');
r = await comms.search('E2', 'leave nonexistentword', '', '', T);
check('comms: no result with all words -> any word', r.match === 'any word' && r.results.length === 3);
check('comms: chat search detection', comms.looksLikeSearch('Find the circular about the holiday list') && !comms.looksLikeSearch('Apply leave for Monday'));

// ---- through the local API, as the panel calls it
signIn({ preferred_username: 'ravi', name: 'Ravi Kumar', emp_id: 'EMP1042', email: 'ravi@office.local', department: 'Engineering',
  realm_access: { roles: ['employee'] } });
const me = await api('/api/me');
check('me: from the sign-in token', me.emp_id === 'EMP1042' && me.name === 'Ravi Kumar' && me.roles.includes('employee'));
let prof = await api('/api/profile');
check('profile: directory details copied in', prof.some((p: any) => p.field === 'department' && p.value === 'Engineering' && p.source === 'directory'));
prof = await api('/api/profile', 'PUT', { 'Desk Number': 'B3-114', department: 'Finance' });
check('profile: user edits saved (field names cleaned)', prof.some((p: any) => p.field === 'desk_number' && p.source === 'user')
  && prof.find((p: any) => p.field === 'department').value === 'Finance');
await api('/api/profile/desk_number', 'DELETE');
check('profile: field deleted', !(await api('/api/profile')).some((p: any) => p.field === 'desk_number'));
const sync = await api('/api/comms/sync', 'POST', { source: 'Legacy ERP', items });
const found = await api('/api/comms/search?q=' + encodeURIComponent('purchase order'));
check('comms API: sync and search', sync.synced === 5 && found.results[0]?.ext_id === '14');

const l1 = await api('/api/links', 'POST', { title: 'HR portal', url: 'http://hr.office.local:8200/' });
const l2 = await api('/api/links', 'POST', { title: '', url: 'https://example.com/x' });
check('links: added; assistant may use office sites only', l1.assistant_can_use && !l2.assistant_can_use && l2.title === 'example.com');
check('links: bad address refused', await status(api('/api/links', 'POST', { title: 'x', url: 'hr portal' })) === 400);
await api(`/api/links/${l2.id}`, 'DELETE');
check('links: listed, deleted', (await api('/api/links')).map((x: any) => x.title).join() === 'HR portal');

const task = (id: string, prompt: string, status: string, day: number, emp = 'EMP1042') =>
  store.put('tasks', { task_id: id, emp_id: emp, user_name: 'x', prompt, site: 'hr.office.local', status, summary: '', steps: 1,
    started_at: `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z` });
await task('t1', 'Apply casual leave for 3 days from Monday', 'completed', 1);
await task('t2', 'Raise an IT ticket: laptop flickering', 'failed', 2);
await task('t3', 'Apply casual leave for 2 days from Thursday', 'completed', 3);
await task('t4', 'Apply casual leave on Friday', 'completed', 4);
await task('t9', 'Someone else', 'completed', 5, 'EMP2000');
const home = await api('/api/home');
check('home: frequent groups similar requests', home.frequent[0].count === 3 && home.frequent[0].done === 3, home.frequent);
check('home: recent newest first, links', home.recent[0].task_id === 't4' && home.recent.length === 4 && home.links.length === 1);
const hist = await api('/api/history');
check('history: own tasks only, newest first', hist.length === 4 && hist[0].task_id === 't4');
check('history: filters', (await api('/api/history?status=failed')).length === 1 && (await api('/api/history?all=1')).length === 4);
check("history: someone else's task is not found", await status(api('/api/history/t9')) === 404);
check('history: own task with its events', (await api('/api/history/t1')).task.prompt.startsWith('Apply'));
check('audit: auditor only', await status(api('/api/audit/verify')) === 403 && await status(api('/api/audit/log')) === 403);
check('admin policy: admins only', await status(api('/api/admin/policy')) === 403);

signIn({ preferred_username: 'meera', name: 'Meera Iyer', emp_id: 'EMP2000', realm_access: { roles: ['employee', 'auditor', 'admin'] } });
check('history: auditor sees everyone with all=1', (await api('/api/history?all=1')).length === 5
  && (await api('/api/history?all=1&emp_id=EMP2000')).length === 1 && (await api('/api/history')).length === 1);
check("history: auditor opens anyone's task", (await api('/api/history/t1')).task.emp_id === 'EMP1042');
const v = await api('/api/audit/verify');
check('audit: chain verified', v.ok && v.checked > 3, v);
const log = await api('/api/audit/log');
check('audit: account activity newest first', log[0].event_type === 'audit_verified' && log.some((e: any) => e.event_type === 'profile_updated'));
const exp = await api('/api/audit/export');
check('audit: export has every event and the check', exp.events.length > 5 && exp.verify.ok && exp.tasks.length === 5);
const pol = await api('/api/admin/policy');
check('admin policy: read from browser policy', pol.allowed_sites.includes('*.office.local') && pol.max_steps === 40 && pol.allow_custom_endpoints === false);
check('admin policy: cannot be changed here', await status(api('/api/admin/policy', 'PUT', { allow_custom_endpoints: true })) === 403);
summary();
