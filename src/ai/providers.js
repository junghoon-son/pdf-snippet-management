// Provider abstraction — the Reader and settings UI both talk to this
// instead of directly to anthropic.js / openai.js. Adding a new provider
// (Gemini, Mistral, ...) is a matter of writing a client with the same
// surface and registering it here.

import * as Anthropic from "./anthropic.js";
import * as OpenAi from "./openai.js";
import * as Gemini from "./gemini.js";

const PROVIDER_STORAGE = "marklee-ai-provider";

// `maxOutputTokens` is each model's native output ceiling. Callers that
// need a generous output budget (e.g. the Reader's many-highlights mode)
// resolve to the active model's cap via getMaxOutputTokens(); callers with
// a tight budget (e.g. the Planner's short-plan call) pass their own
// smaller value. Updated 2026-05-14 — bump as providers extend limits.
const PROVIDER_DEFS = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic Claude",
    module: Anthropic,
    defaultModel: "claude-sonnet-4-6",
    models: [
      { id: "claude-sonnet-4-6",           label: "Claude Sonnet 4.6 (default — balanced)",   maxOutputTokens: 32768 },
      { id: "claude-opus-4-7",             label: "Claude Opus 4.7 (slow, most thorough)",    maxOutputTokens: 24576 },
      { id: "claude-haiku-4-5-20251001",   label: "Claude Haiku 4.5 (fast, cheap)",           maxOutputTokens: 32768 },
    ],
    keyPlaceholder: "sk-ant-…",
    keyHint: "console.anthropic.com → API Keys",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    module: OpenAi,
    defaultModel: "gpt-4.1",
    models: [
      { id: "gpt-4.1",        label: "GPT-4.1 (default — balanced, vision + tools)",  maxOutputTokens: 32768 },
      { id: "gpt-4.1-mini",   label: "GPT-4.1 mini (fast, cheap, vision)",            maxOutputTokens: 32768 },
      { id: "gpt-4.1-nano",   label: "GPT-4.1 nano (cheapest, fastest)",              maxOutputTokens: 32768 },
    ],
    keyPlaceholder: "sk-…",
    keyHint: "platform.openai.com → API Keys",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    module: Gemini,
    defaultModel: "gemini-2.5-flash",
    models: [
      { id: "gemini-2.5-flash",       label: "Gemini 2.5 Flash (default — balanced, vision + PDF)", maxOutputTokens: 65536 },
      { id: "gemini-2.5-flash-lite",  label: "Gemini 2.5 Flash Lite (fastest, cheapest)",           maxOutputTokens: 65536 },
      { id: "gemini-2.0-flash",       label: "Gemini 2.0 Flash (older, stable)",                    maxOutputTokens: 8192  },
    ],
    keyPlaceholder: "AIza…",
    keyHint: "aistudio.google.com → API key",
  },
};

// Conservative floor when a provider/model entry has no declared cap.
const FALLBACK_MAX_OUTPUT_TOKENS = 4096;

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

// Resolve the active provider+model's output-token ceiling. Reader-style
// callers should pass this as `maxTokens` so they get the full per-model
// budget instead of a one-size-fits-all default that either truncates on
// big models or fails on small ones.
export function getMaxOutputTokens() {
  const provider = activeProvider();
  const modelId = provider.module.getModel ? provider.module.getModel() : provider.defaultModel;
  const entry = (provider.models || []).find((m) => m.id === modelId);
  return (entry && entry.maxOutputTokens) || FALLBACK_MAX_OUTPUT_TOKENS;
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
