// Persistence layer — extracted from main.js (Wave 3).
//
// Owns the debounced sidecar-write pipeline, the optimistic-mtime
// concurrency check (Wave 2), and the orphan-group prune. Designed so
// every doc edit calls `persist()` and the module collapses bursts
// into a single write 200ms after the last call.
//
// Dependencies are injected via setup({...}) so this module never
// reaches into main.js's globals — keeps the extraction reversible and
// tests possible.

const PERSIST_DEBOUNCE_MS = 200;

let deps = null;
let _persistPending = null;
let _persistResolve = null;
let _persistReject = null;
let _persistTimer = null;

// Required injection shape:
//   state — the live state object (currentPdfPath, snippets, edges,
//           groupsMeta, source, sidecarMtimeMs, view).
//   getStore — () => activeStore (must implement writeAnnot).
//   mapView — the MapView module (getEdgesData, getNodePositions); only
//             read when state.view === "map".
//   saveAllWorkspaces — () => void, persists workspace metadata.
//   flashSaveIndicator — (state) => void, "saving" | "saved" | "error".
//   reloadDocument — async (path) => void, used by conflict-handler reload.
export function setup(injected) {
  deps = injected;
  window.addEventListener("beforeunload", () => {
    // Best-effort flush on unload — synchronous localStorage writes
    // (inside saveAllWorkspaces) get through; the async sidecar write
    // may not, but the workspace metadata save covers groupsMeta + recents.
    if (_persistTimer) {
      clearTimeout(_persistTimer);
      runPersistFlush();
    }
  });
}

// Coalesce rapid edits into a single sidecar write 200ms after the
// last call. Returns a promise that resolves after the flush completes.
export function persist() {
  if (_persistPending) return _persistPending;
  _persistPending = new Promise((resolve, reject) => {
    _persistResolve = resolve;
    _persistReject = reject;
  });
  _persistTimer = setTimeout(runPersistFlush, PERSIST_DEBOUNCE_MS);
  return _persistPending;
}

// Bypass the debounce — used by callers that need the write to land
// before they continue (e.g., right before close).
export async function flushPersist() {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    await runPersistFlush();
  }
}

async function runPersistFlush() {
  _persistTimer = null;
  const resolve = _persistResolve;
  const reject = _persistReject;
  _persistPending = null;
  _persistResolve = null;
  _persistReject = null;
  try {
    await persistImmediate();
    resolve?.();
  } catch (err) {
    reject?.(err);
  }
}

export async function persistImmediate() {
  const { state, getStore, mapView, saveAllWorkspaces, flashSaveIndicator } = deps;
  if (!state.currentPdfPath) return;
  if (state.view === "map" && mapView) {
    state.edges = mapView.getEdgesData();
    const positions = mapView.getNodePositions();
    state.snippets.forEach((s) => {
      const p = positions.get(s.id);
      if (p) s.pos = { x: p.x, y: p.y };
    });
  }
  flashSaveIndicator("saving");
  // Persist workspace state (theme, recents, pastedSnippets — but NOT
  // groupsMeta, which now lives per-document in each sidecar).
  saveAllWorkspaces();
  // Per-doc sidecar carries only the groups referenced by this doc's
  // snippets, so a sidecar shared standalone still has enough context.
  const usedIds = new Set();
  for (const s of state.snippets) for (const g of s.groups || []) usedIds.add(g);
  const localGroups = (state.groupsMeta || []).filter((g) => usedIds.has(g.id));
  const payload = {
    markleeVersion: "0.1",
    source: state.source,
    snippets: state.snippets,
    edges: state.edges,
    groups: localGroups,
  };
  const targetPath = state.currentPdfPath;
  try {
    const res = await getStore().writeAnnot(targetPath, payload, state.sidecarMtimeMs);
    // Legacy stores might still return undefined (old surface). Treat
    // that as success and skip mtime tracking until they're upgraded.
    if (res && res.ok === false && res.conflict) {
      await handleSidecarMtimeConflict(targetPath, payload, res.conflict);
      return;
    }
    if (res && typeof res.mtimeMs === "number") {
      state.sidecarMtimeMs = res.mtimeMs;
    }
    flashSaveIndicator("saved");
  } catch (err) {
    console.error("[persist] writeAnnot failed", err);
    flashSaveIndicator("error");
    throw err;
  }
}

// Handle the optimistic-mtime conflict surfaced by writeAnnot. The
// sidecar changed externally between our last read and this write —
// typically another window saved first. Ask the user whether to reload
// or overwrite. v1 uses confirm() for simplicity; a dedicated non-modal
// prompt is a follow-up.
async function handleSidecarMtimeConflict(targetPath, payload, conflict) {
  const { state, getStore, flashSaveIndicator, reloadDocument } = deps;
  console.warn("[persist] sidecar mtime conflict", { targetPath, conflict });
  flashSaveIndicator("error");
  const filename = targetPath.split("/").pop() || targetPath;
  const overwrite = window.confirm(
    `"${filename}" was modified externally (likely by another window).\n\n` +
    `OK = overwrite the external changes with what's in this window\n` +
    `Cancel = reload to see the external changes (in-memory edits not yet saved will be lost)`
  );
  if (!overwrite) {
    if (state.currentPdfPath === targetPath && reloadDocument) {
      await reloadDocument(targetPath);
    }
    return;
  }
  try {
    const res = await getStore().writeAnnot(targetPath, payload, -1);
    if (res && typeof res.mtimeMs === "number") {
      state.sidecarMtimeMs = res.mtimeMs;
    }
    flashSaveIndicator("saved");
  } catch (err) {
    console.error("[persist] forced overwrite failed", err);
    flashSaveIndicator("error");
  }
}

// Drop groupsMeta entries that no snippet references AND that have no
// human-given name. Called from group cleanup paths.
export function pruneOrphanGroups() {
  const { state } = deps;
  const used = new Set();
  for (const s of state.snippets) for (const g of s.groups || []) used.add(g);
  state.groupsMeta = (state.groupsMeta || []).filter(
    (g) => used.has(g.id) || (g.name && g.name.trim().length > 0)
  );
}
