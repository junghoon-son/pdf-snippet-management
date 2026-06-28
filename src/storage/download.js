// Browser download glue, split into a pure Blob builder (unit-tested) and
// the DOM trigger (manual-verified). Replaces the desktop-only
// invoke("write_file", ...) path that existed in the Tauri build.

// Normalize whatever a caller hands us (text, ArrayBuffer, typed array, or an
// already-built Blob) into a single Blob tagged with mimeType.
export function buildDownloadBlob({ content, mimeType }) {
  if (content instanceof Blob) return content;
  const type = mimeType || "application/octet-stream";
  if (typeof content === "string") return new Blob([content], { type });
  // ArrayBuffer / TypedArray / DataView all accept being wrapped directly.
  return new Blob([content], { type });
}

// DOM-only: create an object URL, click a temporary <a download>, then revoke.
// Not unit-testable under bun (no DOM) — verified manually.
export function triggerDownload(blob, suggestedName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
