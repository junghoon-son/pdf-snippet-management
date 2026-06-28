/**
 * OpfsStore — browser store backed by the Origin Private File System
 * (navigator.storage.getDirectory()). Used on every web build before any
 * backend exists, and as the durable fallback on Safari/Firefox which lack
 * showDirectoryPicker.
 *
 * Unlike FsaStore there is no user-chosen folder: the OPFS root IS the
 * library. It persists across reloads per-origin, so listDocuments() walks
 * the cached root with no re-pick step. Files are sandboxed and not visible
 * in the OS file manager, so documents must be brought in via
 * importDocument(relPath, bytes) (wired to drag-drop / <input type=file> by
 * a later task) before they can be opened.
 *
 * Layout mirrors the desktop/FSA convention exactly:
 *   <dir>/<filename>                         source bytes
 *   <dir>/.marklee/<filename>.annot.json     sidecar
 *   <dir>/.marklee/clips/<id>.png            rect clips
 * Global groups live in IndexedDB (per-origin), shared with FsaStore.
 */

import {
  kindFromName,
  GROUPS_DB,
  GROUPS_STORE,
  GROUPS_KEY,
  basename,
  sidecarPathFor,
  clipDirFor,
  walkDirectory,
  idbGet,
  idbPut,
} from "./fs-helpers.js";

export class OpfsStore {
  constructor({ root } = {}) {
    this.root = root || null;
  }

  capabilities() {
    return { rectClips: true, persistentPaths: true, kind: "opfs" };
  }

  async init() {
    if (this.root) return;
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
      throw new Error("OPFS not available in this environment");
    }
    this.root = await navigator.storage.getDirectory();
  }

  hasRoot() {
    return this.root != null;
  }

  async importDocument(relPath, bytes) {
    if (!this.root) throw new Error("OpfsStore: init() first");
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    await this._writeFile(relPath, data);
    const name = basename(relPath);
    return { path: relPath, name, kind: kindFromName(name) || "pdf" };
  }

  async listDocuments() {
    if (!this.root) throw new Error("OpfsStore: init() first");
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
    const sidecarPath = sidecarPathFor(relPath);
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

  async writeAnnot(relPath, annot, expectedMtimeMs = -1) {
    const sidecarPath = sidecarPathFor(relPath);
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
    let newMtime = 0;
    try {
      const file = await this._getFile(sidecarPath);
      newMtime = Number(file.lastModified) || 0;
    } catch { newMtime = 0; }
    return { ok: true, mtimeMs: newMtime };
  }

  async deleteAnnot(relPath) {
    try { await this._deleteFile(sidecarPathFor(relPath)); } catch { /* absent */ }
  }

  async readGlobalGroups() {
    const groups = await idbGet(GROUPS_DB, GROUPS_STORE, GROUPS_KEY);
    return groups || [];
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
    if (!this.root) throw new Error("OpfsStore: init() first");
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
