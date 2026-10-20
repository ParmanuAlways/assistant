// The assistant's brain, running as it does in the browser (no backend): checks of the verifier, provenance,
// workflows and the step loop against a tiny fake OpenAI-compatible model server.
// Run: tests/local/run.sh tests/local/agent.test.ts
import http from 'node:http';
import { setDevConfig, signIn } from './browser-shim';
import { check, summary } from './check';
import * as agent from '../../extension/lib/local/agent';
import * as skills from '../../extension/lib/local/skills';
import { callModel } from '../../extension/lib/local/model';
import { taskEvents, verifyChain } from '../../extension/lib/local/audit';
import { hostAllowed } from '../../extension/lib/local/routes/tasks';
import * as store from '../../extension/lib/local/store';
import { api } from '../../extension/lib/api';

const T = new Date(2026, 9, 19, 12);
const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (s: Set<string>) => [...s].sort();

// ---- dates and numbers in requests
check("dates: '21 Oct 2026 to 23 Oct 2026'", eq(sorted(agent.parseDates('from 21 Oct 2026 to 23 Oct 2026', T)), ['2026-10-21', '2026-10-23']));
check('dates: field formats', eq(sorted(agent.parseDates('21-Oct-2026', T)), ['2026-10-21']) && eq(sorted(agent.parseDates('21/10/2026', T)), ['2026-10-21']));
check('dates: no year means this year', eq(sorted(agent.parseDates('on 2 Nov', T)), ['2026-11-02']));
check('dates: impossible dates ignored', agent.parseDates('31/02/2026', T).size === 0);
check('numbers: amounts/IDs/phones, not dates', eq(agent.goalNumbers('2 chairs at 8,500 each, PO-1077, 9123400000, on 21 Oct 2026', T),
  ['8,500', '1077', '9123400000']));
check('calendar: spelled-out days from today', agent.calendar(T, 3) ===
  "CALENDAR (a weekday name like 'Monday' means the NEXT one after today):\nMon 2026-10-19 (today), Tue 2026-10-20 (tomorrow), Wed 2026-10-21");

// ---- verifier
let fields: any[] = [{ label: 'Destination', value: 'Pune' }, { label: 'From', value: '21-Oct-2026' }, { label: 'To', value: '22-Oct-2026' }];
let c = agent.verifySubmission('travel to Pune from 21 Oct 2026 to 23 Oct 2026', fields, T);
check("verifier: wrong 'to' date flagged", c.some((x) => x.includes('23 Oct 2026')), c);
check('verifier: masked phone accepted', agent.verifySubmission('change mobile to 9123400000', [{ label: 'Mobile', value: '91234-00000' }], T).length === 0);
check('verifier: 1250 vs 1250.00 accepted', agent.verifySubmission('claim 1250 rupees', [{ label: 'Amount', value: '1250.00' }], T).length === 0);
c = agent.verifySubmission('approve PO-1077', [{ label: 'Page says', value: '...' }], T, 'PO-1070 Acme 1,000 Pending');
check('verifier: wrong table row flagged', c.some((x) => x.includes('1077')), c);
check('verifier: right table row ok', agent.verifySubmission('approve PO-1077', [{ label: 'Page says', value: '.' }], T, 'PO-1077 Initech 82,287 Pending').length === 0);
check('verifier: a date shown on the page (not a field) is fine',
  agent.verifySubmission('book a room on 21 Oct 2026', [{ label: 'Meeting title', value: 'Sprint' }], T, '', 'Tulip · Wed 21 Oct 2026, 15:00-16:00 · 6 people').length === 0);

// ---- provenance
let p = agent.provenance([{ label: 'Destination', value: 'Pune' }, { label: 'Phone', value: '9876500011' },
  { label: 'Purpose', value: 'Training' }, { label: 'Desk', value: 'B3-114' }, { label: 'Country', value: 'India' }],
'travel to Pune for a client visit', { phone: '9876500011' }, ['B3-114'], ['Pune', 'Training'], T);
const src = Object.fromEntries(p.map((f) => [f.label, [f.source ?? null, !!f.guess]]));
check('provenance: request / profile / answer / page / guess', eq(src, { Destination: ['from your request', false], Phone: ['from your profile (phone)', false],
  Purpose: ['chosen by the assistant', true], Desk: ['you told me', false], Country: ['already on the page', false] }), src);
