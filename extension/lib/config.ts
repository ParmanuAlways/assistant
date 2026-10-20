// Settings and admin rules. There is no server of ours: admins push these to every PC through browser policy
// (chrome.storage.managed, see public/managed-schema.json); the defaults are for the demo. The user cannot change them.
import { browser } from 'wxt/browser';
export interface CommsSource {
  name: string;
  listUrl: string;   // the app's list of the user's communications (read with the user's own session)
  signInUrl: string; // where to send the user if they are not signed in to that app
}

export interface LetterSource {
  name: string;
  hosts: string[];   // PDFs downloaded from these sites are letters to file (e.g. eoffice.nic.in)
}

export interface ModelEntry {
  id: number;
  name: string;
  url: string;            // any OpenAI-compatible server: llama.cpp, Ollama, vLLM...
  model: string;
  key?: string;
  vision?: boolean;
  json_mode?: 'auto' | 'schema' | 'object' | 'none';
  context_tokens?: number;
  default?: boolean;
  note?: string;
}

export interface PlaybookEntry { site: string; task: string; steps: string; macro?: any[] }

export interface Config {
  keycloakUrl: string;
  clientId: string;
  commsSources: CommsSource[];
  letterSources: LetterSource[];
  letterFolder: string;   // filed under <Downloads>/<letterFolder>/<Correspondent>/
  models: ModelEntry[];             // the model servers users can choose from (the first default one is used)
  allowCustomEndpoints: boolean;    // may users type in their own model server?
  allowedModelHosts: string[];      // ...only on these hosts (wildcards or CIDR)
  allowedSites: string[];           // sites the assistant may act on
  maxSteps: number;
  playbooks: PlaybookEntry[];       // how to use each office site (shared with everyone)
  directoryUrl: string;             // optional: colleagues' names and e-mails (JSON list), so the model never guesses
  agent: { plan: boolean; workflows: boolean; calendar: boolean; vision: boolean; today?: string };
}

const DEFAULTS: Config = {
  keycloakUrl: 'http://keycloak.office.local:8080/realms/company',
  clientId: 'browser-agent',
  commsSources: [
    { name: 'Legacy ERP', listUrl: 'http://legacy.office.local:8500/api/comms', signInUrl: 'http://legacy.office.local:8500/' },
  ],
  letterSources: [{ name: 'e-Office', hosts: ['eoffice.office.local'] }],
  letterFolder: 'eOffice',
  models: [
    { id: 1, name: 'Test stand-in model (rule-based, not AI)', url: 'http://llm.office.local:9100/v1', model: 'stand-in-v1', default: true,
      note: 'Default model for the demo.' },
    { id: 2, name: 'Gemma 3 12B (Office GPU)', url: 'http://gpu1.office.local:11434/v1', model: 'gemma3:12b', vision: true,
      note: 'Example entry for your office Ollama server.' },
  ],
  allowCustomEndpoints: false,
  allowedModelHosts: ['*.office.local', '127.0.0.1', 'localhost', '10.0.0.0/8'],
  allowedSites: ['*.office.local'],
  maxSteps: 40,
  playbooks: [
    { site: 'hr.office.local', task: 'Leave applications', steps: 'Start URL: http://hr.office.local:8200/  Apply Leave.' },
    { site: 'helpdesk.office.local', task: 'IT support tickets', steps: 'Start URL: http://helpdesk.office.local:8300/  Raise a Ticket for IT problems.' },
    { site: 'expenses.office.local', task: 'Expense reimbursement claims', steps: 'Start URL: http://expenses.office.local:8300/  New Claim, then review and submit.' },
    { site: 'rooms.office.local', task: 'Meeting room booking', steps: 'Start URL: http://rooms.office.local:8300/  Find a Room, pick one from the results, book it.' },
    { site: 'visitors.office.local', task: 'Visitor passes', steps: 'Start URL: http://visitors.office.local:8300/  Register Visitor.' },
    { site: 'canteen.office.local', task: 'Canteen food orders', steps: 'Start URL: http://canteen.office.local:8300/  Order Food.' },
    { site: 'mail.office.local', task: 'Email (webmail)', steps: 'Start URL: http://mail.office.local:8400/  Read, search, send, reply, forward and move emails.' },
    { site: 'legacy.office.local', task: 'Legacy ERP: travel requests, purchase requests, PO approvals, timesheet upload, contact details',
      steps: 'Start URL: http://legacy.office.local:8500/  Has its own sign-in page. Menu on the left (Requests, Approvals, My Profile).' },
  ],
  directoryUrl: 'http://intranet.office.local:8300/directory.json',
  agent: { plan: true, workflows: true, calendar: true, vision: false },
};

export async function getConfig(): Promise<Config> {
  let managed: Partial<Config> = {};
  try {
    managed = (await browser.storage.managed.get(null)) as Partial<Config>;
  } catch {
    // no policy installed
  }
  // Developer builds only (loaded unpacked, as in the tests): settings a test sets in storage.local.
  // An installed extension ignores these, so a user can never loosen the admin's rules.
  let dev: Partial<Config> = {};
  try {
    if ((await browser.management.getSelf()).installType === 'development')
      dev = ((await browser.storage.local.get('devConfig')) as any).devConfig || {};
  } catch {}
  const cfg = { ...DEFAULTS, ...managed, ...dev } as Config;
  cfg.agent = { ...DEFAULTS.agent, ...(managed.agent || {}), ...(dev.agent || {}) };
  return cfg;
}
