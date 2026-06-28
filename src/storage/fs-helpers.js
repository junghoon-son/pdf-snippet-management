/**
 * fs-helpers.js — shared utilities for FsaStore and OpfsStore.
 *
 * Both stores operate over the same File System Access / OPFS handle surface,
 * so all path-manipulation helpers, directory walkers, and IndexedDB wrappers
 * live here and are imported by both stores.
 */

export const KIND_BY_EXT = {
  pdf: "pdf",
  md: "markdown",
  markdown: "markdown",
  docx: "docx",
  png: "image",
  jpg: "image",
  jpeg: "image",
};

export function kindFromName(name) {
  const m = (name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? KIND_BY_EXT[m[1]] || null : null;
}

export const GROUPS_DB = "marklee";
export const GROUPS_STORE = "global-groups";
export const GROUPS_KEY = "groups.json";

export function basename(p) {
  return p.split("/").pop() || p;
}

// New sidecar location: <dir>/.marklee/<filename>.annot.json (relative to
// the chosen root). Keeps source folders clean — see STORE_DIR rationale
// in the Rust backend and the FsaStore header.
export function sidecarPathFor(relPath) {
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const name = basename(relPath);
  return (dir ? `${dir}/` : "") + `.marklee/${name}.annot.json`;
}

export function clipDirFor(relPath) {
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  return (dir ? `${dir}/` : "") + ".marklee/clips";
}

export async function walkDirectory(dir, prefix, visit) {
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith(".")) continue;
    const next = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "file") {
      visit(next, name);
    } else if (handle.kind === "directory") {
      await walkDirectory(handle, next, visit);
    }
  }
}

export function openIdb(name, store) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(store);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet(name, store, key) {
  const db = await openIdb(name, store);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut(name, store, key, value) {
  const db = await openIdb(name, store);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
