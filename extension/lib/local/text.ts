// Small text helpers shared by several areas.
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'please', 'into', 'about', 'your', 'you', 'are', 'was',
  'will', 'have', 'has', 'our', 'per', 'each', 'via', 'not', 'all', 'any', 'can', 'legacy', 'erp', 'intranet']);

export function words(text: string): Set<string> {
  return new Set(((text || '').toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !STOP.has(w)));
}

/** Share of the shorter text's words that the other has too (0..1). */
export function similarity(a: string, b: string): number {
  const wa = words(a), wb = words(b);
  let n = 0;
  for (const w of wa) if (wb.has(w)) n++;
  return n / Math.max(1, Math.min(wa.size, wb.size));
}

/** Python's fnmatch for host rules like "*.office.local" */
export function fnmatch(s: string, pattern: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(s);
}

export const hostOf = (u: string | null | undefined) => { try { return new URL(u || '').hostname; } catch { return ''; } };
