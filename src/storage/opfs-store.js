/**
 * OpfsStore — fallback for browsers without File System Access API
 * (Safari, Firefox). Stores everything in OPFS (Origin Private File System).
 *
 * Currently a stub. Implementation is straightforward when needed:
 * mirror FsaStore but use navigator.storage.getDirectory() as the root
 * instead of showDirectoryPicker. UX difference: files must be imported
 * (drag-drop or file input) before they can be opened, since OPFS is
 * sandboxed and not user-visible.
 */
export class OpfsStore {
  capabilities() {
    return { rectClips: true, persistentPaths: false, kind: "opfs" };
  }

  async _todo() {
    throw new Error("OpfsStore not yet implemented. Use TauriStore (desktop) or FsaStore (Chromium browser).");
  }

  listDocuments() { return this._todo(); }
  readDocumentBytes() { return this._todo(); }
  readAnnot() { return this._todo(); }
  writeAnnot() { return this._todo(); }
  readGlobalGroups() { return this._todo(); }
  writeGlobalGroups() { return this._todo(); }
  writeClip() { return this._todo(); }
  readClip() { return this._todo(); }
  deleteClip() { return this._todo(); }
  copyImageToClipboard() { return this._todo(); }
  checkPaths() { return this._todo(); }
}
