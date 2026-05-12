// OpenAI Chat Completions client. Mirrors the public surface of
// anthropic.js (callMessages, getApiKey, etc.) so the Reader can stay
// provider-agnostic. The response is normalized to the Anthropic-shaped
// envelope { content: [{type:"tool_use", name, input}], usage } so
// reader.js doesn't branch on provider.

const API_URL = "https://api.openai.com/v1/chat/completions";
const PROVIDER_ID = "openai";
const LEGACY_KEY_STORAGE = "marklee-openai-key"; // pre-encryption plaintext
const MODEL_STORAGE = "marklee-openai-model";
const DEFAULT_MODEL = "gpt-4o";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

let _cachedKey = "";
let _hydrated = false;

async function _invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// See src/ai/anthropic.js — same pattern. Hydrates the in-memory key
// cache from the encrypted store on startup, migrating any plaintext
// localStorage holdover from earlier versions.
export async function initApiKeyStore() {
  if (_hydrated) return;
  _hydrated = true;
  if (!IS_TAURI) {
    try { _cachedKey = localStorage.getItem(LEGACY_KEY_STORAGE) || ""; } catch {}
    return;
  }
  let k = "";
  try {
    k = (await _invoke("get_provider_key", { provider: PROVIDER_ID })) || "";
  } catch (err) {
    console.warn("[openai] get_provider_key failed:", err);
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
        console.warn("[openai] legacy key migration failed:", err);
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

// Translate Anthropic-shaped content blocks (text + image) into the
// OpenAI shape: text → {type:"text", text}; image → {type:"image_url",
// image_url:{url:"data:image/<media_type>;base64,<data>"}}.
function translateContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image" && block.source?.type === "base64") {
      const media = block.source.media_type || "image/png";
      return {
        type: "image_url",
        image_url: { url: `data:${media};base64,${block.source.data}` },
      };
    }
    return null;
  }).filter(Boolean);
}

// Translate Anthropic-shaped tool definition to OpenAI function schema.
function translateTool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

// Call OpenAI Chat Completions with optional tool/function calling.
// Returns a normalized envelope shaped like Anthropic's response so
// reader.js can use the same parser:
//   { content: [{type:"text"|"tool_use", text?|input?|name?}], usage }
export async function callMessages({ system, messages, tools, model, maxTokens = 4096 }) {
  const key = getApiKey();
  if (!key) throw new Error("No OpenAI API key configured. Open AI settings → API key.");

  const oaiMessages = [];
  if (system) oaiMessages.push({ role: "system", content: system });
  for (const m of (messages || [])) {
    oaiMessages.push({ role: m.role, content: translateContent(m.content) });
  }

  const body = {
    model: model || getModel(),
    messages: oaiMessages,
    max_tokens: maxTokens,
  };
  if (tools && tools.length) {
    body.tools = tools.map(translateTool);
    // Force the function call when a single tool is provided — same as
    // Anthropic's behavior with tools[0].
    if (tools.length === 1) {
      body.tool_choice = { type: "function", function: { name: tools[0].name } };
    }
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch { detail = await res.text().catch(() => ""); }
    throw new Error(`OpenAI ${res.status}: ${detail || res.statusText}`);
  }

  const json = await res.json();
  const msg = json.choices?.[0]?.message;
  const content = [];
  if (msg?.content) content.push({ type: "text", text: msg.content });
  for (const tc of (msg?.tool_calls || [])) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
    content.push({ type: "tool_use", name: tc.function?.name, input });
  }
  return {
    content,
    usage: {
      input_tokens: json.usage?.prompt_tokens || 0,
      output_tokens: json.usage?.completion_tokens || 0,
    },
  };
}