p = agent.provenance([{ label: 'Emergency Contact Number', value: '9876500011' }, { label: 'Mobile', value: '9876500011' }],
  'apply casual leave', { phone: '9876500011' }, [], ['9876500011'], T);
c = agent.verifySubmission('apply casual leave', p, T);
check('verifier: own phone used as emergency contact is flagged, as mobile it is fine', c.length === 1 && c[0].includes('Emergency Contact Number'), c);
p = agent.provenance([{ label: 'Desk number', value: 'my desk' }], 'deliver to my desk', {}, [], ['my desk'], T);
c = agent.verifySubmission('deliver to my desk', p, T);
check("verifier: 'my desk' typed as a desk number is flagged", !!p[0].guess && c.some((x) => x.includes(' but ')), [p, c]);

// ---- confirmation: postback links are buttons, rows are shown
let page: any = { elements: [{ id: 1, tag: 'a', text: 'Submit', href: "javascript:__doPostBack('btnSubmit','')", frame: 'main' },
  { id: 2, tag: 'input', label: 'Destination', value: 'Pune', frame: 'main' },
  { id: 3, tag: 'a', text: 'Travel Request', href: 'http://x/travel', frame: 'nav' },
  { id: 4, tag: 'button', type: 'submit', text: 'Approve', row: 'PO-1077 Initech 82,287', frame: 'main' }], text: '' };
let conf = agent.needsConfirmation({ action: 'click', id: 1 }, page);
check('confirm: javascript: postback link needs confirmation, fields from its frame', conf && eq(conf.fields, [{ label: 'Destination', value: 'Pune' }]), conf);
check('confirm: plain menu link does not', agent.needsConfirmation({ action: 'click', id: 3 }, page) === null);
conf = agent.needsConfirmation({ action: 'click', id: 4 }, page);
check('confirm: row shown for a row button', conf && eq(conf.fields[0], { label: 'Row', value: 'PO-1077 Initech 82,287' }), conf);

// ---- wrong row -> right row, or next page
const pg: any = { elements: [{ id: 1, tag: 'button', text: 'Approve', row: 'PO-1057 Initech 67,667 Pending', frame: 'main' },
  { id: 2, tag: 'button', text: 'Approve', row: 'PO-1058 Umbrella 68,398 Pending', frame: 'main' }, { id: 3, tag: 'a', text: 'Next »', frame: 'main' }] };
let f = agent.rowFix({ action: 'click', id: 1 }, pg, 'approve purchase order PO-1077', T);
check('row fix: target row not on this page -> next page', f && f.id === 3, f);
pg.elements.push({ id: 4, tag: 'button', text: 'Approve', row: 'PO-1077 Initech 82,287 Pending', frame: 'main' });
f = agent.rowFix({ action: 'click', id: 1 }, pg, 'approve purchase order PO-1077', T);
check('row fix: same button in the matching row', f && f.id === 4, f);
check('row fix: right row left alone', agent.rowFix({ action: 'click', id: 4 }, pg, 'approve purchase order PO-1077', T) === null);

// ---- parser
let a = agent.parseAction('{"action":"fill_form","fields":{"12":"Pune","13":"Training"}}');
check('parser: fill_form dict form', eq(a.fields, [{ id: 12, value: 'Pune' }, { id: 13, value: 'Training' }]), a);
check('parser: new actions', ['pick_date', 'autocomplete', 'hover', 'upload'].every((x) => agent.parseAction(JSON.stringify({ action: x, id: 1, value: '2026-10-21' })).action === x));
a = agent.parseAction('<think>hmm</think>```json\n{"action": {"action": "click", "element_id": "[7]"}, "thought": "t"} trailing {x}');
check('parser: thinking, fences, nested action, element_id, trailing chatter', a.action === 'click' && a.id === 7 && a.thought === 't', a);
let threw = false;
try { agent.parseAction('{"action":"dance"}'); } catch { threw = true; }
check('parser: unknown action rejected', threw);
check('text added: word diff', agent.textAdded('Pick a seat', 'Pick a seat Selected seat: C3') === 'Pick a seat Selected seat: C3', agent.textAdded('Pick a seat', 'Pick a seat Selected seat: C3'));
check('success: only new text counts', !agent.pageShowsSuccess({ text: 'Save sent message in' }, 'Save sent message in')
  && agent.pageShowsSuccess({ text: 'Compose\nMessage sent.' }, 'Compose'));
