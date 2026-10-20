// The assistant's "API", answered inside the browser. The panel calls api('/api/...') as before; nothing goes to a
// server except the model call. Each area registers its routes (routes/*.ts).
import { ApiError } from '../errors';
import { currentUser, type User } from './identity';

export interface Ctx { user: User; body: any; params: Record<string, string>; query: URLSearchParams }
type Handler = (ctx: Ctx) => Promise<any> | any;
const routes: { method: string; re: RegExp; keys: string[]; fn: Handler }[] = [];

/** route('GET', '/api/letters/:id', fn) */
export function route(method: string, pattern: string, fn: Handler) {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, fn });
}

export async function dispatch(path: string, method = 'GET', body?: unknown): Promise<any> {
  const u = new URL(path, 'http://local');
  const r = routes.find((x) => x.method === method && x.re.test(u.pathname));
  if (!r) throw new ApiError(404, `No such route: ${method} ${u.pathname}`);
  const m = u.pathname.match(r.re)!;
  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  const user = await currentUser();
  // a deep copy, like a request body would be: handlers may keep or change what they get
  return r.fn({ user, body: body === undefined ? {} : structuredClone(body), params, query: u.searchParams });
}
