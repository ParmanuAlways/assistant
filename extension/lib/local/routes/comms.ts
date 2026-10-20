// Communications: items read from office apps as the user, searched in plain words.
import { logEvent } from '../audit';
import * as comms from '../comms';
import { today } from '../identity';
import { route } from '../router';

route('POST', '/api/comms/sync', async ({ user, body }) => {
  const source = String(body.source || '').slice(0, 100);
  const n = await comms.sync(user.emp_id, source, (body.items || []).slice(0, 5000), user.emp_id);
  await logEvent(user.emp_id, 'comms_synced', { source: body.source, items: n });
  return { synced: n };
});

route('GET', '/api/comms/search', async ({ user, query }) =>
  comms.search(user.emp_id, query.get('q') || '', query.get('folder') || '', query.get('direction') || '', await today()));
