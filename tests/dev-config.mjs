// What a test run asked for (the model under test, the date, the assistant's switches), turned into the settings IT
// would push by browser policy. Developer builds of the extension read them from storage.local ("devConfig").
// Taken from the environment, else from what ./start-services.sh was started with (infra/logs/run-env.json):
// DEFAULT_MODEL_URL / DEFAULT_MODEL_NAME, AGENT_PLAN, AGENT_WORKFLOWS, AGENT_CALENDAR, AGENT_VISION, AGENT_TODAY,
// AGENT_JSON_MODE (auto|schema|object|none) or the older AGENT_SCHEMA=1|0.
import fs from 'node:fs';

export function devConfigFromEnv(root = '/home/user/browser-agent') {
  let started = {};
  try { started = JSON.parse(fs.readFileSync(`${root}/infra/logs/run-env.json`, 'utf8')); } catch {}
  const env = { ...started, ...process.env };
  if (!env.AGENT_JSON_MODE && env.AGENT_SCHEMA) env.AGENT_JSON_MODE = env.AGENT_SCHEMA === '1' ? 'schema' : 'object';
  const flag = (v, dflt) => (v === undefined || v === '' ? dflt : v === '1');
  return {
    ...(env.DEFAULT_MODEL_URL ? { models: [{ id: 1, name: env.DEFAULT_MODEL_NAME ? `${env.DEFAULT_MODEL_NAME} (llama.cpp, CPU)` : 'Model under test',
      url: env.DEFAULT_MODEL_URL, model: env.DEFAULT_MODEL_NAME || 'stand-in-v1', default: true, vision: env.AGENT_VISION === '1',
      json_mode: env.AGENT_JSON_MODE || 'auto' }] } : {}),
    agent: { plan: flag(env.AGENT_PLAN, true), workflows: flag(env.AGENT_WORKFLOWS, true), calendar: flag(env.AGENT_CALENDAR, true),
      vision: env.AGENT_VISION === '1', ...(env.AGENT_TODAY ? { today: env.AGENT_TODAY } : {}) },
  };
}

/** Hand the settings to the extension (any extension page). */
export const applyDevConfig = (page, cfg = devConfigFromEnv()) => page.evaluate((c) => chrome.storage.local.set({ devConfig: c }), cfg);
