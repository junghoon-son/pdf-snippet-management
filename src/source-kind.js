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
