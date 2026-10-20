// The assistant's API. There is no server: every call is answered inside the browser (lib/local), and only the
// model is reached over the network (lib/local/model.ts).
import { ApiError } from './errors';
import { dispatch } from './local/router';
import './local/routes';
import * as store from './local/store';

export { ApiError };

export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return dispatch(path, method, body) as Promise<T>;
}

/** A file kept in the browser (a letter's PDF, a CSV...) as a Blob. */
export async function apiBlob(path: string, method = 'GET', body?: unknown): Promise<Blob> {
  const r = await dispatch(path, method, body);
  if (!(r instanceof Blob)) throw new ApiError(500, `${path} did not return a file`);
  return r;
}

/** Screenshots are kept in the browser too: hand back a blob URL. */
export async function screenshotUrl(name: string): Promise<string> {
  const f = await store.get('files', `shot:${name}`);
  if (!f) throw new ApiError(404, 'screenshot not found');
  return URL.createObjectURL(f.blob);
}