check('parse box: Gemma box_2d', eq(agent.parseBox('{"box_2d": [100, 200, 300, 400]}'), [0.3, 0.2]));
check('host rules: wildcard and CIDR (IP only)', hostAllowed('http://llm.office.local:9100/v1', ['*.office.local'])
  && hostAllowed('http://10.1.2.3/v1', ['10.0.0.0/8']) && !hostAllowed('http://evil.com/v1', ['*.office.local', '10.0.0.0/8']));

// ---- workflows from a recording
const events = [{ kind: 'navigate', url: 'http://legacy.office.local:8500/' },
  { kind: 'fill', label: 'User name', value: 'ravi', url: 'http://legacy/login' },
  { kind: 'fill', label: 'Password', value: '(hidden)', url: 'http://legacy/login' },
  { kind: 'click', tag: 'a', text: 'Travel Request', menu: 'Requests' },
  { kind: 'fill', label: 'Destination city', value: 'Pune' },
  { kind: 'click', tag: 'img', text: 'Pick from date' },
  { kind: 'click', tag: 'td', text: '21' },
  { kind: 'date', label: 'From date', value: '21-Oct-2026', readonly: true },
  { kind: 'click', tag: 'td', text: '23' },
  { kind: 'choose', label: 'Purpose', value: 'Client visit' },
  { kind: 'click', tag: 'a', text: 'Submit' }];
const m = skills.macroFromTeach(events);
const acts = m.map((s) => [s.action, s.text || s.label || null, !!s.param]);
check('workflow: recording -> fixed and value steps (sign-in left out, calendar clicks folded into pick_date)', eq(acts, [
  ['navigate', null, false], ['click', 'Travel Request', false], ['type', 'Destination city', true],
  ['pick_date', 'From date', true], ['select', 'Purpose', true], ['click', 'Submit', false]]), acts);
const state: any = { steps: m, cursor: 0, label: "taught workflow 'travel'" };
const pg2 = { elements: [{ id: 5, tag: 'a', text: 'Travel Request', menu: 'Requests' }] };
let [act, hint] = skills.suggest(state, pg2, 'intranet.office.local');
check('workflow: opens the site first', act && act.action === 'navigate', act);
[act, hint] = skills.suggest(state, pg2, 'legacy.office.local');
check('workflow: replays the menu click without the model', act && act.action === 'click' && act.id === 5, act);
skills.advance(state, act, pg2.elements[0]);
[act, hint] = skills.suggest(state, { elements: [{ id: 7, tag: 'input', label: 'Destination city' }] }, 'legacy.office.local');
check('workflow: value steps go to the model with a hint', act === null && (hint || '').includes("→ type 'Destination city'"), hint);
check('learned workflow: a suggestion / lookup entry from the request is a value step',
  skills.isParamClick('Priya Sharma (Engineering)', null, new Set(['priya sharma']), '', { tag: 'div', type: 'clickable' })
  && skills.isParamClick('Engineering - Bangalore', null, new Set(), 'cost centre Engineering - Bangalore', { tag: 'a', href: 'http://x/lookup#' }));
check('learned workflow: a site/menu link named in the request stays a fixed step',
  !skills.isParamClick('Legacy ERP', null, new Set(), 'In the Legacy ERP, ...', { tag: 'a', href: 'http://legacy/' })
  && !skills.isParamClick('Purchase Request', null, new Set(), 'create a purchase request', { tag: 'a', menu: 'Requests', href: 'http://x/p' }));
