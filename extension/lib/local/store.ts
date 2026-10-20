// Everything the assistant keeps lives here, in the browser (IndexedDB), on the user's own PC. No server.
// Works in every extension page (side panel, audit page, offscreen document) and the background; they share it.

export const STORES: Record<string, { key: string | string[]; auto?: boolean; indexes?: Record<string, string | string[]> }> = {
  users: { key: 'emp_id' },
  profile: { key: ['emp_id', 'field'], indexes: { emp_id: 'emp_id' } },          // {emp_id, field, value, source, updated_at}
  settings: { key: 'emp_id' },                                                 // the user's model choice
  tasks: { key: 'task_id', indexes: { emp_id: 'emp_id' } },
  events: { key: 'id', auto: true, indexes: { task_id: 'task_id' } },          // the hash-chained audit trail
  playbooks: { key: 'id', auto: true },                                        // taught ones (seed ones come from policy)
  experiences: { key: 'id', auto: true },                                      // how successful runs were done
  outcomes: { key: 'task_id' },                                                // per finished task, for playbook health
  links: { key: 'id', auto: true, indexes: { emp_id: 'emp_id' } },             // "Your apps"
  comms: { key: 'id', auto: true, indexes: { emp_id: 'emp_id', uniq: ['emp_id', 'source', 'ext_id'] } },
  letters: { key: 'id', auto: true, indexes: { emp_id: 'emp_id', sha: ['emp_id', 'sha256'] } },
  files: { key: 'name' },                                                      // blobs: letter PDFs, screenshots
  kv: { key: 'k' },
};
const NAME = 'office-assistant-data';
const VERSION = 1;

let dbp: Promise<IDBDatabase> | null = null;
export function open(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((ok, bad) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const [name, s] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const os = db.createObjectStore(name, { keyPath: s.key, autoIncrement: !!s.auto });
        for (const [iname, path] of Object.entries(s.indexes || {})) os.createIndex(iname, path, { unique: iname === 'uniq' || iname === 'sha' });
      }
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  }));
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });

/** Run fn inside one transaction (atomic, and serialised with other writers in every extension page).
 *  fn must only await IndexedDB requests made through `req`/the store, nothing else, or the transaction closes. */
export async function tx<T>(stores: string | string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  const t = (await open()).transaction(stores, mode);
  const done = new Promise<void>((ok, bad) => { t.oncomplete = () => ok(); t.onerror = () => bad(t.error); t.onabort = () => bad(t.error); });
  const out = await fn(t);
  await done;
  return out;
}
export { req };

export async function get<T = any>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return tx(store, 'readonly', (t) => req(t.objectStore(store).get(key)));
}
export async function put(store: string, row: any): Promise<IDBValidKey> {
  return tx(store, 'readwrite', (t) => req(t.objectStore(store).put(row)));
}
export async function add(store: string, row: any): Promise<number> {
  return tx(store, 'readwrite', (t) => req(t.objectStore(store).add(row))) as Promise<number>;
}
export async function del(store: string, key: IDBValidKey | IDBKeyRange): Promise<void> {
  await tx(store, 'readwrite', (t) => req(t.objectStore(store).delete(key)));
}
export async function all<T = any>(store: string, index?: string, value?: IDBValidKey | IDBKeyRange): Promise<T[]> {
  return tx(store, 'readonly', (t) => {
    const s = t.objectStore(store);
    return req((index ? s.index(index) : s).getAll(value));
  });
}
export async function one<T = any>(store: string, index: string, value: IDBValidKey): Promise<T | undefined> {
  return tx(store, 'readonly', (t) => req(t.objectStore(store).index(index).get(value)));
}
/** Read-modify-write one row atomically. fn gets the row (or undefined) and returns the new row (or undefined = no change). */
export async function update<T = any>(store: string, key: IDBValidKey, fn: (row: T | undefined) => T | undefined): Promise<T | undefined> {
  return tx(store, 'readwrite', async (t) => {
    const s = t.objectStore(store);
    const next = fn(await req(s.get(key)));
    if (next !== undefined) await req(s.put(next));
    return next;
  });
}
export async function clear(store: string): Promise<void> {
  await tx(store, 'readwrite', (t) => req(t.objectStore(store).clear()));
}

export const now = () => new Date().toISOString();
