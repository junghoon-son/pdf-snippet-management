// Ollama backend for layout detection — uses IBM granite-docling-258M.
//
// Workflow:
//   1. User installs Ollama (one-click installer, https://ollama.com)
//   2. ollama pull granite-docling   (~150MB, one-time)
//   3. Marklee toggles this backend on
//   4. On AI query: HTTP POST page image to localhost:11434/api/chat
//   5. Parse granite-docling's output for <figure>/<table> bbox tokens
//
// Apache-2.0 throughout — granite-docling-258M (IBM), Ollama (MIT).
// No Python, no AGPL upstream, no per-page hosted cost.

import { invoke } from "@tauri-apps/api/core";

const DEFAULT_ENDPOINT = "http://localhost:11434";
// Granite-Docling 258M lives on Hugging Face, not Ollama's library.
// Ollama can still pull GGUF models from HF via the `hf.co/` prefix.
// The IBM-official GGUF is the canonical source.
const DEFAULT_MODEL = "hf.co/ibm-granite/granite-docling-258M-GGUF";

// Start the bundled Ollama sidecar binary (or no-op if an external
// Ollama is already listening). Returns the spawn status string.
export async function startBundledOllama() {
  try {
    const result = await invoke("start_bundled_ollama");
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Best-effort stop. Called at app shutdown.
export async function stopBundledOllama() {
  try { await invoke("stop_bundled_ollama"); } catch {}
}

// Wait until Ollama answers (HTTP 200 on /api/tags), up to `timeoutMs`.
export async function waitForOllamaReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const base = getOllamaEndpoint();
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/tags`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Load the configured model into VRAM so the first real query doesn't
// pay cold-start. Ollama's /api/generate with empty prompt + long
// keep_alive triggers a load-only path: no tokens generated, just the
// weights resident. Safe to call any time after Ollama is responding.
//
// Best-effort — silently no-ops on failure (model not pulled, network
// hiccup, etc.). Real queries will still work because they go through
// the chat endpoint which loads on demand.
export async function prewarmOllamaModel() {
  const base = getOllamaEndpoint();
  const model = getOllamaModel();
  try {
    const exists = await modelReallyExists(model);
    if (!exists) {
      console.log("[ollama] prewarm skipped — model not pulled yet:", model);
      return { prewarmed: false, reason: "not-pulled" };
    }
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "",          // empty → load-only, no inference
        keep_alive: "1h",    // resident for an hour of idle
        stream: false,
      }),
    });
    if (!res.ok) {
      console.warn("[ollama] prewarm failed:", res.status, await res.text().catch(() => ""));
      return { prewarmed: false, reason: `http-${res.status}` };
    }
    console.log("[ollama] prewarmed", model);
    return { prewarmed: true };
  } catch (err) {
    console.warn("[ollama] prewarm error:", err);
    return { prewarmed: false, reason: String(err) };
  }
}

// Pull a model via the Ollama HTTP API. Streams progress events back to
// the caller via `onProgress({ status, completed, total })`. Throws if
// the stream ends without a "success" event (catches the "model name
// doesn't exist" silent-fail case where Ollama returns 200 + empty body).
export async function pullOllamaModel(modelName, onProgress) {
  const base = getOllamaEndpoint();
  const res = await fetch(`${base}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: modelName, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`pull failed: HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lineCount = 0;
  let sawSuccess = false;
  let lastStatus = "";
  let lastError = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      lineCount++;
      try {
        const obj = JSON.parse(line);
        console.log("[ollama-pull]", obj);
        onProgress?.(obj);
        if (obj.status) lastStatus = obj.status;
        if (obj.error) {
          lastError = obj.error;
          throw new Error(obj.error);
        }
        if (obj.status === "success") sawSuccess = true;
      } catch (parseErr) {
        if (lastError) throw parseErr;
        // Non-JSON lines ignored.
      }
    }
  }

  // Verify the model actually landed regardless of whether we saw a
  // "success" event. Some Ollama versions (and HF pulls in particular)
  // omit the success line but the model IS present afterward. Poll a
  // few times since the manifest write can lag the stream end.
  for (let i = 0; i < 6; i++) {
    if (await modelReallyExists(modelName)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    lineCount === 0
      ? `Pull returned no progress events — is "${modelName}" a valid name? Try: ollama pull ${modelName} in a terminal.`
      : `Pull stream ended but model "${modelName}" isn't registered. Last status: "${lastStatus}". ${lastError || ""}`
  );
}

