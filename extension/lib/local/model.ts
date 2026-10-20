// The one thing that goes over the network: the chat call to the model server. Works with ANY OpenAI-compatible
// server (Ollama, vLLM, llama.cpp, LM Studio, LocalAI, TGI...) and works out what it supports, falling back
// automatically: JSON schema -> JSON mode -> plain text, and system role -> instructions merged into the user message.
import { getConfig, type ModelEntry } from '../config';
import * as store from './store';

export interface Cfg {
  name: string;
  url: string;
  model: string;
  key?: string | null;
  vision: boolean;
  temperature: number;
  provider_id: number | null;
  json_mode: 'auto' | 'schema' | 'object' | 'none';
  context_tokens: number;
}

export interface UserSettings {
  emp_id: string; provider_id: number | null; custom_url: string | null; custom_model: string | null;
  custom_key: string | null; temperature: number; updated_at: string;
}

export function entryCfg(p: ModelEntry, temperature = 0.2): Cfg {
  return { name: p.name, url: p.url, model: p.model, key: p.key || null, vision: !!p.vision, temperature, provider_id: p.id,
    json_mode: p.json_mode && p.json_mode !== 'auto' ? p.json_mode : 'auto', context_tokens: p.context_tokens || 8192 };
}

export async function defaultModelCfg(): Promise<Cfg> {
  const { models } = await getConfig();
  const p = models.find((m) => m.default) || models[0];
  if (!p) throw new Error('No model server is set up (ask your administrator).');
  return entryCfg(p);
}

/** The model this user chose in Settings, else the default one. */
export async function modelCfg(emp_id: string): Promise<Cfg> {
  const cfg = await getConfig();
  const s = await store.get<UserSettings>('settings', emp_id);
  const temp = s?.temperature ?? 0.2;
  if (s?.custom_url && cfg.allowCustomEndpoints)
    return { name: 'Custom endpoint', url: s.custom_url, model: s.custom_model || '', key: s.custom_key, vision: false, temperature: temp,
      provider_id: null, json_mode: 'auto', context_tokens: 8192 };
  const p = s?.provider_id != null ? cfg.models.find((m) => m.id === s.provider_id) : undefined;
  if (p) return entryCfg(p, temp);
  return { ...(await defaultModelCfg()), temperature: temp };
}

// ---------------------------------------------------------------- what each server supports, learned on first use

const JSON_MODES = ['schema', 'object', 'none'] as const;
interface Caps { json: string; system: boolean; forced: boolean; think_off: boolean; think_off_rejected: boolean; max_tokens: number | null }
const caps = new Map<string, Caps>();

export function capabilities(cfg: { url: string; model: string; json_mode?: string }): Caps {
  const key = `${cfg.url.replace(/\/+$/, '')}|${cfg.model}`;
  if (!caps.has(key)) {
    const forced = cfg.json_mode || 'auto';
    caps.set(key, { json: forced === 'auto' ? 'schema' : forced, system: true, forced: forced !== 'auto', think_off: false,
      think_off_rejected: false, max_tokens: null });
  }
  return caps.get(key)!;
}

/** Filled in by agent.ts (the action schema is used when no other schema is given). */
export const defaults = { actionSchema: {} as object };

export async function callModel(cfg: { url: string; model: string; key?: string | null; temperature?: number; json_mode?: string },
                                messages: any[], opts: { schema?: object; timeout?: number; json_mode?: boolean; no_think?: boolean } = {}): Promise<string> {
  const { schema, timeout = 900, json_mode = true, no_think = false } = opts;
  const c = capabilities(cfg);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;
  const url = `${cfg.url.replace(/\/+$/, '')}/chat/completions`;
  let lastError = '';
  for (let i = 0; i < 8; i++) {
    let msgs = messages;
    if (!c.system && msgs.length && msgs[0].role === 'system') {
      const first = msgs[1].content;
      const merged = typeof first === 'string' ? `${msgs[0].content}\n\n${first}` : [{ type: 'text', text: msgs[0].content }, ...first];
      msgs = [{ role: 'user', content: merged }, ...msgs.slice(2)];
    }
    const body: any = { model: cfg.model, messages: msgs, temperature: cfg.temperature ?? 0.2,
      max_tokens: c.max_tokens || (json_mode && schema === undefined ? 400 : 900) };
    if (c.think_off || (no_think && !c.think_off_rejected)) {
      // "Thinking" models (Gemma 4, Qwen 3.x, DeepSeek-R1...) spend the reply budget on hidden reasoning.
      // Different servers use different switches; servers ignore the ones they don't know.
      Object.assign(body, { reasoning_effort: 'none', think: false, chat_template_kwargs: { enable_thinking: false } });
    }
    const mode = json_mode ? c.json : 'none';
    if (mode === 'schema')
      body.response_format = { type: 'json_schema', json_schema: { name: schema === undefined ? 'browser_action' : 'structured_reply', strict: true,
        schema: schema === undefined ? defaults.actionSchema : schema } };
    else if (mode === 'object') body.response_format = { type: 'json_object' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout * 1000);
    let r: Response;
    let text: string;
    try {
      r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
      text = await r.text();
    } catch (e: any) {
      throw new Error(e?.name === 'AbortError' ? `model server did not answer within ${timeout}s` : `cannot reach the model server: ${e?.message || e}`);
    } finally {
      clearTimeout(timer);
    }
    if (r.status >= 400 && c.think_off && /reason|think|template|unknown|unrecognized/i.test(text)) {
      c.think_off = false;   // server rejects the switches: drop them
      c.think_off_rejected = true;
      continue;
    }
    if (r.status < 400) {
      const choice = JSON.parse(text).choices[0];
      const content: string = choice.message?.content || '';
      const reasoning = choice.message?.reasoning_content || choice.message?.reasoning || '';
      const truncated = choice.finish_reason === 'length';
      if ((truncated || reasoning) && !c.think_off && !c.think_off_rejected) {
        c.think_off = true;   // it is thinking: ask the server to stop
        continue;
      }
      if (truncated && (c.max_tokens || 0) < 2000) {
        c.max_tokens = 2000;   // still cut off: allow a longer reply
        continue;
      }
      if (mode !== 'none' && !content.trim() && !c.forced) {
        c.json = JSON_MODES[JSON_MODES.indexOf(mode as any) + 1];   // accepted but returned nothing: step down
        continue;
      }
      return content;
    }
    lastError = `${r.status}: ${text.slice(0, 200)}`;
    if ([400, 422, 500, 501].includes(r.status)) {
      if (c.system && /system|role/i.test(text)) {
        c.system = false;   // template/server without a system role
        continue;
      }
      if (mode !== 'none' && !c.forced) {
        c.json = JSON_MODES[JSON_MODES.indexOf(mode as any) + 1];
        continue;
      }
    }
    throw new Error(`model server error ${lastError}`);
  }
  throw new Error(`model server kept rejecting requests (${lastError})`);
}
