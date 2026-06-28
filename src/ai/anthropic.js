// Minimal Anthropic Messages API client for Marklee.
//
// Phase 1 (browser-only shell) has no backend and AI is disabled, so the
// key store is gone. callMessages() and the request-building code below
// are kept intact for Phase 2, where credentials arrive via a server proxy
// rather than BYOK. getApiKey()/hasApiKey() report an empty in-memory cache.

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const MODEL_STORAGE = "marklee-anthropic-model";
const CONSENT_STORAGE = "marklee-ai-consent";
const FIGURES_STORAGE = "marklee-ai-figures";
const DEFAULT_MODEL = "claude-sonnet-4-6";

// Phase 1: AI is disabled (see src/ai/feature-flags.js) and there is no
// backend yet, so the BYOK key surface is gone. The in-memory cache stays
// empty; Phase 2 will supply credentials via the server proxy. The legacy
// Tauri set_provider_key / get_provider_key paths and the localStorage
// fallback were removed.
let _cachedKey = "";

export function getApiKey() { return _cachedKey; }
export function hasApiKey() { return !!_cachedKey; }

export function getModel() {
  try { return localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL; } catch { return DEFAULT_MODEL; }
}
export function setModel(m) {
  try { localStorage.setItem(MODEL_STORAGE, m || DEFAULT_MODEL); } catch {}
}

export function hasConsented() {
  try { return localStorage.getItem(CONSENT_STORAGE) === "1"; } catch { return false; }
}
export function setConsented(v) {
  try { localStorage.setItem(CONSENT_STORAGE, v ? "1" : "0"); } catch {}
}

export function getIncludeFigures() {
  try { return localStorage.getItem(FIGURES_STORAGE) === "1"; } catch { return false; }
}
export function setIncludeFigures(v) {
  try { localStorage.setItem(FIGURES_STORAGE, v ? "1" : "0"); } catch {}
}

// Call the Messages API with optional tool definitions. Returns the raw
// response JSON (caller picks fields). Throws on non-2xx with the API
// error body included.
export async function callMessages({ system, messages, tools, model, maxTokens = 4096 }) {
  const key = getApiKey();
  if (!key) throw new Error("No Anthropic API key configured. Open Settings → API key.");
  const body = {
    model: model || getModel(),
    max_tokens: maxTokens,
    system,
    messages,
  };
  if (tools && tools.length) body.tools = tools;

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": API_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch { detail = await res.text().catch(() => ""); }
    throw new Error(`Anthropic ${res.status}: ${detail || res.statusText}`);
  }
  return await res.json();
}
