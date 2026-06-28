// Pure source-kind detection by filename extension.
// Used by main.js (and tested directly by spec/tests/kind-detection.test.js).
// Storage backends (fsa-store.js, tauri-store.js) carry their own subset
// maps because they list documents from disk and exclude formats those
// backends can't store as standalone files.

export const FLOW_EXTS = ["md", "markdown", "txt", "text"];
export const IMAGE_EXTS = ["png", "jpg", "jpeg"];

export function detectKindFromPath(path) {
  const m = (path || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return "pdf";
  const ext = m[1];
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "docx") return "docx";
  if (ext === "txt" || ext === "text") return "text";
  if (IMAGE_EXTS.includes(ext)) return "image";
  return "pdf";
}

// Strip directory components and unsafe characters from an uploaded
// file's name so it can be a flat OPFS key. Collapses path separators,
// drops control/reserved chars, trims dots/spaces, and guarantees a
// non-empty result. Pure — no DOM, no I/O.
export function sanitizeImportName(name) {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  const cleaned = base
    .replace(/[\x00-\x1f<>"|?*]/g, "")
    .replace(/:/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .trim();
  return cleaned || "untitled";
}

// Map a picked/dropped File (or any object with a .name) to the
// {name, kind} descriptor the store import path needs. The store
// supplies the canonical `path`; kind is derived from the sanitized
// name so it matches loadAnyDocument's routing.
export function fileToDescriptor(file) {
  const name = sanitizeImportName(file && file.name);
  return { name, kind: detectKindFromPath(name) };
}
