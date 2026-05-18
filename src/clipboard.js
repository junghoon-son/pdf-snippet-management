// Clipboard paste-as-snippet helpers — extracted from main.js (Wave 3).
//
// Two entry points: createPastedTextSnippet (from any text clipboard
// payload) and createPastedImageSnippet (from a clipboard image blob).
// Both push into state.workspace.pastedSnippets, the workspace-level
// "free-floating" snippet bucket (Marklee SPEC §2.8 notes, mapped to
// the implementation's pastedSnippets array).
//
// PASTED_PSEUDO_PATH is the pseudo-source path used to identify pasted
// snippets in lineage / map / workspace views (rendered as "📋 Pasted").
// It is never written to disk; the marker lives in localStorage only.
//
// The DOM paste event handler stays in main.js (binds to document).

import { normalizeText } from "./flow-viewer.js";

export const PASTED_PSEUDO_PATH = "marklee:pasted";

// Tauri-resolved on-disk placeholder doc used as the storage anchor for
// pasted image clips (~/.marklee/clipboard). Cached per session to skip
// the Tauri invoke after the first call.
let _clipboardDocPath = null;

// Dependencies injected by main.js once at boot. Keeping them in a
// closure-scoped object (rather than direct imports) lets this module
// avoid pulling in main.js's massive transitive surface during testing
// or future tree-shaking work.
let deps = null;

export function setup(injected) {
  deps = injected;
}

export async function getClipboardDocPath() {
  if (_clipboardDocPath) return _clipboardDocPath;
  if (!deps?.IS_TAURI) return null; // FSA mode unsupported for now
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    _clipboardDocPath = await invoke("clipboard_doc_path");
    return _clipboardDocPath;
  } catch (err) {
    console.warn("[clipboard] couldn't resolve clipboard doc path", err);
    return null;
  }
}

export async function createPastedTextSnippet(text) {
  const { state, saveAllWorkspaces, refreshActiveView, flashSaveIndicator } = deps;
  if (!Array.isArray(state.workspace.pastedSnippets)) state.workspace.pastedSnippets = [];
  const snippet = {
    id: crypto.randomUUID(),
    kind: "text",
    page: 1,
    text,
    textNormalized: normalizeText(text),
    rects: [],
    comment: "",
    created: new Date().toISOString(),
    groups: [],
    anchor: "pasted",
  };
  state.workspace.pastedSnippets.push(snippet);
  saveAllWorkspaces();
  refreshActiveView();
  flashSaveIndicator("saved");
}

export async function createPastedImageSnippet(bytes, _mime) {
  // Pasted image clips go to ~/.marklee/.clipboard.clips/ via the
  // placeholder clipboard doc — workspace-agnostic, no open document
  // required. The snippet records the placeholder path so the loader
  // can resolve the bytes later.
  const { state, getStore, saveAllWorkspaces, refreshActiveView, flashSaveIndicator } = deps;
  const clipboardDoc = await getClipboardDocPath();
  if (!clipboardDoc) {
    flashSaveIndicator("error");
    console.warn("[paste] image paste needs Tauri (clipboard storage)");
    return;
  }
  if (!Array.isArray(state.workspace.pastedSnippets)) state.workspace.pastedSnippets = [];
  const id = crypto.randomUUID();
  let imagePath;
  try {
    imagePath = await getStore().writeClip(clipboardDoc, id, bytes);
  } catch (err) {
    console.error("[paste] writeClip failed", err);
    return;
  }
  const snippet = {
    id,
    kind: "image",
    page: 1,
    text: "Pasted image",
    rects: [],
    imagePath,
    _imageOwnerPath: clipboardDoc,
    comment: "",
    created: new Date().toISOString(),
    groups: [],
    anchor: "pasted",
  };
  state.workspace.pastedSnippets.push(snippet);
  saveAllWorkspaces();
  refreshActiveView();
  flashSaveIndicator("saved");
}
