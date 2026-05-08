// Marklee Permalink — wire form of a snippet anchor as a URL.
// See SPEC.md §6.

const PERMALINK_BASE = "https://marklee.dev/v";

// Browsers: encode UTF-8 → bytes → base64 → url-safe (RFC 4648 §5, no padding).
function base64url(input) {
  if (input == null || input === "") return "";
  const bytes = new TextEncoder().encode(String(input));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlDecode(s) {
  if (!s) return "";
  let pad = s + "===".slice((s.length + 3) % 4);
  pad = pad.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Build a Marklee Permalink for one snippet.
// `opts.includeText` defaults to true (resilient anchoring). Set false for
// the privacy-minimal form — see SPEC.md §6.3.
// Image snippets follow §6.1.1 and emit `kind=image&page=N&rect=L,T,W,H`
// (plus optional clipUrl / clipHash) instead of text/context fields.
export function buildPermalink(snippet, source, opts = {}) {
  const includeText = opts.includeText !== false;
  const base = opts.base || PERMALINK_BASE;
  const params = new URLSearchParams();

  const hash = source?.contentHash || "";
  if (hash) params.set("hash", hash.replace(/^sha256:/, ""));

  if (opts.src) params.set("src", opts.src);
  else if (source?.path && /^https?:/.test(source.path)) params.set("src", source.path);

  if (typeof snippet.page === "number" && snippet.page >= 1) params.set("page", String(snippet.page));

  if (snippet.kind === "image") {
    params.set("kind", "image");
    const rect = (snippet.rects && snippet.rects[0]) || null;
    if (rect) {
      const fmt = (n) => Number(n).toFixed(5).replace(/\.?0+$/, "");
      params.set("rect", `${fmt(rect.left)},${fmt(rect.top)},${fmt(rect.width)},${fmt(rect.height)}`);
    }
    if (snippet.clipUrl) params.set("clipUrl", snippet.clipUrl);
    if (snippet.clipHash) params.set("clipHash", snippet.clipHash.replace(/^sha256:/, ""));
    if (includeText && snippet.text) params.set("text", base64url(snippet.text));
  } else {
    if (snippet.anchor) params.set("anchor", snippet.anchor);
    if (typeof snippet.flowPos === "number") params.set("flowPos", String(snippet.flowPos));
    if (includeText) {
      const norm = snippet.textNormalized || snippet.text || "";
      if (norm) params.set("text", base64url(norm));
      if (snippet.contextBefore) params.set("cb", base64url(snippet.contextBefore));
      if (snippet.contextAfter) params.set("ca", base64url(snippet.contextAfter));
    }
  }

  if (snippet.id) params.set("id", snippet.id);

  return `${base}?${params.toString()}`;
}

// Parse a Marklee Permalink (or its query string) into a snippet-shaped
// anchor + the source descriptor. Returns null on no match.
export function parsePermalink(input) {
  if (!input) return null;
  let qs;
  try {
    if (input.startsWith("?")) qs = input.slice(1);
    else if (input.includes("?")) qs = new URL(input).search.slice(1);
    else qs = input;
  } catch {
    return null;
  }
  const params = new URLSearchParams(qs);
  if (!params.has("hash") && !params.has("text") && !params.has("id")) return null;

  const kind = params.get("kind") === "image" ? "image" : "text";
  const snippet = {
    id: params.get("id") || null,
    kind,
    page: params.has("page") ? parseInt(params.get("page"), 10) : null,
  };
  if (kind === "image") {
    const rectStr = params.get("rect");
    if (rectStr) {
      const [left, top, width, height] = rectStr.split(",").map(Number);
      if ([left, top, width, height].every((n) => Number.isFinite(n))) {
        snippet.rects = [{ left, top, width, height }];
      }
    }
    snippet.clipUrl = params.get("clipUrl") || null;
    snippet.clipHash = params.get("clipHash") || null;
    snippet.text = params.has("text") ? base64urlDecode(params.get("text")) : "";
  } else {
    snippet.anchor = params.get("anchor") || null;
    snippet.flowPos = params.has("flowPos") ? parseInt(params.get("flowPos"), 10) : null;
    snippet.text = params.has("text") ? base64urlDecode(params.get("text")) : "";
    snippet.contextBefore = params.has("cb") ? base64urlDecode(params.get("cb")) : "";
    snippet.contextAfter = params.has("ca") ? base64urlDecode(params.get("ca")) : "";
  }
  return {
    src: params.get("src") || null,
    hash: params.get("hash") || null,
    snippet,
  };
}