const st2: any = { steps: [{ action: 'type', label: 'User name', param: true }, { action: 'click', text: 'Travel Request', menu: 'Requests', param: false }], cursor: 0, label: 't' };
[act] = skills.suggest(st2, { elements: [{ id: 3, tag: 'a', text: 'Travel Request', menu: 'Requests' }] }, 'legacy.office.local');
check('workflow: a step whose field is not on the page is skipped', act && act.id === 3, act);
const st3: any = { steps: [{ action: 'click', text: 'Travel Request', menu: 'Requests', param: false }], cursor: 0, label: 't' };
skills.advance(st3, { action: 'click', id: 3 }, { tag: 'input', type: 'submit', text: 'Sign in', label: null });
check('workflow: an unrelated click (Sign in) does not skip a step', st3.cursor === 0, st3);
const st4: any = { steps: [{ action: 'pick_date', label: 'To date', param: true }, { action: 'click', text: 'Submit', param: false }], cursor: 0, label: 't' };
skills.advance(st4, { action: 'pick_date', id: 9 }, { tag: 'img', type: 'clickable', text: 'Pick to date' });
check('workflow: a field reached through its icon counts as done', st4.cursor === 1, st4);
check('workflow: similarity', skills.similarity('raise a travel request to Mumbai for training', 'raise a travel request to Pune for a client visit') >= 0.6);

// a colleague's e-mail from the directory is not the user's own detail
const pv = agent.provenance([{ label: 'To', value: 'priya@office.local,' }], 'Email Priya that I am on leave',
  { email: 'ravi@office.local', colleagues_from_company_directory: [{ name: 'Priya Sharma', email: 'priya@office.local' }] }, [], ['priya@office.local'], T);
check('provenance: a colleague from the directory is labelled so, and not flagged', pv[0].source === 'from the company directory' && !pv[0]._profile_key, pv);
check('verifier: no "your profile" warning for a colleague\'s address',
  !agent.verifySubmission('Email Priya that I am on leave', pv, T).some((x: string) => /your .* from your profile/.test(x)));

// an address nobody gave: flagged for the person to check
const pgu = agent.provenance([{ label: 'To', value: 'accounts <team@office.local>,' }], 'Forward the Acme Supplies invoice email to the accounts team.',
  { email: 'ravi@office.local', colleagues_from_company_directory: [{ name: 'Accounts Team', email: 'accounts@office.local' }] }, [], [], T);
check('provenance: a made-up address is flagged', pgu[0].guess === true && /could not find/.test(pgu[0].source), pgu);
const pk = agent.provenance([{ label: 'To', value: 'accounts@office.local' }], 'Forward the invoice to the accounts team.',
  { colleagues_from_company_directory: [{ name: 'Accounts Team', email: 'accounts@office.local' }] }, [], [], T);
check('provenance: the directory address is not flagged', !pk[0].guess, pk);

