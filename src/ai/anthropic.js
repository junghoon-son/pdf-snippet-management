// Minimal Anthropic Messages API client for Marklee.
//
// API key is stored encrypted at rest via the Rust-side commands
// set_provider_key / get_provider_key (AES-256-GCM with a machine-
// bound key — see src-tauri/src/secrets.rs). An in-memory cache
// keeps getApiKey() / hasApiKey() synchronous; main.js awaits
// initApiKeyStore() at startup before any AI UI is reachable.

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const PROVIDER_ID = "anthropic";
const LEGACY_KEY_STORAGE = "marklee-anthropic-key"; // pre-encryption plaintext
const MODEL_STORAGE = "marklee-anthropic-model";
const CONSENT_STORAGE = "marklee-ai-consent";
const FIGURES_STORAGE = "marklee-ai-figures";
const DEFAULT_MODEL = "claude-sonnet-4-6";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

let _cachedKey = "";
let _hydrated = false;

async function _invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// Called once from main.js startup. Hydrates the in-memory cache from
// the encrypted store, migrating any pre-encryption plaintext key from
// localStorage on first run.
export async function initApiKeyStore() {
  if (_hydrated) return;
  _hydrated = true;
  if (!IS_TAURI) {
    // Dev web preview only — no encrypted store available.
    try { _cachedKey = localStorage.getItem(LEGACY_KEY_STORAGE) || ""; } catch {}
    return;
  }
  let k = "";
  try {
    k = (await _invoke("get_provider_key", { provider: PROVIDER_ID })) || "";
  } catch (err) {
    console.warn("[anthropic] get_provider_key failed:", err);
  }
  if (!k) {
    let legacy = "";
    try { legacy = localStorage.getItem(LEGACY_KEY_STORAGE) || ""; } catch {}
    if (legacy) {
      try {
        await _invoke("set_provider_key", { provider: PROVIDER_ID, key: legacy });
        try { localStorage.removeItem(LEGACY_KEY_STORAGE); } catch {}
        k = legacy;
      } catch (err) {
        console.warn("[anthropic] legacy key migration failed:", err);
      }
    }
  }
  _cachedKey = k;
}

export function getApiKey() { return _cachedKey; }
export function hasApiKey() { return !!_cachedKey; }

export async function setApiKey(key) {
  const v = key || "";
  if (!IS_TAURI) {
    try {
      if (v) localStorage.setItem(LEGACY_KEY_STORAGE, v);
      else localStorage.removeItem(LEGACY_KEY_STORAGE);
    } catch {}
    _cachedKey = v;
    return;
  }
  await _invoke("set_provider_key", { provider: PROVIDER_ID, key: v });
  _cachedKey = v;
}

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
