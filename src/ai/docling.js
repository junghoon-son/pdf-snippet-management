// Docling layout-detection backend.
//
// Talks to a Python subprocess via a Tauri command. The Python side
// (scripts/docling_detect.py) uses IBM's Docling library to extract
// figure / picture / image regions from a PDF and returns normalized
// bboxes per page. JS converts the output into the shape Marklee's
// figure-detection pipeline expects: { page, candidates: [{id, ...}] }.
//
// Dev-only for now. Production bundling depends on whether the
// experiment proves out.

import { invoke } from "@tauri-apps/api/core";

const ENABLED_KEY = "marklee-docling-enabled";
const PYTHON_KEY = "marklee-docling-python";
// In-memory cache so repeat AI queries on the same doc don't re-run
// Docling (it can be slow). Keyed by absolute PDF path. Cleared on
// app restart; could persist to sidecar later if useful.
const cache = new Map();

export function isDoclingEnabled() {
  try { return localStorage.getItem(ENABLED_KEY) === "1"; } catch { return false; }
}
export function setDoclingEnabled(v) {
  try { localStorage.setItem(ENABLED_KEY, v ? "1" : "0"); } catch {}
}
export function getDoclingPython() {
  try { return localStorage.getItem(PYTHON_KEY) || ""; } catch { return ""; }
}
export function setDoclingPython(p) {
  try {
    if (p) localStorage.setItem(PYTHON_KEY, p);
    else localStorage.removeItem(PYTHON_KEY);
  } catch {}
}

export function clearDoclingCache(pdfPath) {
  if (pdfPath) cache.delete(pdfPath);
  else cache.clear();
}

// Run Docling against a PDF path and return per-page figure candidates
// in the shape Marklee's figure-detect pipeline expects:
//   [{ page, candidates: [{ id, left, top, width, height, caption? }] }]
// Throws on failure with a human-readable error message.
export async function runDoclingLayout(pdfPath) {
  if (!pdfPath) throw new Error("No PDF path");
  if (cache.has(pdfPath)) return cache.get(pdfPath);

  const python = getDoclingPython() || "python3";
  let raw;
  try {
    raw = await invoke("run_docling_layout", {
      pdfPath,
      python,
    });
  } catch (err) {
    // Surface stderr from Python — has helpful guidance (e.g.,
    // "docling not installed").
    const msg = String(err || "Docling invocation failed");
    // The Rust side may forward a JSON-wrapped error; try to parse.
    try {
      const parsed = JSON.parse(msg);
      if (parsed && parsed.error) throw new Error(parsed.error);
    } catch (eOuter) {
      if (eOuter instanceof Error && eOuter.message !== msg) throw eOuter;
    }
    throw new Error(msg);
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("Docling returned invalid JSON"); }

  // Convert to Marklee's figure-detection candidate shape. Use sequential
  // letter IDs per page (A, B, C, ...) matching the in-browser detector.
  const out = [];
  for (const pg of (parsed.pages || [])) {
    const candidates = (pg.figures || []).map((f, idx) => ({
      id: String.fromCharCode(65 + idx),
      left: f.bbox.left,
      top: f.bbox.top,
      width: f.bbox.width,
      height: f.bbox.height,
      caption: f.caption || "",
      source: "docling",
    }));
    out.push({ page: pg.page, candidates });
  }
  cache.set(pdfPath, out);
  return out;
}