// ---- a fake OpenAI-compatible model server
const seen: any[] = [];
let queue: any[] = [];
const srv = http.createServer((req, res) => {
  let data = '';
  req.on('data', (d) => (data += d));
  req.on('end', () => {
    const body = JSON.parse(data);
    seen.push(body);
    const sys = body.messages[0]?.content;
    let content: string;
    if (typeof sys === 'string' && sys.startsWith('You plan')) content = JSON.stringify({ steps: ['Open the form', 'Submit it'] });
    else if (typeof sys === 'string' && sys.startsWith('You turn a recorded')) content = JSON.stringify({ start_url: 'http://legacy.office.local:8500/',
      steps: ['1. Open Requests > Travel Request', 'Type <destination from the request>', 'Click Submit'] });
    else if (body.messages.some((x: any) => Array.isArray(x.content))) content = '{"action":"click_xy","x":10,"y":20,"thought":"t"}';
    else content = JSON.stringify(queue.shift() ?? { action: 'fail', summary: 'nothing queued' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
  });
});
await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
const URL_ = `http://127.0.0.1:${(srv.address() as any).port}/v1`;

// ---- vision: the screenshot reaches an OpenAI-compatible server as image_url
const msgs = agent.buildMessages('click the chart', {}, [], [], { url: 'http://x', elements: [] }, T, true, 8192, [], 'iVBORw0KGgo=');
const reply = await callModel({ url: URL_, model: 'm' }, msgs);
const user = seen[seen.length - 1].messages[1].content;
check('vision: image sent as image_url data URI', Array.isArray(user) && user[1].image_url.url.startsWith('data:image/png;base64,'));
check('vision: click_xy parsed', eq(agent.parseAction(reply), { action: 'click_xy', x: 10, y: 20, thought: 't' }), reply);
check('model: JSON schema sent for actions', seen[seen.length - 1].response_format?.type === 'json_schema');

// ---- the step loop, as the side panel drives it
signIn({ preferred_username: 'ravi', name: 'Ravi Kumar', emp_id: 'EMP1042', realm_access: { roles: ['user'] }, phone: '9876500011' });
setDevConfig({ models: [{ id: 1, name: 'Fake', url: URL_, model: 'fake', default: true }], agent: { today: '2026-10-19' } });
const form = { url: 'http://hr.office.local:8200/leave', title: 'Apply Leave', text: 'Apply Leave',
  elements: [{ id: 1, tag: 'input', type: 'text', label: 'Reason', value: 'family function', required: true },
    { id: 2, tag: 'button', type: 'submit', text: 'Submit' }] };
const { task_id: t1 } = await api('/api/tasks', 'POST', { prompt: 'Apply casual leave, reason: family function', url: form.url });
queue = [{ action: 'click', id: 2, thought: 'Submit the form' }];
let r = await api(`/api/tasks/${t1}/step`, 'POST', { page: form });
check('step: a submit click needs the user\'s OK, with the form values and their sources', r.needs_confirmation && r.confirmation.button === 'Submit'
  && r.confirmation.fields[0].value === 'family function' && r.confirmation.fields[0].source === 'from your request', r);
const promptSent = seen[seen.length - 1].messages[1].content as string;
check('step: prompt has goal, profile from the sign-in, plan and page', promptSent.includes('GOAL: Apply casual leave') && promptSent.includes('"phone": "9876500011"')
  && promptSent.includes('PLAN (made at the start') && promptSent.includes('[2] button type=submit text="Submit"'), promptSent.slice(0, 400));
await api(`/api/tasks/${t1}/events`, 'POST', { event_type: 'confirmation', payload: { approved: true, button: 'Submit', fields: r.confirmation.fields } });
queue = [{ action: 'done', summary: 'Leave applied, reference LV-0042', thought: 'done' }];
r = await api(`/api/tasks/${t1}/step`, 'POST', { page: { ...form, text: 'Leave request LV-0042 submitted successfully.', elements: [] }, last_result: { ok: true, detail: 'clicked' } });
check('step: done after the site confirms', r.action.action === 'done' && !r.action.unverified, r);
const task = await store.get('tasks', t1);
check('step: task completed and counted', task.status === 'completed' && task.steps === 2, task);
const types = (await taskEvents(t1)).map((e) => e.event_type);
check('audit: every step recorded in order', eq(types.filter((x) => ['user_message', 'plan', 'model_action', 'confirmation', 'action_result', 'task_finished'].includes(x)),
  ['user_message', 'plan', 'model_action', 'confirmation', 'action_result', 'model_action', 'task_finished']), types);
check('audit: chain intact', (await verifyChain()).ok);
check('outcome recorded for playbook health', (await store.get('outcomes', t1))?.status === 'completed');

// the directory: a team named in lower case is found too
const dir = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify([{ name: 'Priya Sharma', email: 'priya@office.local' }, { name: 'Accounts Team', email: 'accounts@office.local' }])); });
await new Promise<void>((ok) => dir.listen(0, '127.0.0.1', ok));
setDevConfig({ models: [{ id: 1, name: 'Fake', url: URL_, model: 'fake', default: true }], agent: { today: '2026-10-19' },
  directoryUrl: `http://127.0.0.1:${(dir.address() as any).port}/directory.json` });
const { directoryLookup } = await import('../../extension/lib/local/routes/tasks');
const people = await directoryLookup('Forward the Acme Supplies invoice email to the accounts team.');
check('directory: "the accounts team" finds Accounts Team', people.some((p: any) => p.email === 'accounts@office.local') && people.length === 1, people);
check('directory: a capitalised name is found', (await directoryLookup('Send an email to Priya about leave')).some((p: any) => p.email === 'priya@office.local'));
setDevConfig({ models: [{ id: 1, name: 'Fake', url: URL_, model: 'fake', default: true }], agent: { today: '2026-10-19' } });
dir.close();

