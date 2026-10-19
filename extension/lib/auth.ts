// Keycloak sign-in (OIDC authorization code + PKCE) via the browser identity API.
import { browser } from 'wxt/browser';
import { getConfig } from './config';

export interface Tokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_at: number; // epoch ms
}

export interface UserInfo {
  name: string;
  username: string;
  emp_id: string;
  roles: string[];
}

function randomString(len = 48) {
  const arr = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256base64url(text: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function saveTokens(t: any): Promise<Tokens> {
  const tokens: Tokens = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    id_token: t.id_token,
    expires_at: Date.now() + (t.expires_in - 15) * 1000,
  };
  // session storage: cleared when the browser closes (safer on shared PCs)
  await browser.storage.session.set({ tokens });
  return tokens;
}

export async function login(): Promise<Tokens> {
  const cfg = await getConfig();
  const redirectUri = browser.identity.getRedirectURL();
  const verifier = randomString();
  const state = randomString(16);
  const authUrl =
    `${cfg.keycloakUrl}/protocol/openid-connect/auth?` +
    new URLSearchParams({
      client_id: cfg.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      code_challenge: await sha256base64url(verifier),
      code_challenge_method: 'S256',
      state,
      prompt: 'login',
    });

  const resultUrl = await browser.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  const params = new URL(resultUrl!).searchParams;
  if (params.get('state') !== state) throw new Error('Sign-in state mismatch');
  const code = params.get('code');
  if (!code) throw new Error(params.get('error_description') || 'Sign-in was cancelled');

  const res = await fetch(`${cfg.keycloakUrl}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cfg.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  return saveTokens(await res.json());
}

export async function getAccessToken(): Promise<string | null> {
  const { tokens } = (await browser.storage.session.get('tokens')) as { tokens?: Tokens };
  if (!tokens) return null;
  if (Date.now() < tokens.expires_at) return tokens.access_token;
  const cfg = await getConfig();
  const res = await fetch(`${cfg.keycloakUrl}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: cfg.clientId, refresh_token: tokens.refresh_token }),
  });
  if (!res.ok) {
    await browser.storage.session.remove('tokens');
    return null;
  }
  return (await saveTokens(await res.json())).access_token;
}

export async function logout() {
  const { tokens } = (await browser.storage.session.get('tokens')) as { tokens?: Tokens };
  await browser.storage.session.remove('tokens');
  if (!tokens) return;
  const cfg = await getConfig();
  // End the Keycloak session too, so the next person on this PC must sign in again
  await fetch(`${cfg.keycloakUrl}/protocol/openid-connect/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, refresh_token: tokens.refresh_token }),
  }).catch(() => {});
}
