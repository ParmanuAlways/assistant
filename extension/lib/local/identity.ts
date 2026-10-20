// Who is using the assistant: read from the user's Keycloak sign-in (the token the browser already holds).
// Nothing to verify against: the token came straight from Keycloak to this browser, and the data it unlocks is
// this user's own, on this PC.
import { ApiError } from '../errors';
import { getAccessToken } from '../auth';
import { logEvent } from './audit';
import * as store from './store';

export interface User { emp_id: string; username: string; name: string; email: string; roles: string[]; claims: any }

function claimsOf(token: string): any {
  const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(part + '='.repeat((4 - (part.length % 4)) % 4)))));
}

let seen = '';
export async function currentUser(): Promise<User> {
  const token = await getAccessToken();
  if (!token) throw new ApiError(401, 'Not signed in');
  const c = claimsOf(token);
  const u: User = { emp_id: c.emp_id || c.preferred_username, username: c.preferred_username, name: c.name || c.preferred_username,
    email: c.email || '', roles: c.realm_access?.roles || [], claims: c };
  if (seen !== u.emp_id) {   // once per session: remember the user, copy directory details into the profile
    seen = u.emp_id;
    const known = await store.get('users', u.emp_id);
    await store.put('users', { emp_id: u.emp_id, username: u.username, name: u.name, email: u.email, roles: u.roles, last_login: store.now() });
    const dir: Record<string, string> = { name: u.name, employee_id: u.emp_id, email: u.email, department: c.department, manager: c.manager, phone: c.phone };
    for (const [field, value] of Object.entries(dir)) {
      if (!value) continue;
      await store.update('profile', [u.emp_id, field], (r: any) =>
        !r || r.source === 'directory' ? { emp_id: u.emp_id, field, value, source: 'directory', updated_at: store.now() } : undefined);
    }
    if (!known) await logEvent(u.emp_id, 'first_login', { username: u.username, roles: u.roles });
  }
  return u;
}

export function requireRole(u: User, role: string) {
  if (!u.roles.includes(role)) throw new ApiError(403, `Requires role '${role}'`);
}

export async function getProfile(emp_id: string): Promise<Record<string, any>> {
  return Object.fromEntries((await store.all('profile', 'emp_id', emp_id)).map((r: any) => [r.field, r.value]));
}

export const today = async () => {
  const { getConfig } = await import('../config');
  const t = (await getConfig()).agent.today;
  return t ? new Date(`${t}T12:00:00`) : new Date();
};
/** YYYY-MM-DD in local time */
export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
