// Google Gemini client. Mirrors the public surface of anthropic.js +
// openai.js (callMessages, getApiKey, etc.) so the Reader stays
// provider-agnostic. The response is normalized to the Anthropic-shaped
// envelope { content: [{type:"text"|"tool_use", name?, input?}], usage }
// so reader.js doesn't branch on provider.
//
// Differences from the other two providers:
//   - System prompt goes in `systemInstruction`, separate from `contents`.
//   - Roles are "user" / "model" (not "assistant").
//   - Content blocks are `parts`; images + PDFs use `inline_data` with
//     `mime_type`.
//   - Tools wrap function declarations: `tools: [{ functionDeclarations: [...] }]`.
//   - Forced function call via `toolConfig.functionCallingConfig.mode = "ANY"`
//     + `allowedFunctionNames`.

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const PROVIDER_ID = "gemini";
const LEGACY_KEY_STORAGE = "marklee-gemini-key";
const MODEL_STORAGE = "marklee-gemini-model";
const DEFAULT_MODEL = "gemini-3.5-flash";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

let _cachedKey = "";
let _hydrated = false;

async function _invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

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
    console.warn("[gemini] get_provider_key failed:", err);
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
        console.warn("[gemini] legacy key migration failed:", err);
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

// Translate Anthropic-shaped content blocks (text + image + document)
// into Gemini's `parts` shape. Text → { text }; image → { inline_data:
// { mime_type, data } }; document (PDF) → { inline_data: { mime_type:
// "application/pdf", data } } — Gemini accepts PDF natively.
function translateContent(content) {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content || "") }];
  return content.map((block) => {
    if (block.type === "text") return { text: block.text };
    if (block.type === "image" && block.source?.type === "base64") {
      return {
        inline_data: {
          mime_type: block.source.media_type || "image/png",
          data: block.source.data,
        },
      };
    }
    if (block.type === "document" && block.source?.type === "base64") {
      return {
        inline_data: {
          mime_type: block.source.media_type || "application/pdf",
          data: block.source.data,
        },
      };
    }
    return null;
  }).filter(Boolean);
}

// Translate Anthropic-shaped tool definition to Gemini's function
// declaration shape. The JSON Schema for parameters is mostly
// compatible — Gemini accepts standard JSON Schema with type/properties/
// required/enum/items. The Reader tool's schema works directly.
function translateTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  };
}

// Call Gemini's generateContent endpoint. Returns the normalized
// Anthropic-shaped envelope so reader.js doesn't branch on provider.
export async function callMessages({ system, messages, tools, model, maxTokens = 4096 }) {
  const key = getApiKey();
  if (!key) throw new Error("No Gemini API key configured. Open AI settings → API key.");
  const useModel = model || getModel();

  // Map roles: Anthropic uses "assistant", Gemini uses "model".
  const contents = (messages || []).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: translateContent(m.content),
  }));

  const body = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }
  if (tools && tools.length) {
    body.tools = [{ functionDeclarations: tools.map(translateTool) }];
    // Force a tool call when a single tool is provided — same intent as
    // Anthropic's behavior with tools[0] and OpenAI's tool_choice.
    if (tools.length === 1) {
      body.toolConfig = {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: [tools[0].name],
        },
      };
    }
  }

  const url = `${BASE_URL}/${encodeURIComponent(useModel)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch { detail = await res.text().catch(() => ""); }
    throw new Error(`Gemini ${res.status}: ${detail || res.statusText}`);
  }

  const json = await res.json();
  const parts = json.candidates?.[0]?.content?.parts || [];
  const content = [];
  for (const p of parts) {
    if (typeof p.text === "string" && p.text.length) {
      content.push({ type: "text", text: p.text });
    }
    if (p.functionCall) {
      // Gemini returns args as an already-parsed object; OpenAI returns
      // a JSON string. Normalize to object regardless.
      const input = typeof p.functionCall.args === "string"
        ? safeJsonParse(p.functionCall.args)
        : (p.functionCall.args || {});
      content.push({ type: "tool_use", name: p.functionCall.name, input });
    }
  }
  return {
    content,
    usage: {
      input_tokens: json.usageMetadata?.promptTokenCount || 0,
      output_tokens: json.usageMetadata?.candidatesTokenCount || 0,
    },
  };
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
