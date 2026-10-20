// Server addresses. Admins can push these to every PC through browser policy
// (chrome.storage.managed, see public/managed-schema.json); the defaults are for the demo.
import { browser } from 'wxt/browser';
export interface CommsSource {
  name: string;
  listUrl: string;   // the app's list of the user's communications (read with the user's own session)
  signInUrl: string; // where to send the user if they are not signed in to that app
}

export interface Config {
  apiUrl: string;
  keycloakUrl: string;
  clientId: string;
  commsSources: CommsSource[];
}

const DEFAULTS: Config = {
  apiUrl: 'http://ai.office.local:8000',
  keycloakUrl: 'http://keycloak.office.local:8080/realms/company',
  clientId: 'browser-agent',
  commsSources: [
    { name: 'Legacy ERP', listUrl: 'http://legacy.office.local:8500/api/comms', signInUrl: 'http://legacy.office.local:8500/' },
  ],
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
