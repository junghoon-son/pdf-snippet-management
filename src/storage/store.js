/**
 * AnnotStore — uniform persistence interface used by every consumer
 * (main.js, lineage view, summary, search, CLI server). Three impls:
 *
 *   - TauriStore:  current desktop app, sidecars next to source files
 *   - FsaStore:    browser via File System Access API (Chromium)
 *   - OpfsStore:   browser fallback via Origin Private File System (Safari/Firefox)
 *
 * Method contract (all return Promises):
 *
 *   listDocuments(): Promise<Array<{ path, name, kind }>>
 *       — All annotatable files visible to the store.
 *         "path" is the canonical id used by every other method (string).
 *
 *   readDocumentBytes(path): Promise<Uint8Array>
 *
 *   readAnnot(path): Promise<AnnotFile & { _mtimeMs: number }>
 *       — Returns a default-initialized AnnotFile if no sidecar exists.
 *       — `_mtimeMs` is the sidecar's mtime at read time (0 if no file).
 *         Callers stash this and pass it back to writeAnnot for optimistic-
 *         concurrency protection.
 *
 *   writeAnnot(path, annot, expectedMtimeMs?): Promise<{ ok, mtimeMs?, conflict? }>
 *       — expectedMtimeMs default is -1 (skip the check; write blindly).
 *         0 means "expect no prior file" (first write).
 *         >0 means "must match this mtime, else return conflict".
 *       — On mtime mismatch, returns { ok: false, conflict: { expectedMtimeMs, foundMtimeMs } }
 *         without writing. Caller surfaces a reload-or-overwrite prompt.
 *       — On success, returns { ok: true, mtimeMs } so caller can cache
 *         the new mtime for the next write.
 *
 *   deleteAnnot(path): Promise<void>
 *       — Removes the document's sidecar (and any legacy next-to-file one).
 *         Called when an edit empties a document so no empty husk is left.
 *
 *   readGlobalGroups(): Promise<Array<GroupMeta>>
 *
 *   writeGlobalGroups(groups): Promise<void>
 *
 *   writeClip(path, clipId, bytes): Promise<string>
 *       — Stores a PNG image clip; returns the imagePath token to record on the snippet.
 *
 *   readClip(path, imagePath): Promise<Uint8Array>
 *
 *   deleteClip(path, imagePath): Promise<void>
 *
 *   copyImageToClipboard(path, imagePath): Promise<void>
 *
 *   checkPaths(paths): Promise<boolean[]>
 *       — Per-path existence; same length and order as input.
 *         For broken-sidecar / missing-source detection.
 *
 *   capabilities(): { rectClips: boolean, persistentPaths: boolean, kind: string }
 *
 * AnnotFile shape (matches src-tauri/src/lib.rs):
 *   { source: { path, filename, title, author, kind? },
 *     snippets: Snippet[], edges: Edge[], groups: GroupMeta[] }
 */

let activeStore = null;

export function setStore(store) {
  activeStore = store;
}

export function getStore() {
  if (!activeStore) throw new Error("No AnnotStore configured. Call setStore() first.");
  return activeStore;
}

/**
 * Pure backend-precedence decision. `env` is a plain capability object so this
 * is unit-testable with no real window/navigator.
 *   { isTauri, hasOpfs, hasFsa } -> "tauri" | "opfs" | "fsa" | null
 * On web (non-Tauri) OPFS is preferred over FSA: it is persistent and works in
 * every Chromium/Safari/Firefox build, whereas FSA needs an explicit picker.
 */
export function pickStore(env) {
  if (env.isTauri) return "tauri";
  if (env.hasOpfs) return "opfs";
  if (env.hasFsa) return "fsa";
  return null;
}

export async function autoDetectStore() {
  const env = {
    isTauri: typeof window !== "undefined" && !!window.__TAURI_INTERNALS__,
    hasOpfs: typeof navigator !== "undefined" && !!navigator.storage?.getDirectory,
    hasFsa: typeof window !== "undefined" && "showDirectoryPicker" in window,
  };
  switch (pickStore(env)) {
    case "tauri": {
      const { TauriStore } = await import("./tauri-store.js");
      return new TauriStore();
    }
    case "opfs": {
      const { OpfsStore } = await import("./opfs-store.js");
      return new OpfsStore();
    }
    case "fsa": {
      const { FsaStore } = await import("./fsa-store.js");
      return new FsaStore();
    }
    default:
      throw new Error("No supported storage backend in this environment.");
  }
}
