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
const MODEL_STORAGE = "marklee-gemini-model";
const DEFAULT_MODEL = "gemini-3.5-flash";

// Phase 1: AI disabled, no backend — BYOK key store removed (see
// src/ai/anthropic.js for the rationale). Phase 2 supplies credentials via
// the server proxy.
let _cachedKey = "";

export function getApiKey() { return _cachedKey; }
export function hasApiKey() { return !!_cachedKey; }

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
// Gemini's functionDeclaration parameters use an OpenAPI-subset schema that
// does NOT accept `type` as an array — JSON Schema's nullable-union form
// (e.g. ["string","null"]) is rejected. Collapse each such union to a single
// type plus `nullable: true`, recursively (covers nested object props + array
// items). Other keywords (enum, required, properties, items) pass through.
function geminifySchema(node) {
  if (Array.isArray(node)) return node.map(geminifySchema);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "type" && Array.isArray(v)) {
      const nonNull = v.filter((t) => t !== "null");
      out.type = nonNull[0] || "string";
      if (nonNull.length !== v.length) out.nullable = true;
    } else {
      out[k] = geminifySchema(v);
    }
  }
  return out;
}

function translateTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: geminifySchema(tool.input_schema),
  };
}

// Call Gemini's generateContent endpoint. Returns the normalized
// Anthropic-shaped envelope so reader.js doesn't branch on provider.
export async function callMessages({ system, messages, tools, model, maxTokens = 4096 }) {
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

  // Web beta: route through our authenticated proxy (/api/ai/reader), which
  // holds the Gemini key server-side and pins the model. We send the caller's
  // Clerk session token; the proxy rejects anyone not signed in (= not on the
  // allowlist). The `model` arg is intentionally unused — the server pins it.
  const token = await window.Clerk?.session?.getToken?.();
  if (!token) {
    throw new Error("You're signed out — refresh and sign in to use AI.");
  }
  const res = await fetch("/api/ai/reader", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch { detail = await res.text().catch(() => ""); }
    throw new Error(`AI proxy ${res.status}: ${detail || res.statusText}`);
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
