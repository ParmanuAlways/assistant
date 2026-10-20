// Letters downloaded from e-Office (or any site in letterSources): read as the user, filed per correspondent.
import { browser } from 'wxt/browser';
import { api } from './api';
import { getConfig, type Config } from './config';

export interface Filed { id: number; folder: string; file_name: string; intent_label: string; subject: string; new: boolean }

const hostOf = (u?: string) => { try { return new URL(u || '').hostname; } catch { return ''; } };

/** A finished or starting download that is a letter from one of the configured sites. */
export function isLetterDownload(item: { url?: string; finalUrl?: string; referrer?: string; filename?: string; mime?: string },
                                 cfg: Config): boolean {
  const hosts = cfg.letterSources.flatMap((s) => s.hosts);
  const fromSite = [item.finalUrl, item.url, item.referrer].some((u) => hosts.includes(hostOf(u)));
  const pdf = item.mime === 'application/pdf' || /\.pdf$/i.test(item.filename || '') || /\.pdf($|\?)/i.test(item.finalUrl || item.url || '');
  return fromSite && pdf;
}

export function toB64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The file, fetched with the user's own session: directly, else from inside an open tab of that site. */
export async function fetchAsUser(url: string): Promise<ArrayBuffer | null> {
  try {
    const r = await fetch(url, { credentials: 'include' });
    const buf = r.ok ? await r.arrayBuffer() : null;
    if (buf && new TextDecoder().decode(buf.slice(0, 4)) === '%PDF') return buf;
  } catch {}
  for (const t of await browser.tabs.query({ url: `${new URL(url).origin}/*` })) {
    const [res] = await browser.scripting.executeScript({
      target: { tabId: t.id! },
      func: async (u: string) => {
        const x = await fetch(u, { credentials: 'include' });
        if (!x.ok) return null;
        const b = new Uint8Array(await x.arrayBuffer());
        let s = '';
        for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
        return btoa(s);
      },
      args: [url],
    }).catch(() => [null as any]);
    if (res?.result) return fromB64(res.result).buffer as ArrayBuffer;
  }
  return null;
}

export async function ingest(buf: ArrayBuffer, url: string, name: string): Promise<Filed> {
  return api<Filed>('/api/letters/ingest', 'POST', { pdf_b64: toB64(buf), url, original_name: name, source: 'e-Office' });
}

/** Where a letter goes inside Downloads: eOffice/<Correspondent>/<date - type - subject - file no>.pdf */
export async function downloadsPath(f: { folder: string; file_name: string }): Promise<string> {
  const root = (await getConfig()).letterFolder.replace(/[\\/:*?"<>|]+/g, '-') || 'eOffice';
  return `${root}/${f.folder}/${f.file_name}`;
}
