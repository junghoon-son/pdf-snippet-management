/**
 * FsaStore — persists annotations using the File System Access API.
 *
 * UX flow:
 *   - User picks a folder once via store.pickRoot() (Open Folder button).
 *     We get a FileSystemDirectoryHandle with read/write permission for
 *     every file inside, and the browser remembers it for the session.
 *   - Document path is the file's name within the chosen root, e.g.
 *     "papers/draft.pdf" — we store paths as forward-slash-joined strings.
 *   - Sidecars go right next to source files (papers/draft.pdf.annot.json),
 *     matching the desktop convention.
 *   - Image clips go in a hidden subfolder ".{filename}.clips/".
 *   - Global groups live in IndexedDB (per-origin, survives reloads, not
 *     scoped to any particular folder).
 *
 * Browser support: Chromium-family (Chrome, Edge, Brave, Arc, Opera).
 * Safari and Firefox lack showDirectoryPicker; use OpfsStore there.
 */

const KIND_BY_EXT = {
  pdf: "pdf",
  md: "markdown",
  markdown: "markdown",
  docx: "docx",
  png: "image",
  jpg: "image",
  jpeg: "image",
};
function kindFromName(name) {
  const m = (name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? KIND_BY_EXT[m[1]] || null : null;
}

const GROUPS_DB = "pdf-annotator";
const GROUPS_STORE = "global-groups";
const GROUPS_KEY = "groups.json";

export class FsaStore {
  constructor() {
    this.root = null;
    this.rootName = "";
  }

  capabilities() {
    return { rectClips: true, persistentPaths: false, kind: "fsa" };
  }

  async pickRoot() {
    if (!("showDirectoryPicker" in window)) {
      throw new Error("File System Access API not available in this browser");
    }
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") throw new Error("Folder access not granted");
    this.root = handle;
    this.rootName = handle.name;
    return { name: handle.name };
  }

  hasRoot() {
    return this.root != null;
  }

  async listDocuments(_dir) {
    if (!this.root) throw new Error("FsaStore: pickRoot() first");
    const out = [];
    await walkDirectory(this.root, "", (relPath, name) => {
      const kind = kindFromName(name);
      if (!kind) return;
      out.push({ path: relPath, name, kind });
    });
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  async readDocumentBytes(relPath) {
    const file = await this._getFile(relPath);
    return new Uint8Array(await file.arrayBuffer());
  }

  async readAnnot(relPath) {
    const sidecarPath = `${relPath}.annot.json`;
    let af = null;
    let mtimeMs = 0;
    try {
      const file = await this._getFile(sidecarPath);
      mtimeMs = Number(file.lastModified) || 0;
      af = JSON.parse(await file.text());
    } catch {
      af = null;
      mtimeMs = 0;
    }
    af = af || {};
    af.source = af.source || { path: relPath, filename: basename(relPath) };
    if (!af.source.kind) af.source.kind = kindFromName(relPath) || "pdf";
    af.snippets = af.snippets || [];
    af.edges = af.edges || [];
    af.groups = af.groups || [];
    af._mtimeMs = mtimeMs;
    return af;
  }

  // Optimistic-mtime concurrent-write protection. Browser File.lastModified
  // is less precise than POSIX mtime and may not always update reliably,
  // so this is best-effort on the FSA backend. Same return shape as the
  // Tauri store's writeAnnot for caller-side uniformity.
  async writeAnnot(relPath, annot, expectedMtimeMs = -1) {
    const sidecarPath = `${relPath}.annot.json`;
    if (expectedMtimeMs !== -1) {
      let actual = 0;
      try {
        const file = await this._getFile(sidecarPath);
        actual = Number(file.lastModified) || 0;
      } catch { actual = 0; }
      const mismatched =
        (expectedMtimeMs === 0 && actual !== 0) ||
        (expectedMtimeMs > 0 && actual !== expectedMtimeMs);
      if (mismatched) {
        return {
          ok: false,
          conflict: { expectedMtimeMs, foundMtimeMs: actual },
        };
      }
    }
    const json = JSON.stringify(annot, null, 2);
    await this._writeFile(sidecarPath, json);
    // Re-read to capture the post-write mtime so the caller can refresh
    // its cached value. If the lookup fails, return 0 — caller will
    // fall back to expectedMtimeMs=-1 on the next write.
    let newMtime = 0;
    try {
      const file = await this._getFile(sidecarPath);
      newMtime = Number(file.lastModified) || 0;
    } catch { newMtime = 0; }
    return { ok: true, mtimeMs: newMtime };
  }

  async readGlobalGroups() {
    return (await idbGet(GROUPS_DB, GROUPS_STORE, GROUPS_KEY)) || [];
  }

  async writeGlobalGroups(groups) {
    await idbPut(GROUPS_DB, GROUPS_STORE, GROUPS_KEY, groups);
  }

  async writeClip(relPath, clipId, bytes) {
    const dir = clipDirFor(relPath);
    const fileName = `${clipId}.png`;
    await this._writeFile(`${dir}/${fileName}`, bytes);
    return `${dir}/${fileName}`;
  }

  async readClip(_relPath, imagePath) {
    const file = await this._getFile(imagePath);
    return new Uint8Array(await file.arrayBuffer());
  }

  async deleteClip(_relPath, imagePath) {
    await this._deleteFile(imagePath);
  }

  async copyImageToClipboard(_relPath, imagePath) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error("Clipboard image write not supported in this browser");
    }
    const file = await this._getFile(imagePath);
    const blob = new Blob([await file.arrayBuffer()], { type: "image/png" });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }

  async checkPaths(paths) {
    const results = [];
    for (const p of paths) {
      try {
        await this._getFileHandle(p, false);
        results.push(true);
      } catch {
        results.push(false);
      }
    }
    return results;
  }

  async _getFile(relPath) {
    const handle = await this._getFileHandle(relPath, false);
    return await handle.getFile();
  }

  async _getFileHandle(relPath, create) {
    if (!this.root) throw new Error("FsaStore: pickRoot() first");
    const segments = relPath.split("/").filter(Boolean);
    if (segments.length === 0) throw new Error("empty path");
    let dir = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      dir = await dir.getDirectoryHandle(segments[i], { create });
    }
    return await dir.getFileHandle(segments[segments.length - 1], { create });
  }

  async _writeFile(relPath, content) {
    const handle = await this._getFileHandle(relPath, true);
    const writable = await handle.createWritable();
    await writable.write(content instanceof Uint8Array ? content : String(content));
    await writable.close();
  }

  async _deleteFile(relPath) {
    if (!this.root) return;
    const segments = relPath.split("/").filter(Boolean);
    if (segments.length === 0) return;
    let dir = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      dir = await dir.getDirectoryHandle(segments[i], { create: false });
    }
    if (typeof dir.removeEntry === "function") {
      await dir.removeEntry(segments[segments.length - 1]);
    }
  }
}

function basename(p) {
  return p.split("/").pop() || p;
}

function clipDirFor(relPath) {
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const name = basename(relPath);
  return (dir ? `${dir}/` : "") + `.${name}.clips`;
}

async function walkDirectory(dir, prefix, visit) {
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

function openIdb(name, store) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(store);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(name, store, key) {
  const db = await openIdb(name, store);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(name, store, key, value) {
  const db = await openIdb(name, store);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
