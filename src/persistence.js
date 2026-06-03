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
  // Don't litter the source folder with an empty sidecar. If this doc has
  // no snippets, edges, or referenced groups (e.g. opened-but-unannotated,
  // or after delete-all), delete any existing sidecar and skip the write.
  const isEmpty =
    (state.snippets?.length || 0) === 0 &&
    (state.edges?.length || 0) === 0 &&
    localGroups.length === 0;
  if (isEmpty) {
    const store = getStore();
    if (typeof store.deleteAnnot === "function") {
      try {
        await store.deleteAnnot(state.currentPdfPath);
      } catch (err) {
        console.warn("[persist] deleteAnnot (empty doc) failed", err);
      }
    }
    state.sidecarMtimeMs = 0;
    flashSaveIndicator("saved");
    return;
  }
  const payload = {
    markleeVersion: "0.1",
    source: state.source,
    snippets: state.snippets,
    edges: state.edges,
    groups: localGroups,
  };
  const targetPath = state.currentPdfPath;
  // sidecarMtimeMs semantics:
  //   >0 → real mtime captured at last successful read/write → run check
  //    0 → uninitialized / first-write / pre-read state → SKIP the check
  //        (passing 0 would tell Rust "expect no prior file" which fails
  //        when the sidecar exists. That manifested as: every first
  //        persist after load triggered a spurious conflict prompt;
  //        if the user dismissed it, the reload wiped the in-flight
  //        edit. Net effect "snippets don't persist". Bypass instead.)
  const expectedMtime = state.sidecarMtimeMs > 0 ? state.sidecarMtimeMs : -1;
  try {
    const res = await getStore().writeAnnot(targetPath, payload, expectedMtime);
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
// typically another window saved first, OR (more often in practice)
// some bare 2-arg writeAnnot caller bumped the file without updating
// state.sidecarMtimeMs. Tauri blocks window.confirm, so we use the
// Tauri dialog plugin's ask() when available and fall through to a
// safe default ("reload") in the browser fallback.
async function askOverwriteOrReload(filename) {
  // Try Tauri's native ask() first — works in the desktop build.
  try {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    // ask() returns true = primary (overwrite), false = secondary (reload).
    return await ask(
      `"${filename}" was modified externally (likely by another window or a cross-doc edit).\n\n` +
      `Choose what to do:`,
      {
        title: "Sidecar conflict",
        okLabel: "Overwrite",
        cancelLabel: "Reload",
        kind: "warning",
      },
    );
  } catch (err) {
    console.warn("[persist] Tauri ask() unavailable; defaulting to reload (safer)", err);
    // Browser fallback or plugin missing — default to reload (no data
    // loss). User can re-apply their changes after the reload completes.
    return false;
  }
}

async function handleSidecarMtimeConflict(targetPath, payload, conflict) {
  const { state, getStore, flashSaveIndicator, reloadDocument } = deps;
  console.warn("[persist] sidecar mtime conflict", { targetPath, conflict });
  flashSaveIndicator("error");
  const filename = targetPath.split("/").pop() || targetPath;
  const overwrite = await askOverwriteOrReload(filename);
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
