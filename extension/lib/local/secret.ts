// Secrets the user types in (a model server's API key) are kept for good, but encrypted: with an AES key the browser
// made for this extension and will not hand out (non-extractable), stored in IndexedDB. A copy of the profile's files
// on another PC shows only ciphertext. (Anyone using this same browser profile can still use the key; that is the
// nature of a key that works without asking for a password each time.)
import * as store from './store';

let keyp: Promise<CryptoKey> | null = null;
function key(): Promise<CryptoKey> {
  return (keyp ??= (async () => {
    const row = await store.get('kv', 'secret-key');
    if (row?.key) return row.key as CryptoKey;
    const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await store.put('kv', { k: 'secret-key', key: k });
    return k;
  })());
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function seal(text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(text)));
  return `v1:${b64(iv)}:${b64(data)}`;
}

export async function unseal(sealed: string | null | undefined): Promise<string | null> {
  if (!sealed) return null;
  const [v, iv, data] = sealed.split(':');
  if (v !== 'v1') return null;
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await key(), unb64(data)));
  } catch {
    return null;   // made with a key this browser no longer has: the user types it again
  }
}
