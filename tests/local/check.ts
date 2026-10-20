// Tiny test helper: check(name, ok, detail) and a summary at the end.
const results: boolean[] = [];
export function check(name: string, ok: boolean, detail: unknown = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== '' ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
export function summary(what = 'checks') {
  console.log(`\n${results.filter(Boolean).length}/${results.length} ${what} passed`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
}
