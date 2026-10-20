// The audit trail: every request, page seen, model decision, action, answer, confirmation and setting change, in one
// append-only hash chain (each entry carries the hash of the one before, so any edit or deletion breaks the chain).
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { now, req, tx } from './store';

const SENSITIVE = ['password', 'passwd', 'pin', 'otp', 'cvv', 'aadhaar', 'pan_number', 'account_number'];

export function mask(obj: any): any {
  if (Array.isArray(obj)) return obj.map(mask);
  if (obj && typeof obj === 'object')
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, SENSITIVE.some((s) => k.toLowerCase().includes(s)) ? '****' : mask(v)]));
  return obj;
}

/** JSON with sorted keys, so the same record always hashes the same. */
export function stable(v: any): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

const record = (e: any) => ({ task_id: e.task_id ?? null, emp_id: e.emp_id, seq: e.seq, type: e.event_type, url: e.url ?? null,
  payload: stable(e.payload), screenshot: e.screenshot ?? null, time: e.created_at });
// sha256 is synchronous here on purpose: the transaction must not wait on anything but the database
const hash = (prev: string, e: any) => bytesToHex(sha256(new TextEncoder().encode(prev + stable(record(e)))));

export interface AuditEvent {
  id?: number; task_id: string | null; emp_id: string; seq: number; event_type: string; url: string | null;
  payload: any; screenshot: string | null; created_at: string; prev_hash: string; hash: string;
}

/** Append one event. Returns its sequence number within the task. */
export async function logEvent(emp_id: string, event_type: string, payload: any,
                               opts: { task_id?: string | null; url?: string | null; screenshot?: string | null } = {}): Promise<number> {
  return tx('events', 'readwrite', async (t) => {
    const s = t.objectStore('events');
    const cur = await req(s.openCursor(null, 'prev'));
    const prev = cur ? (cur.value as AuditEvent).hash : 'GENESIS';
    let seq = 0;
    if (opts.task_id) {
      const c = await req(s.index('task_id').openCursor(IDBKeyRange.only(opts.task_id), 'prev'));
      // (ids grow with time, so the last one for the task has the highest seq)
      seq = (c ? (c.value as AuditEvent).seq : 0) + 1;
    }
    const e: AuditEvent = { task_id: opts.task_id ?? null, emp_id, seq, event_type, url: opts.url ?? null,
      payload: JSON.parse(JSON.stringify(payload ?? {})), screenshot: opts.screenshot ?? null, created_at: now(), prev_hash: prev, hash: '' };
    e.hash = hash(prev, e);
    await req(s.add(e));
    return seq;
  });
}

export async function verifyChain() {
  return tx('events', 'readonly', async (t) => {
    const rows = (await req(t.objectStore('events').getAll())) as AuditEvent[];
    let prev = 'GENESIS';
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.prev_hash !== prev || hash(prev, r) !== r.hash)
        return { ok: false, checked: i, broken_at_event_id: r.id, task_id: r.task_id, seq: r.seq, event_type: r.event_type };
      prev = r.hash;
    }
    return { ok: true, checked: rows.length };
  });
}

/** Events of one task, in order. */
export async function taskEvents(task_id: string): Promise<AuditEvent[]> {
  const rows = await tx('events', 'readonly', (t) => req(t.objectStore('events').index('task_id').getAll(task_id))) as AuditEvent[];
  return rows.sort((a, b) => a.seq - b.seq);
}
