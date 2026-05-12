// Provider abstraction — the Reader and settings UI both talk to this
// instead of directly to anthropic.js / openai.js. Adding a new provider
// (Gemini, Ollama, ...) is a matter of writing a client with the same
// surface and registering it here.

import * as Anthropic from "./anthropic.js";
import * as OpenAi from "./openai.js";

const PROVIDER_STORAGE = "marklee-ai-provider";

const PROVIDER_DEFS = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic Claude",
    module: Anthropic,
    defaultModel: "claude-sonnet-4-6",
    models: [
      { id: "claude-sonnet-4-6",           label: "Claude Sonnet 4.6 (default — balanced)" },
      { id: "claude-opus-4-7",             label: "Claude Opus 4.7 (slow, most thorough)" },
      { id: "claude-haiku-4-5-20251001",   label: "Claude Haiku 4.5 (fast, cheap)" },
    ],
    keyPlaceholder: "sk-ant-…",
    keyHint: "console.anthropic.com → API Keys",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    module: OpenAi,
    defaultModel: "gpt-4o",
    models: [
      { id: "gpt-4o",        label: "GPT-4o (default — vision + tools)" },
      { id: "gpt-4o-mini",   label: "GPT-4o mini (fast, cheap, vision)" },
      { id: "gpt-4-turbo",   label: "GPT-4 Turbo" },
    ],
    keyPlaceholder: "sk-…",
    keyHint: "platform.openai.com → API Keys",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDER_DEFS);

// Hydrate every provider's encrypted-key cache before the UI consults
// hasApiKey()/getApiKey(). Called once from main.js startup.
export async function initAllProviderKeys() {
  await Promise.all(
    PROVIDER_IDS.map((id) => {
      const mod = PROVIDER_DEFS[id].module;
      return mod.initApiKeyStore ? mod.initApiKeyStore() : Promise.resolve();
    })
  );
}

export function getProviderId() {
  try { return localStorage.getItem(PROVIDER_STORAGE) || "anthropic"; } catch { return "anthropic"; }
}
export function setProviderId(id) {
  try { localStorage.setItem(PROVIDER_STORAGE, id); } catch {}
}

export function getProviderDef(id) {
  return PROVIDER_DEFS[id] || PROVIDER_DEFS.anthropic;
}
export function activeProvider() {
  return getProviderDef(getProviderId());
}

// Unified accessors — these forward to the active provider so callers
// don't need to know which one is selected.
export function callMessages(opts) {
  return activeProvider().module.callMessages(opts);
}
export function hasApiKey() {
  return activeProvider().module.hasApiKey();
}
export function getApiKey() {
  return activeProvider().module.getApiKey();
}
export function setApiKey(key) {
  return activeProvider().module.setApiKey(key);
}
export function getModel() {
  return activeProvider().module.getModel();
}
export function setModel(m) {
  return activeProvider().module.setModel(m);
}

// Per-provider versions for the settings UI (lets the modal show all
// providers' current state at once).
export function getProviderHasKey(id) {
  return getProviderDef(id).module.hasApiKey();
}
export function setProviderApiKey(id, key) {
  return getProviderDef(id).module.setApiKey(key);
}
export function getProviderModel(id) {
  return getProviderDef(id).module.getModel();
}
export function setProviderModel(id, m) {
  return getProviderDef(id).module.setModel(m);
}
