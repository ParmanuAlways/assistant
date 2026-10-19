// Server addresses. Admins can push these to every PC through browser policy
// (chrome.storage.managed, see public/managed-schema.json); the defaults are for the demo.
import { browser } from 'wxt/browser';
export interface Config {
  apiUrl: string;
  keycloakUrl: string;
  clientId: string;
}

const DEFAULTS: Config = {
  apiUrl: 'http://ai.office.local:8000',
  keycloakUrl: 'http://keycloak.office.local:8080/realms/company',
  clientId: 'browser-agent',
};

export async function getConfig(): Promise<Config> {
  let managed: Partial<Config> = {};
  try {
    managed = (await browser.storage.managed.get(null)) as Partial<Config>;
  } catch {
    // no policy installed
  }
  return { ...DEFAULTS, ...managed };
}