// the model gives up after an approved action went through: reported as "went through, please check", not a failure
const { task_id: t7 } = await api('/api/tasks', 'POST', { prompt: 'Apply casual leave, reason: family function', url: form.url });
queue = [{ action: 'click', id: 2, thought: 'Submit the form' }];
r = await api(`/api/tasks/${t7}/step`, 'POST', { page: form });
await api(`/api/tasks/${t7}/events`, 'POST', { event_type: 'confirmation', payload: { approved: true, button: 'Submit', fields: r.confirmation.fields } });
queue = [{ action: 'fail', summary: 'I am not on the right page', thought: 'lost' }, { action: 'fail', summary: 'I am not on the right page', thought: 'lost' }];
r = await api(`/api/tasks/${t7}/step`, 'POST', { page: { ...form, text: 'Inbox', elements: [{ id: 5, tag: 'a', text: 'Inbox' }] }, last_result: { ok: true, detail: 'clicked' } });
check('after an approved action went through, giving up is reported as "please check"', r.action.action === 'done' && r.action.unverified
  && /went through/.test(r.action.summary) && (await store.get('tasks', t7)).status === 'unverified', r.action);
const body = agent.provenance([{ label: 'Message Body', value: 'From: Acme Billing <billing@acme-supplies.com> Dear customer, invoice INV-7781' }],
  'Forward the invoice to accounts', {}, [], [], T);
check('provenance: addresses inside a message body are not checked as recipients', !body[0].guess, body);

// a site outside the allowed list
const { task_id: t2 } = await api('/api/tasks', 'POST', { prompt: 'Order lunch', url: form.url });
queue = [{ action: 'navigate', url: 'http://evil.example.com/', thought: 'go' }];
r = await api(`/api/tasks/${t2}/step`, 'POST', { page: form });
check('policy: navigating outside the allowed sites is blocked', r.action.action === 'fail' && r.action.summary.startsWith('Blocked by policy'), r.action);

// never type on a sign-in page
const login = { url: 'http://legacy.office.local:8500/login', title: 'Sign in', text: 'Sign in',
  elements: [{ id: 1, tag: 'input', type: 'text', label: 'User name', value: '' }, { id: 2, tag: 'input', type: 'password', label: 'Password', value: 'secret' },
    { id: 3, tag: 'button', type: 'submit', text: 'Sign in' }] };
const { task_id: t3 } = await api('/api/tasks', 'POST', { prompt: 'Raise a travel request', url: login.url });
queue = [{ action: 'type', id: 1, value: 'ravi', thought: 'sign in' }];
r = await api(`/api/tasks/${t3}/step`, 'POST', { page: login });
check('sign-in pages: the assistant asks the person instead of typing', r.action.action === 'ask_user' && r.action.field === 'user_action', r.action);
const snap = (await taskEvents(t3)).find((e) => e.event_type === 'page_snapshot')!;
check('passwords never stored', snap.payload.elements[1].value === '' && !JSON.stringify(seen[seen.length - 1]).includes('secret'));

// an element that is not on the page: the model is asked again
const { task_id: t4 } = await api('/api/tasks', 'POST', { prompt: 'Apply casual leave, reason: family function', url: form.url });
queue = [{ action: 'click', id: 99, thought: 'x' }, { action: 'type', id: 1, value: 'family function', thought: 'fix' }];
r = await api(`/api/tasks/${t4}/step`, 'POST', { page: form });
check('recovery: a missing element number is corrected once', r.action.action === 'type' && r.action.id === 1, r.action);

// a required choice (radio buttons) the model keeps ignoring: the assistant asks, with the choices as buttons, then picks it
const visitor = { url: 'http://visitors.office.local:8300/visitors/new', title: 'Register Visitor', text: 'Register Visitor',
  elements: [{ id: 1, tag: 'input', type: 'text', label: 'Visitor full name', value: 'Anil Gupta', required: true },
    { id: 2, tag: 'input', type: 'radio', label: 'Aadhaar', value: '', required: true, group: 'ID proof the visitor will carry' },
    { id: 3, tag: 'input', type: 'radio', label: 'PAN card', value: '', group: 'ID proof the visitor will carry' },
    { id: 4, tag: 'button', type: 'submit', text: 'Register Visitor' }] };
