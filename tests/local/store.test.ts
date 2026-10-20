import { signIn } from './browser-shim';
import { check, summary } from './check';
import * as store from '../../extension/lib/local/store';
import { logEvent, verifyChain, taskEvents } from '../../extension/lib/local/audit';
import { api } from '../../extension/lib/api';

signIn({ preferred_username: 'ravi', name: 'Ravi Kumar', emp_id: 'EMP1042', realm_access: { roles: ['employee'] } });
await store.put('users', { emp_id: 'x', name: 'X' });
check('store: put/get', (await store.get('users', 'x'))?.name === 'X');
await logEvent('E1', 'a', { n: 1 }, { task_id: 't1' });
await logEvent('E1', 'b', { n: 2 }, { task_id: 't1' });
await logEvent('E1', 'c', { password: 'secret' });
const ev = await taskEvents('t1');
check('audit: task events in order with seq', ev.map((e) => e.seq).join() === '1,2');
check('audit: chain verifies', (await verifyChain()).ok);
await store.tx('events', 'readwrite', async (t) => {   // tamper with an entry
  const s = t.objectStore('events');
  const e = await store.req(s.get(1)) as any;
  e.payload.n = 99;
  await store.req(s.put(e));
});
check('audit: an edited entry breaks the chain', !(await verifyChain()).ok);
let err = '';
try { await api('/api/nothing'); } catch (e: any) { err = String(e.status); }
check('router: unknown route is 404', err === '404');
summary();