// Definitive check: GET /api/show on the model. Returns 200 only if the
// model is fully registered + has a usable manifest. More reliable than
// /api/tags which can lag.
async function modelReallyExists(modelName) {
  const base = getOllamaEndpoint();
  try {
    const res = await fetch(`${base}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: modelName }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const ENABLED_KEY = "marklee-ollama-enabled";
const ENDPOINT_KEY = "marklee-ollama-endpoint";
const MODEL_KEY = "marklee-ollama-model";

export function isOllamaEnabled() {
  try { return localStorage.getItem(ENABLED_KEY) === "1"; } catch { return false; }
}
export function setOllamaEnabled(v) {
  try { localStorage.setItem(ENABLED_KEY, v ? "1" : "0"); } catch {}
}
export function getOllamaEndpoint() {
  try { return localStorage.getItem(ENDPOINT_KEY) || DEFAULT_ENDPOINT; }
  catch { return DEFAULT_ENDPOINT; }
}
export function setOllamaEndpoint(v) {
  try {
    if (v && v !== DEFAULT_ENDPOINT) localStorage.setItem(ENDPOINT_KEY, v);
    else localStorage.removeItem(ENDPOINT_KEY);
  } catch {}
}
export function getOllamaModel() {
  try {
    const stored = localStorage.getItem(MODEL_KEY);
    // Migrate the old default ("granite-docling") which doesn't exist
    // in Ollama's library — point to the HF GGUF that actually pulls.
    if (stored === "granite-docling") return DEFAULT_MODEL;
    return stored || DEFAULT_MODEL;
  } catch { return DEFAULT_MODEL; }
}
export function setOllamaModel(v) {
  try {
    if (v && v !== DEFAULT_MODEL) localStorage.setItem(MODEL_KEY, v);
    else localStorage.removeItem(MODEL_KEY);
  } catch {}
}

// Probe Ollama at the configured endpoint. Returns {available, hasModel,
// models, error}. The settings UI uses this to render a status badge.
export async function checkOllamaStatus() {
  const base = getOllamaEndpoint();
  const wantModel = getOllamaModel();
  try {
    const res = await fetch(`${base}/api/tags`);
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name || "");
    const hasModel = models.some((n) =>
      n === wantModel || n.startsWith(`${wantModel}:`)
    );
    return { available: true, hasModel, models };
  } catch (err) {
    return { available: false, error: err.message || String(err) };
  }
}

// Cache per-doc detection (keyed by content hash).
const cache = new Map();
export function clearOllamaCache(key) {
  if (key) cache.delete(key);
  else cache.clear();
}

// Pick a prompt based on the model name. granite-docling responds best
// to its canonical training instruction ("Convert this page to docling.")
// — that's the exact task it was fine-tuned on, and it outputs the
// full docling-tag structure with location tokens. Custom phrasings
// like "identify figures with bboxes" underperform on this model.
//
// Generic vision-LMs (qwen2-vl, moondream, etc.) don't know docling
// tags, so they get a JSON-output instruction instead.
function buildPrompt(modelName) {
  if (/granite-docling/i.test(modelName)) {
    return "Convert this page to docling.";
  }
  return [
    "You are a document layout analyzer. Look at this page image and output ONLY a JSON array.",
    "",
    "For every figure, table, chart, or picture you can clearly see, output one object:",
    '{"kind": "figure" | "table" | "chart" | "picture", "left": <0-1>, "top": <0-1>, "width": <0-1>, "height": <0-1>, "caption": "<short>"}',
    "",
    "Rules:",
    "- Coordinates are fractions of the page (0..1), top-left origin.",
    "- Bounding box should enclose the figure body — exclude the caption text.",
    "- If no figures/tables are present, output an empty array: []",
    "- Output the JSON array ONLY. No prose, no markdown fences.",
  ].join("\n");
}

const CONCURRENCY = 1; // sequential — avoids cold-start races and gives stable detection per page

// Run the selected Ollama vision model against each pre-rendered page
// image. Pages are pipelined with a concurrency limit so the GPU stays
// fed; the underlying Ollama server is configured to accept 4 parallel
// requests with model kept warm between calls.
export async function runOllamaLayout(pageImages, cacheKey, onProgress) {
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);
  const base = getOllamaEndpoint();
  const model = getOllamaModel();
  const prompt = buildPrompt(model);

  const results = new Array(pageImages.length);
  let nextIdx = 0;
  let completed = 0;
  const total = pageImages.length;

  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= total) return;
      const pg = pageImages[i];
      let detections = [];
      try {
        const res = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{
              role: "user",
              content: prompt,
              images: [pg.base64],
            }],
            stream: false,
            options: { temperature: 0 },
            keep_alive: "5m",  // keep model loaded between page calls
            format: /granite-docling/i.test(model) ? undefined : "json",
          }),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`Ollama ${res.status}: ${errText.slice(0, 200)}`);
        }
        const data = await res.json();
        const content = data.message?.content || "";
        detections = parseLayoutOutput(content);
        if (detections.length === 0 && content) {
          console.warn(`[ollama] page ${pg.page} raw response (no detections parsed):`,
            content.slice(0, 500));
        }
      } catch (err) {
        console.warn(`[ollama] page ${pg.page} failed:`, err);
      }
      const candidates = detections.map((d, idx) => ({
        id: String.fromCharCode(65 + idx),
        left: d.left,
        top: d.top,
        width: d.width,
        height: d.height,
        kind: d.kind,
        caption: d.caption || "",
        source: "ollama",
      }));
      results[i] = { page: pg.page, candidates };
      console.log(`[ollama] page ${pg.page}: ${candidates.length} candidate(s)`,
        candidates.length === 0 ? "(empty — raw response logged below)" : "");
      completed++;
      onProgress?.(completed, total, pg.page);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker());
  await Promise.all(workers);

  if (cacheKey) cache.set(cacheKey, results);
  return results;
}

// Dispatch parser — tries JSON first, falls back to granite-docling's
// token soup. The two output formats don't overlap, so order is safe.
function parseLayoutOutput(text) {
  if (!text) return [];
  const json = parseJsonLayoutOutput(text);
  if (json.length) return json;
  return parseGraniteDoclingOutput(text);
}

// Tolerant JSON extractor: vision-LMs sometimes wrap output in code
// fences, prefix it with explanation, or emit `{detections: [...]}`
// instead of a bare array. We find the first array-of-objects in the
// response and normalize each item to {kind, left, top, width, height}.
function parseJsonLayoutOutput(text) {
  // Strip code fences if present.
  let body = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1").trim();
  // Find the first JSON array.
  const arrMatch = body.match(/\[\s*(?:\{[\s\S]*?\}\s*,?\s*)*\]/);
  let candidate = null;
  if (arrMatch) candidate = arrMatch[0];
  else {
    // Some models wrap in an object — try whole-body parse.
    try {
      const obj = JSON.parse(body);
      if (Array.isArray(obj)) candidate = body;
      else if (obj && Array.isArray(obj.detections)) candidate = JSON.stringify(obj.detections);
      else if (obj && Array.isArray(obj.figures))    candidate = JSON.stringify(obj.figures);
      else if (obj && Array.isArray(obj.results))    candidate = JSON.stringify(obj.results);
    } catch {}
  }
  if (!candidate) return [];
  let arr;
  try { arr = JSON.parse(candidate); }
  catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeJsonItem).filter(Boolean);
}

// Normalize a single bbox object from various conventions.
function normalizeJsonItem(item) {
  if (!item || typeof item !== "object") return null;
  const kind = String(item.kind || item.type || item.label || "figure").toLowerCase();
  if (!/figure|table|chart|picture|image|plot|diagram/.test(kind)) return null;

  let left, top, width, height;
  if (typeof item.left === "number" && typeof item.width === "number") {
    left = item.left; top = item.top; width = item.width; height = item.height;
  } else if (typeof item.x === "number" && typeof item.w === "number") {
    left = item.x; top = item.y; width = item.w; height = item.h;
  } else if (typeof item.x1 === "number" && typeof item.x2 === "number") {
    left = item.x1; top = item.y1; width = item.x2 - item.x1; height = item.y2 - item.y1;
  } else if (Array.isArray(item.bbox) && item.bbox.length === 4) {
    const [a, b, c, d] = item.bbox;
    // If the last two look like sizes (smaller than the first two when
    // the first two are also small), treat as [x, y, w, h]; otherwise
    // [x1, y1, x2, y2].
    if (c <= 1 && d <= 1 && a + c <= 1.05 && b + d <= 1.05 && c < 1 - a + 0.05) {
      left = a; top = b; width = c; height = d;
    } else {
      left = Math.min(a, c); top = Math.min(b, d);
      width = Math.abs(c - a); height = Math.abs(d - b);
    }
  } else {
    return null;
  }

  // If values look like pixel coords, normalize. Heuristic: any value > 2
  // means we're in pixel-space; divide by the likely page size.
  const m = Math.max(left + width, top + height);
  if (m > 2) {
    // Assume image grid 0-1000 most common; 0-500 for siglip-512 models.
    const divisor = m > 600 ? 1000 : 500;
    left /= divisor; top /= divisor; width /= divisor; height /= divisor;
  }

  // Clamp + sanity check.
  if (!Number.isFinite(left) || !Number.isFinite(top) ||
      !Number.isFinite(width) || !Number.isFinite(height)) return null;
  left = Math.max(0, Math.min(1, left));
  top = Math.max(0, Math.min(1, top));
  width = Math.max(0, Math.min(1 - left, width));
  height = Math.max(0, Math.min(1 - top, height));
  if (width < 0.01 || height < 0.01) return null;
  if (width > 0.99 && height > 0.99) return null; // ignore whole-page

  // Canonical kind: collapse synonyms into figure/table/chart/picture.
  let canonical = "figure";
  if (kind.includes("table")) canonical = "table";
  else if (kind.includes("chart") || kind.includes("plot") || kind.includes("diagram")) canonical = "chart";
  else if (kind.includes("picture") || kind.includes("image") || kind.includes("photo")) canonical = "picture";
  else if (kind.includes("figure")) canonical = "figure";

  return { kind: canonical, left, top, width, height };
}

// Parse granite-docling's structured output. The model emits XML-like
// element tags with location tokens, e.g.:
//   <figure><loc_120><loc_200><loc_450><loc_380>caption text</figure>
//   <picture><loc_...></picture>
//   <otsl><loc_...>...</otsl>          // OTSL is granite's table format
//   <chart><loc_...></chart>
//
// Location tokens are integer 0..499 mapping to fractional position
// on the model's input image (512×512 siglip).
//
// We extract figure-ish tags. The mapping of tag → canonical kind:
//   figure / picture / image / illustration / photo → "figure"
//   chart / plot / diagram / graph                  → "chart"
//   table / otsl                                    → "table"
//
// Tags NOT extracted (intentionally): text, paragraph, title,
// section_header, page_header, page_footer, list_item, caption,
// formula, code — these are layout regions but not visually-distinct
// figures we'd want to highlight as image snippets.
const FIGURE_TAG_MAP = {
  figure: "figure",
  picture: "figure",
  image: "figure",
  illustration: "figure",
  photo: "figure",
  chart: "chart",
  plot: "chart",
  diagram: "chart",
  graph: "chart",
  table: "table",
  otsl: "table",
};

function parseGraniteDoclingOutput(text) {
  if (!text) return [];
  const out = [];
  const tagAlt = Object.keys(FIGURE_TAG_MAP).join("|");
  // Capture: tag name, 4 location tokens (the element's bbox), then
  // everything up to the closing tag. The trailing slice contains the
  // caption text (possibly with nested loc tokens for sub-elements).
  const pattern = new RegExp(
    `<(${tagAlt})\\b[^>]*>\\s*<loc_(\\d+)><loc_(\\d+)><loc_(\\d+)><loc_(\\d+)>([\\s\\S]*?)</\\1>`,
    "gi"
  );
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const [, rawKind, x1, y1, x2, y2, inner] = m;
    const kind = FIGURE_TAG_MAP[rawKind.toLowerCase()] || "figure";
    const v1 = parseInt(x1, 10) / 500;
    const v2 = parseInt(y1, 10) / 500;
    const v3 = parseInt(x2, 10) / 500;
    const v4 = parseInt(y2, 10) / 500;
    const left = Math.max(0, Math.min(1, Math.min(v1, v3)));
    const top = Math.max(0, Math.min(1, Math.min(v2, v4)));
    const width = Math.max(0, Math.min(1 - left, Math.abs(v3 - v1)));
    const height = Math.max(0, Math.min(1 - top, Math.abs(v4 - v2)));
    if (width > 0.01 && height > 0.01) {
      // Extract caption: strip nested loc tokens + inner tags from the
      // captured text. Whatever's left is human-readable caption text.
      const caption = (inner || "")
        .replace(/<loc_\d+>/g, "")
        .replace(/<\/?[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200); // cap so we don't blow up the prompt
      out.push({ kind, left, top, width, height, caption });
    }
  }
  return out;
}
