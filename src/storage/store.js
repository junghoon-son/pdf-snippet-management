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
 *   readAnnot(path): Promise<AnnotFile>
 *       — Returns a default-initialized AnnotFile if no sidecar exists.
 *
 *   writeAnnot(path, annot): Promise<void>
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

export async function autoDetectStore() {
  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    const { TauriStore } = await import("./tauri-store.js");
    return new TauriStore();
  }
  if (typeof window !== "undefined" && "showDirectoryPicker" in window) {
    const { FsaStore } = await import("./fsa-store.js");
    return new FsaStore();
  }
  if (typeof navigator !== "undefined" && navigator.storage?.getDirectory) {
    const { OpfsStore } = await import("./opfs-store.js").catch(() => ({}));
    if (OpfsStore) return new OpfsStore();
  }
  throw new Error("No supported storage backend in this environment.");
}
