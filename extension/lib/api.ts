// Calls to the Office Assistant backend with the signed-in user's token.
import { getAccessToken } from './auth';
import { getConfig } from './config';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new ApiError(401, 'Not signed in');
  const { apiUrl } = await getConfig();
  const res = await fetch(apiUrl + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).detail ?? msg;
    } catch {}
    throw new ApiError(res.status, msg);
  }
  return res.json();
}

/** Screenshots need the token too, so fetch them and hand back a blob URL. */
export async function screenshotUrl(name: string): Promise<string> {
  const token = await getAccessToken();
  const { apiUrl } = await getConfig();
  const res = await fetch(`${apiUrl}/api/screenshots/${name}`, { headers: { Authorization: `Bearer ${token}` } });
  return URL.createObjectURL(await res.blob());
}
