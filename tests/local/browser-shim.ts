// Stand-in for the browser APIs when the extension's local modules run under Node (unit tests).
const mem: Record<string, Record<string, any>> = { local: {}, session: {}, managed: {} };
const area = (name: string) => ({
  async get(k?: string | string[] | null) {
    if (k == null) return { ...mem[name] };
    const keys = Array.isArray(k) ? k : [k];
    return Object.fromEntries(keys.filter((x) => x in mem[name]).map((x) => [x, mem[name][x]]));
  },
  async set(o: Record<string, any>) { Object.assign(mem[name], o); },
  async remove(k: string | string[]) { for (const x of Array.isArray(k) ? k : [k]) delete mem[name][x]; },
});
export const browser: any = {
  storage: { local: area('local'), session: area('session'), managed: area('managed') },
  management: { getSelf: async () => ({ installType: 'development' }) },
  runtime: { id: 'test', getURL: (p: string) => `chrome-extension://test${p}`, sendMessage: async () => {}, onMessage: { addListener() {} } },
  tabs: { query: async () => [] },
};
/** Sign in a test user: a token with the claims Keycloak would give. */
export function signIn(claims: Record<string, any>) {
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
  mem.session.tokens = { access_token: `${b64({ alg: 'none' })}.${b64(claims)}.x`, refresh_token: 'r', id_token: 'i', expires_at: Date.now() + 3600e3 };
}
export function setDevConfig(c: any) { mem.local.devConfig = c; }