const { task_id: t5 } = await api('/api/tasks', 'POST', { prompt: 'Register a visitor: Mr. Anil Gupta', url: visitor.url });
queue = [{ action: 'click', id: 4, thought: 'submit' }, { action: 'click', id: 4, thought: 'submit' }];
r = await api(`/api/tasks/${t5}/step`, 'POST', { page: visitor });
check('required radio choice: asked, with the choices', r.action.action === 'ask_user' && /ID proof/.test(r.action.question)
  && eq(r.action.options, ['Aadhaar', 'PAN card']), r.action);
queue = [{ action: 'click', id: 4, thought: 'submit' }, { action: 'click', id: 4, thought: 'submit' }];
r = await api(`/api/tasks/${t5}/step`, 'POST', { page: visitor, last_result: { ok: true }, user_answer: { field: r.action.field, question: r.action.question, answer: 'PAN card' } });
check('required radio choice: the answer is clicked', r.action.action === 'click' && r.action.id === 3, r.action);

// typing into a read-only box that its Lookup button fills: the button is pressed instead
const purchase = { url: 'http://legacy.office.local:8500/purchase', title: 'Purchase Request', text: 'Purchase Request',
  elements: [{ id: 13, tag: 'input', type: 'text', label: 'Cost centre', value: '', readonly: true, required: true },
    { id: 14, tag: 'button', type: 'button', text: 'Lookup...' }, { id: 17, tag: 'button', type: 'submit', text: 'Create Request' }] };
const { task_id: t6 } = await api('/api/tasks', 'POST', { prompt: 'Create a purchase request, cost centre Engineering - Bangalore', url: purchase.url });
queue = [{ action: 'type', id: 13, value: 'Engineering - Bangalore', thought: 'fill' }];
r = await api(`/api/tasks/${t6}/step`, 'POST', { page: purchase });
check('read-only box with a Lookup button: the button is pressed', r.action.action === 'click' && r.action.id === 14, r.action);

// cancelling
await api(`/api/tasks/${t4}/events`, 'POST', { event_type: 'user_cancelled', payload: { reason: 'Stopped by user' } });
check('cancel: task marked cancelled', (await store.get('tasks', t4)).status === 'cancelled');

// settings and models
const models = await api('/api/models');
check('models: listed without keys', models.models.length === 1 && !('key' in models.models[0]) && models.models[0].is_default === 1, models);
let denied = '';
try { await api('/api/settings', 'PUT', { mode: 'custom', custom_url: 'http://llm.office.local:9100/v1', custom_model: 'x' }); } catch (e: any) { denied = String(e.status); }
check('settings: custom endpoints refused unless the admin allows them', denied === '403', denied);
const test = await api('/api/settings/test', 'POST', { mode: 'list', provider_id: 1 });
check('settings: test connection', test.ok === true, test);

// teach mode
queue = [];
const draft = await api('/api/teach/draft', 'POST', { name: 'Travel', site: 'legacy.office.local', events });
check('teach: a playbook is drafted from the recording (no passwords)', draft.steps === 'Start URL: http://legacy.office.local:8500/\n1. Open Requests > Travel Request\n2. Type <destination from the request>\n3. Click Submit' && !draft.recording.includes('(hidden)'), draft);
const pb = await api('/api/playbooks', 'POST', { site: 'legacy.office.local', task: 'Travel request', steps: draft.steps, events });
const list = await api('/api/playbooks');
check('playbooks: taught one active here, id after the shared ones', pb.status === 'active' && pb.id >= 1000 && list.some((x: any) => x.id === pb.id && x.macro), pb);
let notAdmin = '';
try { await api('/api/admin/experiences'); } catch (e: any) { notAdmin = String(e.status); }
check('admin pages need the admin role', notAdmin === '403');

srv.close();
summary();
