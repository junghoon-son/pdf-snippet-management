// AI panel helpers — partial Wave 3 extraction from main.js.
//
// SCOPE: the genuinely self-contained pieces of the AI surface.
//   - aiSetStatus / aiSetBusy: status sink + loading-bar toggle
//   - mergeRectsIntoBands: pure geometry helper for preview rendering
//   - AI Settings modal open/close/dropdown wiring
//
// NOT YET MOVED: aiAsk, acceptAiSuggestion, paintAiPreviews, the suggestion
// drawer renderer. Those have ~20 cross-cutting deps (PDF viewer, layout
// detector, providers, group helpers, undo stack, etc.) and lifting them
// cleanly is a Wave-3-part-2 follow-up. They stay in main.js.
//
// Dependencies injected via setup({...}) so this module doesn't reach
// into main.js's globals.

import {
  getProviderDef,
  getProviderId,
  getProviderModel,
  getProviderHasKey,
} from "./ai/providers.js";

let deps = null;

// Required injection shape:
//   hasConsented, getIncludeFigures — providers/anthropic state accessors
//   isOnnxLayoutEnabled — layout-detector preference accessor
export function setup(injected) {
  deps = injected;
}

// Status sink. Progress chatter goes to the console for debugging;
// the UI only surfaces errors (which the user actually needs to see).
// A separate aiSetBusy() handles the visual "work-in-flight" indicator
// via the loading bar below the ask input.
export function aiSetStatus(msg, state = "idle") {
  if (msg) console.log(`[ai${state === "error" ? ":err" : ""}] ${msg}`);
  const el = document.getElementById("ai-ask-status");
  if (!el) return;
  if (state === "error" && msg) {
    el.textContent = msg;
    el.dataset.state = "error";
    el.hidden = false;
  } else {
    el.textContent = "";
    el.dataset.state = "idle";
    el.hidden = true;
  }
}

// Toggle the indeterminate loading bar under the ask input. Decoupled
// from aiSetStatus so progress chatter and the busy indicator can be
// driven independently (the bar stays on for the whole aiAsk lifecycle,
// regardless of how many intermediate status updates fire).
export function aiSetBusy(busy) {
  const bar = document.getElementById("ai-ask-bar");
  if (bar) bar.classList.toggle("busy", !!busy);
}

// Group rects into vertical bands (one per text line) and union
// horizontally-overlapping or near-adjacent rects within each band.
// Input/output rects use fractional page coords ({left, top, width,
// height} in [0..1]). The PDF text extractor splits a long quote into
// one rect per glyph-run, so adjacent rects on the same line often
// touch or overlap by a hair — when each is rendered with its own
// dashed border, the user sees a fence of vertical lines through the
// highlight. Merging by band collapses each line to a single strip.
export function mergeRectsIntoBands(rects) {
  if (!rects || rects.length <= 1) return rects ? rects.slice() : [];
  // Median rect height drives the "same line" tolerance; tall figure
  // captions stay in their own band, narrow body text bands tightly.
  const heights = rects.map((r) => r.height).filter((h) => h > 0).sort((a, b) => a - b);
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 0.012;
  const yTol = Math.max(medianH * 0.6, 0.002);
  // Sort top-to-bottom, then left-to-right. Each rect joins the first
  // existing band whose vertical center is within yTol, else opens a
  // new band.
  const sorted = [...rects].sort((a, b) => (a.top - b.top) || (a.left - b.left));
  const bands = [];
  for (const r of sorted) {
    const cy = r.top + r.height / 2;
    let band = null;
    for (const b of bands) {
      const bandCy = (b.top + b.bottom) / 2;
      if (Math.abs(cy - bandCy) <= yTol) { band = b; break; }
    }
    if (!band) {
      band = { top: r.top, bottom: r.top + r.height, items: [] };
      bands.push(band);
    } else {
      band.top = Math.min(band.top, r.top);
      band.bottom = Math.max(band.bottom, r.top + r.height);
    }
    band.items.push(r);
  }
  // Horizontal merge within each band. xGapTol allows tiny inter-word
  // gaps to absorb so the dashed border doesn't break for whitespace.
  const xGapTol = 0.006;
  const merged = [];
  for (const b of bands) {
    const byLeft = b.items.sort((a, b2) => a.left - b2.left);
    let cur = null;
    for (const r of byLeft) {
      const right = r.left + r.width;
      if (cur && r.left <= cur.right + xGapTol) {
        cur.right = Math.max(cur.right, right);
        cur.top = Math.min(cur.top, r.top);
        cur.bottom = Math.max(cur.bottom, r.top + r.height);
      } else {
        if (cur) merged.push(cur);
        cur = { left: r.left, right, top: r.top, bottom: r.top + r.height };
      }
    }
    if (cur) merged.push(cur);
  }
  return merged.map((m) => ({
    left: m.left,
    top: m.top,
    width: m.right - m.left,
    height: m.bottom - m.top,
  }));
}

// ── AI Settings modal ────────────────────────────────────────────

export function rebuildAiModelDropdown(providerId) {
  const def = getProviderDef(providerId);
  const sel = document.getElementById("ai-settings-model");
  sel.innerHTML = "";
  for (const m of def.models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    sel.appendChild(opt);
  }
  sel.value = getProviderModel(providerId) || def.defaultModel;
}

export function updateAiKeyFieldForProvider(providerId) {
  const def = getProviderDef(providerId);
  const keyEl = document.getElementById("ai-settings-key");
  const stateEl = document.getElementById("ai-settings-key-state");
  const hintEl = document.getElementById("ai-settings-key-hint");
  keyEl.placeholder = def.keyPlaceholder;
  keyEl.value = getProviderHasKey(providerId) ? "•".repeat(20) : "";
  keyEl.dataset.touched = "";
  stateEl.textContent = getProviderHasKey(providerId) ? "— stored" : "— not set";
  hintEl.innerHTML = `Get a key at <code>${def.keyHint}</code>.`;
}

export function openAiSettings() {
  const { hasConsented, getIncludeFigures, isOnnxLayoutEnabled } = deps;
  const m = document.getElementById("ai-settings-modal");
  m.hidden = false;
  const provId = getProviderId();
  document.getElementById("ai-settings-provider").value = provId;
  rebuildAiModelDropdown(provId);
  updateAiKeyFieldForProvider(provId);
  document.getElementById("ai-settings-consent").checked = hasConsented();
  document.getElementById("ai-settings-figures").checked = getIncludeFigures();
  document.getElementById("ai-settings-onnx").checked = isOnnxLayoutEnabled();
  setTimeout(() => document.getElementById("ai-settings-key").focus(), 0);
}

export function closeAiSettings() {
  document.getElementById("ai-settings-modal").hidden = true;
}
