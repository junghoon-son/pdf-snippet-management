// ONNX RT-DETR layout detector — bundled-in-Rust path.
//
// Calls Tauri's detect_page_layout command which runs Kreuzberg's
// Apache-2.0 RT-DETR model via ort. First call downloads the model
// (~150 MB) into the app data dir. Subsequent calls reuse the
// resident ort::Session.
//
// Returns figure candidates in Marklee's standard shape so it slots
// into aiAsk as a backend option alongside Ollama / built-in.

import { invoke } from "@tauri-apps/api/core";

const ENABLED_KEY = "marklee-onnx-layout-enabled";
const cache = new Map();

export function isOnnxLayoutEnabled() {
  try { return localStorage.getItem(ENABLED_KEY) === "1"; } catch { return false; }
}
export function setOnnxLayoutEnabled(v) {
  try { localStorage.setItem(ENABLED_KEY, v ? "1" : "0"); } catch {}
}
export function clearOnnxLayoutCache(key) {
  if (key) cache.delete(key);
  else cache.clear();
}

// Run RT-DETR on each pre-rendered page image. Pages process
// sequentially through the same ort session (which holds the model
// resident in memory after first call). Per-doc cache so repeat
// queries on the same content hash skip re-inference.
export async function runOnnxLayout(pageImages, cacheKey, onProgress) {
  // Cache disabled during ONNX bring-up — re-infer every call so coord
  // fixes apply without per-doc cache reset.
  // if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);
  const out = [];
  for (let i = 0; i < pageImages.length; i++) {
    const pg = pageImages[i];
    onProgress?.(i + 1, pageImages.length, pg.page);
    let detections = [];
    try {
      detections = await invoke("detect_page_layout", { imageBase64: pg.base64 });
    } catch (err) {
      console.warn(`[onnx] page ${pg.page} failed:`, err);
    }
    const candidates = (detections || []).map((d, idx) => ({
      id: String.fromCharCode(65 + idx),
      left: d.left,
      top: d.top,
      width: d.width,
      height: d.height,
      kind: d.kind,
      confidence: d.confidence,
      label: d.class_label,
      source: "onnx",
    }));
    out.push({ page: pg.page, candidates });
  }
  if (cacheKey) cache.set(cacheKey, out);
  return out;
}
