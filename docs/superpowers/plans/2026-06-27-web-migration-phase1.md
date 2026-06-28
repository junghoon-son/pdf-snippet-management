# Marklee Web Migration — Phase 1 (Web Shell) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Marklee run fully in the browser on OPFS storage with no backend — import/open PDFs, manual annotation, the edge graph, permalinks — by removing all Tauri coupling.

**Architecture:** Complete the OPFS storage backend by mirroring the existing `FsaStore`; route the app through `autoDetectStore()` preferring OPFS on web; replace native file dialogs with a browser import (file picker + drag-drop) that writes into OPFS; strip desktop-only Tauri features (encrypted key store, reveal-in-Finder, native export/clipboard). AI extraction is hidden behind an `AI_ENABLED` flag for Phase 2 — `reader.js`/`planner.js`/`providers.js` stay intact; the pure-JS figure detector is untouched.

**Tech Stack:** Vanilla JS, Vite, Bun (test runner), pdf.js, OPFS (`navigator.storage`), IndexedDB.

## Global Constraints

- Vanilla JS only — no TypeScript, no framework.
- Tests use Bun's runner: `import { test, expect } from "bun:test"`; run with `bun run test spec/tests/`. New tests go in `spec/tests/`.
- Sidecar/clip layout is fixed: `<dir>/.marklee/<filename>.annot.json` and `<dir>/.marklee/clips/<id>.png`. Rects stay fractional `[0..1]`.
- No backend, no auth, no AI server, no new heavy dependencies in Phase 1.
- The `AnnotStore` contract (`src/storage/store.js`) is fixed; `OpfsStore` must satisfy it exactly, plus `init()` / `hasRoot()` / `importDocument()`.
- Commit after each task (frequent commits). Each commit message ends with the `Co-Authored-By` trailer.

---


### Task 1: Complete OpfsStore (src/storage/opfs-store.js)

**Files:**
- Create: nothing new (file exists as a stub)
- Modify: `/Users/jung/PersonalProjects/pdf-annotator/src/storage/opfs-store.js` (full rewrite of the stub at lines 1-32)
- Test: `/Users/jung/PersonalProjects/pdf-annotator/spec/tests/opfs-store.test.js` (new)

**Interfaces:**
- Produces (the full `AnnotStore` contract + OPFS additions):
  - `constructor({ root } = {})` — caches an injected root for tests; otherwise null until `init()`.
  - `async init(): Promise<void>` — `this.root ||= await navigator.storage.getDirectory()`.
  - `hasRoot(): boolean`
  - `async importDocument(relPath, bytes): Promise<{ path, name, kind }>`
  - `async listDocuments(): Promise<Array<{ path, name, kind }>>`
  - `async readDocumentBytes(path): Promise<Uint8Array>`
  - `async readAnnot(path): Promise<AnnotFile & { _mtimeMs }>`
  - `async writeAnnot(path, annot, expectedMtimeMs=-1): Promise<{ ok, mtimeMs?, conflict? }>`
  - `async deleteAnnot(path): Promise<void>`
  - `async readGlobalGroups(): Promise<GroupMeta[]>` / `async writeGlobalGroups(groups): Promise<void>`
  - `async writeClip(path, clipId, bytes): Promise<string>` / `async readClip(path, imagePath): Promise<Uint8Array>` / `async deleteClip(path, imagePath): Promise<void>`
  - `async copyImageToClipboard(path, imagePath): Promise<void>`
  - `async checkPaths(paths): Promise<boolean[]>`
  - `capabilities(): { rectClips: true, persistentPaths: true, kind: "opfs" }`
- Consumes: the OPFS root handle API surface — `getDirectoryHandle(name,{create})`, `getFileHandle(name,{create})`, `getFile()->{text(),arrayBuffer(),lastModified}`, `createWritable()->{write(),close()}`, `removeEntry(name)`, async `entries()`. (Identical shape to FSA handles, so the helpers from fsa-store.js port verbatim.)

> **Design note on helpers:** I copy `KIND_BY_EXT`, `kindFromName`, `basename`, `sidecarPathFor`, `clipDirFor`, `walkDirectory`, `openIdb`, `idbGet`, `idbPut` **into opfs-store.js verbatim** rather than importing from `fsa-store.js`. Reason: `fsa-store.js` does not `export` any of those helpers (they are module-private — see lines 20-32, 228-287), and Phase 1 forbids broad refactors. A shared-module extraction is deferred. The IndexedDB constants (`GROUPS_DB="marklee"`, `GROUPS_STORE="global-groups"`, `GROUPS_KEY="groups.json"`) are reused identically so OpfsStore and FsaStore share the same per-origin global-groups record.

---

- [ ] **Step 1: Replace the stub header + class open with constructor/init/hasRoot/capabilities.** Open `/Users/jung/PersonalProjects/pdf-annotator/src/storage/opfs-store.js` and replace the entire current contents (lines 1-32) with the block below. It keeps the doc comment, adds the ported helper constants at top, and writes the new class skeleton (remaining methods are filled in the next steps — but paste the WHOLE file from this step through Step 7 as one final file; the steps below are the ordered pieces).

```js
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

const GROUPS_DB = "marklee";
const GROUPS_STORE = "global-groups";
const GROUPS_KEY = "groups.json";

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
```

- [ ] **Step 2: Add importDocument + listDocuments + readDocumentBytes.** Append these methods inside the class (after `hasRoot`). `importDocument` writes the uploaded bytes into OPFS and returns the doc descriptor; `listDocuments` walks the cached root; `readDocumentBytes` reads source bytes.

```js
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
```

- [ ] **Step 3: Add readAnnot + writeAnnot + deleteAnnot.** Ported verbatim from FsaStore (lines 81-142) — same default-init shape, same optimistic-mtime conflict logic, same re-read-for-mtime.

```js
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
```

- [ ] **Step 4: Add the global-groups + clip + clipboard + checkPaths methods.** Ported verbatim from FsaStore (lines 144-189). Clipboard guards on availability (Safari may lack it) and throws — acceptable, callers already handle the throw.

```js
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
```

- [ ] **Step 5: Add the private file helpers + close the class.** Ported verbatim from FsaStore (lines 191-226), swapping the error message to `"OpfsStore: init() first"`.

```js
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
```

- [ ] **Step 6: Append the module-private functions after the class.** Ported verbatim from FsaStore (lines 228-287).

```js
function basename(p) {
  return p.split("/").pop() || p;
}

function sidecarPathFor(relPath) {
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const name = basename(relPath);
  return (dir ? `${dir}/` : "") + `.marklee/${name}.annot.json`;
}

function clipDirFor(relPath) {
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  return (dir ? `${dir}/` : "") + ".marklee/clips";
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
```

- [ ] **Step 7: Write the test file with an in-memory fake OPFS root.** Create `/Users/jung/PersonalProjects/pdf-annotator/spec/tests/opfs-store.test.js` with the full contents below. The fake implements only the handle surface OpfsStore touches. `lastModified` is a module-level monotonic counter bumped on every write/close so stale-mtime conflicts are deterministic (bun has no real clock-precision dependency). Tests inject the fake via `new OpfsStore({ root })` and never call `init()`. Note: these methods touch `idb*` only in the global-groups path, which is NOT exercised here (bun has no `indexedDB`), so those two methods are intentionally untested at the unit level — call this out.

```js
import { test, expect, describe } from "bun:test";
import { OpfsStore } from "../../src/storage/opfs-store.js";

// --- in-memory fake of the OPFS / FSA directory-handle surface ---------------
// Monotonic clock so writeAnnot's mtime is deterministic across writes.
let CLOCK = 1000;
const enc = new TextEncoder();

function toBytes(content) {
  if (content instanceof Uint8Array) return content;
  return enc.encode(String(content));
}

class FakeFileHandle {
  constructor(name) {
    this.kind = "file";
    this.name = name;
    this._bytes = new Uint8Array(0);
    this._mtime = 0;
  }
  async getFile() {
    const bytes = this._bytes;
    const mtime = this._mtime;
    return {
      lastModified: mtime,
      async text() { return new TextDecoder().decode(bytes); },
      async arrayBuffer() {
        // return a copy's underlying buffer
        return bytes.slice().buffer;
      },
    };
  }
  async createWritable() {
    const self = this;
    let buf = new Uint8Array(0);
    return {
      async write(content) { buf = toBytes(content); },
      async close() {
        self._bytes = buf;
        self._mtime = ++CLOCK;
      },
    };
  }
}

class FakeDirHandle {
  constructor(name) {
    this.kind = "directory";
    this.name = name;
    this._children = new Map(); // name -> FakeDirHandle | FakeFileHandle
  }
  async getDirectoryHandle(name, { create } = {}) {
    let h = this._children.get(name);
    if (!h) {
      if (!create) throw new Error(`NotFound: ${name}`);
      h = new FakeDirHandle(name);
      this._children.set(name, h);
    }
    if (h.kind !== "directory") throw new Error(`TypeMismatch: ${name}`);
    return h;
  }
  async getFileHandle(name, { create } = {}) {
    let h = this._children.get(name);
    if (!h) {
      if (!create) throw new Error(`NotFound: ${name}`);
      h = new FakeFileHandle(name);
      this._children.set(name, h);
    }
    if (h.kind !== "file") throw new Error(`TypeMismatch: ${name}`);
    return h;
  }
  async removeEntry(name) {
    if (!this._children.has(name)) throw new Error(`NotFound: ${name}`);
    this._children.delete(name);
  }
  async *entries() {
    for (const [name, handle] of this._children) {
      yield [name, handle];
    }
  }
}

function newStore() {
  return new OpfsStore({ root: new FakeDirHandle("") });
}

// --- tests -------------------------------------------------------------------

describe("OpfsStore", () => {
  test("capabilities reports opfs/persistent/rectClips", () => {
    const s = newStore();
    expect(s.capabilities()).toEqual({
      rectClips: true,
      persistentPaths: true,
      kind: "opfs",
    });
    expect(s.hasRoot()).toBe(true);
  });

  test("importDocument writes bytes; listDocuments returns the descriptor", async () => {
    const s = newStore();
    const desc = await s.importDocument("papers/draft.pdf", enc.encode("%PDF-1.7 fake"));
    expect(desc).toEqual({ path: "papers/draft.pdf", name: "draft.pdf", kind: "pdf" });

    const docs = await s.listDocuments();
    expect(docs).toEqual([{ path: "papers/draft.pdf", name: "draft.pdf", kind: "pdf" }]);

    const bytes = await s.readDocumentBytes("papers/draft.pdf");
    expect(new TextDecoder().decode(bytes)).toBe("%PDF-1.7 fake");
  });

  test("listDocuments skips dot-dirs (sidecars) and unknown extensions", async () => {
    const s = newStore();
    await s.importDocument("a.pdf", enc.encode("x"));
    await s.importDocument("notes.txt", enc.encode("x")); // unknown ext -> skipped
    await s.writeAnnot("a.pdf", { snippets: [] }); // creates .marklee/... -> skipped
    const docs = await s.listDocuments();
    expect(docs.map((d) => d.path)).toEqual(["a.pdf"]);
  });

  test("writeAnnot then readAnnot round-trips a snippet with a non-conflicting mtime", async () => {
    const s = newStore();
    await s.importDocument("a.pdf", enc.encode("x"));
    const snippet = { id: "s1", rect: [0.1, 0.2, 0.3, 0.4], page: 0 };
    const w = await s.writeAnnot("a.pdf", { source: { path: "a.pdf", filename: "a.pdf", kind: "pdf" }, snippets: [snippet], edges: [], groups: [] });
    expect(w.ok).toBe(true);
    expect(w.mtimeMs).toBeGreaterThan(0);

    const af = await s.readAnnot("a.pdf");
    expect(af.snippets).toEqual([snippet]);
    expect(af.source.kind).toBe("pdf");
    expect(af._mtimeMs).toBe(w.mtimeMs);

    // expectedMtimeMs matching the cached value writes cleanly (no conflict).
    const w2 = await s.writeAnnot("a.pdf", { snippets: [] }, af._mtimeMs);
    expect(w2.ok).toBe(true);
    expect(w2.conflict).toBeUndefined();
  });

  test("readAnnot on a missing sidecar returns a default-initialized AnnotFile", async () => {
    const s = newStore();
    const af = await s.readAnnot("ghost.pdf");
    expect(af.snippets).toEqual([]);
    expect(af.edges).toEqual([]);
    expect(af.groups).toEqual([]);
    expect(af.source).toEqual({ path: "ghost.pdf", filename: "ghost.pdf", kind: "pdf" });
    expect(af._mtimeMs).toBe(0);
  });

  test("writeAnnot with a stale expectedMtimeMs returns {ok:false, conflict}", async () => {
    const s = newStore();
    const first = await s.writeAnnot("a.pdf", { snippets: [] });
    expect(first.ok).toBe(true);
    const stale = first.mtimeMs - 1; // never the real on-disk mtime
    const res = await s.writeAnnot("a.pdf", { snippets: [{ id: "x" }] }, stale);
    expect(res.ok).toBe(false);
    expect(res.conflict).toEqual({ expectedMtimeMs: stale, foundMtimeMs: first.mtimeMs });

    // The rejected write must NOT have mutated the sidecar.
    const af = await s.readAnnot("a.pdf");
    expect(af.snippets).toEqual([]);
  });

  test("writeAnnot expectedMtimeMs=0 conflicts when a sidecar already exists", async () => {
    const s = newStore();
    const first = await s.writeAnnot("a.pdf", { snippets: [] });
    const res = await s.writeAnnot("a.pdf", { snippets: [] }, 0);
    expect(res.ok).toBe(false);
    expect(res.conflict).toEqual({ expectedMtimeMs: 0, foundMtimeMs: first.mtimeMs });
  });

  test("writeClip / readClip round-trips PNG bytes and returns the .marklee/clips path", async () => {
    const s = newStore();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const imagePath = await s.writeClip("papers/a.pdf", "clip42", png);
    expect(imagePath).toBe("papers/.marklee/clips/clip42.png");

    const back = await s.readClip("papers/a.pdf", imagePath);
    expect(Array.from(back)).toEqual(Array.from(png));
  });

  test("deleteClip removes the clip file", async () => {
    const s = newStore();
    const imagePath = await s.writeClip("a.pdf", "c1", new Uint8Array([1, 2]));
    expect((await s.checkPaths([imagePath]))[0]).toBe(true);
    await s.deleteClip("a.pdf", imagePath);
    expect((await s.checkPaths([imagePath]))[0]).toBe(false);
  });

  test("deleteAnnot removes the sidecar and is a no-op when absent", async () => {
    const s = newStore();
    await s.writeAnnot("a.pdf", { snippets: [{ id: "x" }] });
    const sidecar = ".marklee/a.pdf.annot.json";
    expect((await s.checkPaths([sidecar]))[0]).toBe(true);
    await s.deleteAnnot("a.pdf");
    expect((await s.checkPaths([sidecar]))[0]).toBe(false);
    // second delete must not throw
    await s.deleteAnnot("a.pdf");
  });

  test("methods throw before a root is set", async () => {
    const s = new OpfsStore();
    expect(s.hasRoot()).toBe(false);
    await expect(s.listDocuments()).rejects.toThrow("init() first");
  });
});
```

  > Note on coverage: `readGlobalGroups`/`writeGlobalGroups` are NOT unit-tested here because they hit `indexedDB`, which bun does not provide. They are exact verbatim copies of the FsaStore implementations (which run in the browser) and are exercised by the manual step below. All other contract methods are covered.

- [ ] **Step 8: Run the OpfsStore tests — expect PASS.**
  ```
  bun run test spec/tests/opfs-store.test.js
  ```
  Expected: all tests in the `OpfsStore` describe block PASS (11 tests, 0 fail). If `writeAnnot expectedMtimeMs=0 conflicts` fails, the conflict branch in Step 3 was altered — it must match FsaStore lines 115-123 exactly.

- [ ] **Step 9: Run the full suite to confirm no regression — expect PASS.**
  ```
  bun run test spec/tests/
  ```
  Expected: the pre-existing suite still passes and the new `opfs-store.test.js` is included with 0 failures.

- [ ] **Step 10: MANUAL browser verification of the OPFS + IndexedDB glue (can't be unit-tested in bun — no real OPFS/IndexedDB).** This is the only way to exercise `init()`, the real `navigator.storage.getDirectory()` acquisition, and the `idbGet/idbPut` global-groups path.
  - Run `bun run dev` and open the printed localhost URL in Chrome (Chrome also exposes OPFS, so the dev path works there even though FsaStore would normally win).
  - In DevTools Console paste:
    ```js
    const { OpfsStore } = await import("/src/storage/opfs-store.js");
    const s = new OpfsStore();
    await s.init();
    console.log("hasRoot", s.hasRoot(), "caps", s.capabilities());
    await s.importDocument("demo/hello.pdf", new TextEncoder().encode("%PDF-1.4 hi"));
    console.log("docs", await s.listDocuments());
    await s.writeGlobalGroups([{ id: "g1", name: "Inbox" }]);
    console.log("groups", await s.readGlobalGroups());
    ```
  - Expected observable result: `hasRoot true`, `caps {rectClips:true, persistentPaths:true, kind:"opfs"}`, `docs` contains `{path:"demo/hello.pdf", name:"hello.pdf", kind:"pdf"}`, and `groups` echoes `[{id:"g1", name:"Inbox"}]`. Then reload the page and re-run only the `listDocuments()` + `readGlobalGroups()` lines: both must still return the same data, confirming OPFS + IndexedDB persistence across sessions.
  - In DevTools, Application > Storage > confirm an `IndexedDB > marklee > global-groups` entry exists and Application > Storage shows OPFS usage. This verifies the `GROUPS_DB`/`GROUPS_STORE` constants match FsaStore so both stores share one global-groups record.

- [ ] **Step 11: Commit.**
  ```
  git add src/storage/opfs-store.js spec/tests/opfs-store.test.js && git commit -m "OpfsStore: full AnnotStore impl over OPFS root + init/importDocument + tests"
  ```

### Task 2: Web bootstrap & store selection

**Files:**
- Modify: `src/storage/store.js:71-85` (`autoDetectStore` — flip OPFS above FSA on web)
- Modify: `src/main.js:2` (remove static `@tauri-apps/plugin-dialog` import), `src/main.js:79-88` (store boot + drop `initAllProviderKeys`), and add a guarded `tauriOpen` helper near the top.
- Test: `spec/tests/auto-detect-store.test.js` (new — pure precedence unit test via dependency-injected detector)

**Interfaces:**
- Consumes: `autoDetectStore()` (from `src/storage/store.js`), `setStore(store)`, `getStore()`, `OpfsStore#init?()`, `OpfsStore#capabilities()->{rectClips:true,persistentPaths:true,kind:"opfs"}`.
- Produces: `pickStore(env) -> "tauri"|"fsa"|"opfs"` — a pure, injectable helper exported from `src/storage/store.js` so precedence is unit-testable without a real `window`/`navigator`. `autoDetectStore()` is refactored to call it. New `tauriOpen(opts)` private helper in `main.js` (lazy `import("@tauri-apps/plugin-dialog")`).

I chose **option (1): a pure refactor + bun test**. The precedence logic (`tauri` > `opfs` > `fsa`) is extracted into a pure `pickStore(env)` function that takes a plain capability object, so it is fully unit-testable in bun with no DOM. The browser-only glue (`getStore().init?.()`, `dataset.runtime`) additionally gets a MANUAL verification step.

- [ ] **Step 1: Read the current precedence block.** Confirm `src/storage/store.js:71-85` matches the before shown below. (no code change)

- [ ] **Step 2: Add the pure `pickStore(env)` helper above `autoDetectStore`.** Insert directly before line 71 in `src/storage/store.js`:
```js
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
```

- [ ] **Step 3: Rewrite `autoDetectStore` to use `pickStore` (flips OPFS above FSA).** Replace the whole current body:
```js
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
```
with:
```js
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
```
Note: OPFS now wins over FSA on web (the prior order had FSA first via `showDirectoryPicker`), and the `.catch(() => ({}))` swallow is dropped so an OPFS import failure surfaces instead of silently throwing the generic "No supported storage backend" error.

- [ ] **Step 4: Write the precedence unit test.** Create `spec/tests/auto-detect-store.test.js`:
```js
import { test, expect, describe } from "bun:test";
import { pickStore } from "../../src/storage/store.js";

describe("pickStore precedence", () => {
  test("Tauri wins over everything", () => {
    expect(pickStore({ isTauri: true, hasOpfs: true, hasFsa: true })).toBe("tauri");
  });
  test("on web, OPFS is preferred over FSA", () => {
    expect(pickStore({ isTauri: false, hasOpfs: true, hasFsa: true })).toBe("opfs");
  });
  test("FSA is used only when OPFS is absent", () => {
    expect(pickStore({ isTauri: false, hasOpfs: false, hasFsa: true })).toBe("fsa");
  });
  test("OPFS works even without FSA (Safari/Firefox)", () => {
    expect(pickStore({ isTauri: false, hasOpfs: true, hasFsa: false })).toBe("opfs");
  });
  test("no backend -> null", () => {
    expect(pickStore({ isTauri: false, hasOpfs: false, hasFsa: false })).toBeNull();
  });
});
```

- [ ] **Step 5: Run the precedence test — expect PASS.**
```
bun run test spec/tests/auto-detect-store.test.js
```
Expected: 5 tests pass, 0 fail. The key assertion ("on web, OPFS is preferred over FSA") guards the precedence flip from Step 3.

- [ ] **Step 6: Remove the static Tauri dialog import in `main.js`.** Delete line 2:
```js
import { open } from "@tauri-apps/plugin-dialog";
```
This is what currently makes the bundle crash in a plain browser (the package resolves only under Tauri). The four desktop call sites (`main.js:147,653,3240` and the folder picker at `671`) all run only behind an `IS_TAURI` guard, so a lazy import is safe.

- [ ] **Step 7: Add a guarded `tauriOpen` helper.** Insert immediately after the import block (right before the current line 79 `const IS_TAURI = ...`):
```js
// Lazy, guarded shim for the Tauri open dialog. The static import was removed
// so the bundle loads in a plain browser; every caller is already inside an
// IS_TAURI branch, so this import only ever runs under the desktop runtime.
async function tauriOpen(opts) {
  const { open } = await import("@tauri-apps/plugin-dialog");
  return open(opts);
}
```

- [ ] **Step 8: Point the four desktop dialog call sites at `tauriOpen`.** In `src/main.js`, change each Tauri `open(` call to `tauriOpen(`. There are exactly four, all inside `IS_TAURI` branches:
  - `main.js:147` — `newPath = await open({` → `newPath = await tauriOpen({`
  - `main.js:653` — `const path = await open({` → `const path = await tauriOpen({`
  - `main.js:671` — `dir = await open({ multiple: false, directory: true });` → `dir = await tauriOpen({ multiple: false, directory: true });`
  - `main.js:3240` — `const path = await open({` → `const path = await tauriOpen({`
  Do NOT touch the local `open`/`open(ev)` at `main.js:3999` and `4002` — that is an unrelated local function, not the dialog.

- [ ] **Step 9: Replace the hard store selection + drop the BYOK boot call.** Replace the current block (`main.js:79-88`):
```js
const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
const fsaStore = IS_TAURI ? null : new FsaStore();
setStore(IS_TAURI ? new TauriStore() : fsaStore);
document.body.dataset.runtime = IS_TAURI ? "tauri" : "web";

// Hydrate every provider's encrypted-key cache before the rest of the
// module evaluates — top-level await pauses execution here, so all UI
// bindings below see the cached keys via the sync hasApiKey() /
// getApiKey() accessors. Single round-trip; the Tauri command is fast.
await initAllProviderKeys();
```
with:
```js
const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
document.body.dataset.runtime = IS_TAURI ? "tauri" : "web";

setStore(await autoDetectStore());
await getStore().init?.();
```
Notes: `IS_TAURI` stays defined (used at `main.js:389,497,649,670,3239,3581,6204,6267` and elsewhere). `fsaStore` is removed here — Task 3 owns the one remaining `fsaStore.pickRoot()` reference at `main.js:670`; if that task has not landed yet, leave a local `const fsaStore = IS_TAURI ? null : new FsaStore();` line in place temporarily and remove it when Task 3 wires OPFS folder import. `initAllProviderKeys` is dropped (Task 5 removes the function and its import at `main.js:68`).

- [ ] **Step 10: Add the missing `autoDetectStore` import.** `main.js:20` currently imports only `{ setStore, getStore }`. Update it to:
```js
import { setStore, getStore, autoDetectStore } from "./storage/store.js";
```

- [ ] **Step 11: Confirm no remaining static-`open` references break the build.** Run:
```
grep -nE "await open\(|= open\(" src/main.js
```
Expected: zero matches (all dialog calls now go through `tauriOpen`; the local `open(ev)`/`setTimeout(() => open(...))` at ~3999/4002 use no `await`/assignment and won't match). If any line other than the local function matches, it was missed in Step 8.

- [ ] **Step 12: Re-run the unit test to confirm nothing regressed.**
```
bun run test spec/tests/auto-detect-store.test.js
```
Expected: 5 pass, 0 fail.

- [ ] **Step 13: MANUAL browser verification (browser-only glue — cannot be bun-tested).** This covers the runtime path that needs a real `window`/`navigator`/OPFS, which bun's runner has no fixture for.
  1. Run `bun run dev` and open the printed localhost URL in Chrome.
  2. Confirm the page loads with NO console error mentioning `@tauri-apps` (this proves Step 6 fixed the bundle).
  3. In the DevTools console run `document.body.dataset.runtime` → expect `"web"`.
  4. Run `getStore().capabilities().kind` → expect `"opfs"` (proves Step 3 precedence + Step 9 boot selected OpfsStore over FSA).
  5. Run `getStore().hasRoot()` → expect `true` (proves `await getStore().init?.()` ran and cached the OPFS root).

- [ ] **Step 14: Commit.**
```
git add src/storage/store.js src/main.js spec/tests/auto-detect-store.test.js && git commit -m "Web bootstrap: prefer OPFS over FSA, lazy Tauri dialog, drop BYOK boot"
```

### Task 3: Document import + library list (web upload model)

OPFS starts empty — there are no user files until one is imported. This task wires a browser upload path (file picker + drag-drop) that writes uploaded bytes into the store via `importDocument`, then feeds the returned descriptor into the existing `loadPdf()` flow. On boot it renders a persistent in-app library from `store.listDocuments()`, and replaces the desktop "File"/"Folder" buttons with a single "Import PDF" affordance plus an empty-state.

**Files:**
- Create: `spec/tests/import-descriptor.test.js` (unit test for the pure helper)
- Modify: `src/source-kind.js` — add pure `sanitizeImportName()` + `fileToDescriptor()` helpers (after `detectKindFromPath`, ~line 20)
- Modify: `src/main.js`:
  - `:79-82` — async boot via `autoDetectStore()` + `init()`
  - `:261-283` — `pickBrowserFile()` reused as-is (verify, no edit) and a new `importFiles()` helper added after it
  - `:648-695` — replace `open-file` / `open-folder` click handlers with a single `import-pdf` handler + drag-drop wiring
  - `:721` — `renderWorkspace()` empty-state branch
- Modify: `index.html`:
  - `:22-29` — replace the two `<button>`s with one `#import-pdf` button
  - `:71` — empty-state copy
- Test: `spec/tests/import-descriptor.test.js`

**Interfaces:**
- Consumes: `getStore()`, `setStore(store)`, `autoDetectStore()` (from `src/storage/store.js`); `OpfsStore.importDocument(relPath, bytes) -> {path,name,kind}`, `OpfsStore.init()`, `listDocuments()`, `capabilities() -> {kind}` (Task 1); `loadPdf(path)`, `renderWorkspace()`, `pickBrowserFile(types)` (existing in `src/main.js`); `detectKindFromPath(path)` (existing in `src/source-kind.js`).
- Produces: `sanitizeImportName(name) -> string` and `fileToDescriptor(file) -> {name, kind}` (new, in `src/source-kind.js`); `importFiles(files) -> Promise<void>` (new, in `src/main.js`, not exported).

---

- [ ] **Step 1: Add the pure import helpers to `src/source-kind.js`.** Insert after the closing `}` of `detectKindFromPath` (current last line ~20). These are framework-free and unit-testable in bun (no DOM, no `File` construction needed for `sanitizeImportName`; `fileToDescriptor` only reads `.name`).

```js
// Strip directory components and unsafe characters from an uploaded
// file's name so it can be a flat OPFS key. Collapses path separators,
// drops control/reserved chars, trims dots/spaces, and guarantees a
// non-empty result. Pure — no DOM, no I/O.
export function sanitizeImportName(name) {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  const cleaned = base
    .replace(/[\x00-\x1f<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .trim();
  return cleaned || "untitled";
}

// Map a picked/dropped File (or any object with a .name) to the
// {name, kind} descriptor the store import path needs. The store
// supplies the canonical `path`; kind is derived from the sanitized
// name so it matches loadAnyDocument's routing.
export function fileToDescriptor(file) {
  const name = sanitizeImportName(file && file.name);
  return { name, kind: detectKindFromPath(name) };
}
```

- [ ] **Step 2: Write the unit test `spec/tests/import-descriptor.test.js`.** Covers sanitization edge cases and descriptor mapping.

```js
// Verifies the pure import helpers in src/source-kind.js used by the
// web upload path in main.js (importFiles -> store.importDocument).
import { describe, test, expect } from "bun:test";
import { sanitizeImportName, fileToDescriptor } from "../../src/source-kind.js";

describe("sanitizeImportName", () => {
  test("strips directory components", () => {
    expect(sanitizeImportName("/Users/me/docs/paper.pdf")).toBe("paper.pdf");
    expect(sanitizeImportName("a\\b\\c.pdf")).toBe("c.pdf");
  });
  test("removes reserved / control characters", () => {
    expect(sanitizeImportName('re<po>rt:final?.pdf')).toBe("report final.pdf");
  });
  test("trims leading/trailing dots and spaces", () => {
    expect(sanitizeImportName("  ..notes.md..  ")).toBe("notes.md");
  });
  test("empty / falsy names fall back to 'untitled'", () => {
    expect(sanitizeImportName("")).toBe("untitled");
    expect(sanitizeImportName(null)).toBe("untitled");
    expect(sanitizeImportName("///")).toBe("untitled");
  });
});

describe("fileToDescriptor", () => {
  test("derives sanitized name and kind from a File-like object", () => {
    expect(fileToDescriptor({ name: "/tmp/Slides.PDF" })).toEqual({ name: "Slides.PDF", kind: "pdf" });
    expect(fileToDescriptor({ name: "notes.md" })).toEqual({ name: "notes.md", kind: "markdown" });
    expect(fileToDescriptor({ name: "cover.PNG" })).toEqual({ name: "cover.PNG", kind: "image" });
  });
  test("unknown extension defaults kind to pdf", () => {
    expect(fileToDescriptor({ name: "data.xyz" })).toEqual({ name: "data.xyz", kind: "pdf" });
  });
});
```

- [ ] **Step 3: Run the new unit test — expect PASS.**

```
bun run test spec/tests/import-descriptor.test.js
```

Expected: all tests pass (2 describe blocks, 6 tests). If `bun run test` is not wired to the built-in runner, fall back to `bun test spec/tests/import-descriptor.test.js`.

- [ ] **Step 4: Import the new helpers in `src/main.js`.** Find the existing source-kind import near the top of the file (the one that brings in `detectKindFromPath`, referenced by the comment at `:285`). Add the two new names to that import list.

Before (the existing import — locate the exact line with `grep -n "from \"./source-kind.js\"" src/main.js`):
```js
import { detectKindFromPath, FLOW_EXTS, IMAGE_EXTS } from "./source-kind.js";
```
After:
```js
import { detectKindFromPath, FLOW_EXTS, IMAGE_EXTS, fileToDescriptor, sanitizeImportName } from "./source-kind.js";
```

- [ ] **Step 5: Convert boot to async store detection in `src/main.js:79-82`.** This satisfies the pinned `autoDetectStore()` + `init()` contract (OPFS preferred on web). Note `await initAllProviderKeys()` already runs as top-level await at `:88`, so an additional top-level await here is consistent with the module.

Before (`:79-82`):
```js
const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
const fsaStore = IS_TAURI ? null : new FsaStore();
setStore(IS_TAURI ? new TauriStore() : fsaStore);
document.body.dataset.runtime = IS_TAURI ? "tauri" : "web";
```
After:
```js
const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
setStore(await autoDetectStore());
await getStore().init?.();
document.body.dataset.runtime = IS_TAURI ? "tauri" : "web";
```

- [ ] **Step 6: Fix the now-dangling `fsaStore` reference in the folder handler.** Step 5 removed the module-level `fsaStore`; the old `open-folder` handler at `:675` used `fsaStore.pickRoot()`. That whole handler is replaced in Step 9, but to keep the file evaluable in between, first confirm there are no *other* `fsaStore` references besides `:675`.

```
grep -n "fsaStore" src/main.js
```

Expected: only the single occurrence inside the `open-folder` handler (`:675`), which Step 9 deletes. If any other reference exists, stop and reconcile before continuing.

- [ ] **Step 7: Add the `importFiles()` helper in `src/main.js` immediately after `pickBrowserFile` (after `:283`).** Reads each File's bytes, writes them into the store, registers the canonical path in the workspace library, and opens the last one. `pickBrowserFile` at `:261-283` is reused unchanged.

```js
// Web upload model: a chosen/dropped File -> bytes -> store.importDocument
// -> canonical path registered in the workspace library -> loadPdf.
// Documents land in OPFS (or FSA) and survive across sessions; the
// library list is rebuilt from store.listDocuments() on every boot.
async function importFiles(files) {
  const list = Array.from(files || []).filter(Boolean);
  if (list.length === 0) return;
  let lastPath = null;
  for (const file of list) {
    try {
      const { name } = fileToDescriptor(file);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const desc = await getStore().importDocument(name, bytes);
      if (!state.workspace.files.includes(desc.path)) state.workspace.files.push(desc.path);
      lastPath = desc.path;
    } catch (err) {
      console.error("[import] failed for", file?.name, err);
      alert(`Couldn't import ${sanitizeImportName(file?.name)}:\n${err?.message || err}`);
    }
  }
  if (!lastPath) return;
  saveWorkspace();
  await renderWorkspace();
  await loadPdf(lastPath);
}
```

- [ ] **Step 8: Replace the two toolbar buttons in `index.html:22-29` with one Import affordance.**

Before (`:22-29`):
```html
          <button id="open-file" class="toolbar-btn" title="Open file">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6"/><path d="M9 2v4h4"/></svg>
            <span>File</span>
          </button>
          <button id="open-folder" class="toolbar-btn" title="Open folder">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5Z"/></svg>
            <span>Folder</span>
          </button>
```
After:
```html
          <button id="import-pdf" class="toolbar-btn" title="Import a PDF">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 10V2"/><path d="M5 5l3-3 3 3"/><path d="M3 11v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2"/></svg>
            <span>Import PDF</span>
          </button>
```

- [ ] **Step 9: Replace the `open-file` and `open-folder` click handlers in `src/main.js:648-695` with one import handler + drag-drop.** Delete the full block from `document.getElementById("open-file").addEventListener(...)` (`:648`) through the end of the `open-folder` handler (`:695`, the closing `});`). Leave the `clear-workspace` handler at `:697` intact.

Replacement block:
```js
const importBtn = document.getElementById("import-pdf");
importBtn.addEventListener("click", async () => {
  const file = await pickBrowserFile([
    { description: "Documents", accept: { "application/octet-stream": [".pdf", ".md", ".markdown", ".docx", ".txt", ".text", ".png", ".jpg", ".jpeg"] } },
  ]);
  if (!file) return;
  await importFiles([file]);
});

// Drag-and-drop anywhere on the app imports the dropped files.
const dropTarget = document.getElementById("app");
["dragenter", "dragover"].forEach((evt) =>
  dropTarget.addEventListener(evt, (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    document.body.dataset.dragging = "1";
  }),
);
["dragleave", "drop"].forEach((evt) =>
  dropTarget.addEventListener(evt, (e) => {
    if (evt === "dragleave" && e.relatedTarget && dropTarget.contains(e.relatedTarget)) return;
    delete document.body.dataset.dragging;
  }),
);
dropTarget.addEventListener("drop", async (e) => {
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;
  e.preventDefault();
  await importFiles(files);
});
```

(`#app` is the wrapper div at `index.html:19`; confirm with `grep -n 'id="app"' index.html`.)

- [ ] **Step 10: Render the empty-state in `renderWorkspace()` (`src/main.js:721`).** The current body iterates `state.workspace.folders` then loose `files`. Add an empty-state line right after `fileListEl.innerHTML = "";` (`:722`) so an empty OPFS library shows guidance instead of a blank list.

Before (`:721-722`):
```js
async function renderWorkspace() {
  fileListEl.innerHTML = "";
```
After:
```js
async function renderWorkspace() {
  fileListEl.innerHTML = "";
  const isEmptyLibrary =
    state.workspace.folders.length === 0 && state.workspace.files.length === 0;
  if (isEmptyLibrary && !IS_TAURI) {
    const li = document.createElement("li");
    li.className = "ws-empty";
    li.textContent = "No documents yet — click Import PDF or drop a file here.";
    fileListEl.appendChild(li);
  }
```

- [ ] **Step 11: Hydrate the library from the store on boot.** Find the existing first-paint call to `renderWorkspace()` (`grep -n "renderWorkspace()" src/main.js` — the boot-time one near `:596`, not the handler-internal ones). Immediately before that boot call, seed `state.workspace.files` from persisted OPFS documents so imports survive reloads. Insert:

```js
// On web, the library list is the set of documents the store has
// persisted (OPFS/FSA). Rebuild it on boot so previously imported
// files reappear across sessions. Tauri keeps its folder-based model.
if (!IS_TAURI && getStore().capabilities().kind !== "tauri") {
  try {
    const docs = await getStore().listDocuments();
    state.workspace.folders = [];
    state.workspace.files = docs.map((d) => d.path);
  } catch (err) {
    console.warn("[boot] listDocuments failed", err);
  }
}
```

(Place this in the same top-level async region as the boot `renderWorkspace()`; it must run after `setStore`/`init` from Step 5. If the boot `renderWorkspace()` is inside a function rather than top-level, put this seed line at the start of that function guarded by a `let libraryHydrated` flag so it runs once.)

- [ ] **Step 12: Manual verification — import + persistence (browser-only; cannot be unit-tested in bun because it needs OPFS, `File`, and drag events).**

```
bun run dev
```
Then in the browser (Chromium or Safari):
1. Confirm the sidebar shows a single "Import PDF" button and the file list shows "No documents yet — click Import PDF or drop a file here."
2. Drag a `.pdf` from the desktop onto the app window. Expected: it imports, the PDF renders in the viewer, and its filename appears in the workspace list (active/highlighted).
3. Click "Import PDF", pick a second PDF via the dialog. Expected: it renders and both files are now listed.
4. Reload the page (`Cmd-R`). Expected: both imported documents reappear in the library list (proving OPFS persistence via `listDocuments()` on boot), and clicking one calls `loadPdf` and re-renders it.
5. Open DevTools console — confirm no errors and no dangling `fsaStore`/`open-file`/`open-folder` reference errors.

- [ ] **Step 13: Re-run the full test suite to confirm no regressions, then commit.**

```
bun run test spec/tests/ && git add src/source-kind.js spec/tests/import-descriptor.test.js src/main.js index.html && git commit -m "Web import: upload/drag-drop documents into OPFS + persistent library list

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: existing suites (`anchoring`, `kind-detection`, `markrank`, `normalize`) plus the new `import-descriptor` all PASS; commit succeeds on the `marklee-polish-and-storage` branch.

### Task 4: Strip desktop-only Tauri features

**Files:**
- Create: `src/storage/download.js` (pure helper factored out of `saveFile`)
- Modify: `src/main.js` — `saveFile` (currently file:90–129), `revealInFinder` (file:3580–3592), breadcrumb reveal wiring (file:360, file:374), recent-row reveal wiring (file:2756–2762)
- Modify: `index.html` — drag-region attributes (file:10–11)
- Test: `spec/tests/download.test.js`

**Interfaces:**
- Consumes: `getStore().copyImageToClipboard(path, imagePath)` (already routed through the AnnotStore contract — FsaStore/OpfsStore implement it via the browser Clipboard API; no change needed here). `capabilities()->{...,persistentPaths}`.
- Produces:
  - `export function buildDownloadBlob({ content, mimeType }): Blob` — wraps string/ArrayBuffer/Uint8Array/Blob into a `Blob` with the right type.
  - `export function triggerDownload(blob, suggestedName): void` — DOM glue (object URL + temporary `<a download>` + click + revoke). Browser-only, not unit-tested.
  - `saveFile({ suggestedName, mimeType, content }): Promise<string|null>` in main.js — unchanged signature; on web uses `showSaveFilePicker` when available, else `triggerDownload`. No `IS_TAURI` branch.

---

- [ ] **Step 1: Read the current `saveFile` source.** Open `src/main.js` lines 90–129 and confirm the current shape before editing:

```js
async function saveFile({ suggestedName, mimeType, content }) {
  const isText = typeof content === "string";
  if (IS_TAURI) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const chosen = await save({ defaultPath: suggestedName });
    if (!chosen) return null;
    const bytes = isText ? new TextEncoder().encode(content) : new Uint8Array(content);
    await invoke("write_file", { path: chosen, bytes: Array.from(bytes) });
    return chosen;
  }
  if ("showSaveFilePicker" in window) {
    // ... FSA picker path ...
  }
  const blob = isText
    ? new Blob([content], { type: mimeType })
    : (content instanceof Blob ? content : new Blob([content], { type: mimeType }));
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return suggestedName;
}
```

- [ ] **Step 2: Create the pure download helper module.** Write `src/storage/download.js`:

```js
// Browser download glue, split into a pure Blob builder (unit-tested) and
// the DOM trigger (manual-verified). Replaces the desktop-only
// invoke("write_file", ...) path that existed in the Tauri build.

// Normalize whatever a caller hands us (text, ArrayBuffer, typed array, or an
// already-built Blob) into a single Blob tagged with mimeType.
export function buildDownloadBlob({ content, mimeType }) {
  if (content instanceof Blob) return content;
  const type = mimeType || "application/octet-stream";
  if (typeof content === "string") return new Blob([content], { type });
  // ArrayBuffer / TypedArray / DataView all accept being wrapped directly.
  return new Blob([content], { type });
}

// DOM-only: create an object URL, click a temporary <a download>, then revoke.
// Not unit-testable under bun (no DOM) — verified manually.
export function triggerDownload(blob, suggestedName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

- [ ] **Step 3: Add the import for the helper in main.js.** After the `FsaStore` import (file:45), add:

```js
import { buildDownloadBlob, triggerDownload } from "./storage/download.js";
```

- [ ] **Step 4: Replace `saveFile` body — remove the Tauri/`write_file` branch.** Edit `src/main.js`. Replace the whole function (lines 90–129) with:

```js
async function saveFile({ suggestedName, mimeType, content }) {
  const isText = typeof content === "string";
  if ("showSaveFilePicker" in window) {
    try {
      const ext = suggestedName.includes(".") ? "." + suggestedName.split(".").pop() : "";
      const types = mimeType
        ? [{ description: mimeType, accept: { [mimeType]: ext ? [ext] : [] } }]
        : undefined;
      const handle = await window.showSaveFilePicker({ suggestedName, types });
      const writable = await handle.createWritable();
      await writable.write(isText ? content : (content instanceof Blob ? content : new Blob([content], { type: mimeType })));
      await writable.close();
      return handle.name;
    } catch (err) {
      if (err && err.name === "AbortError") return null;
      throw err;
    }
  }
  triggerDownload(buildDownloadBlob({ content, mimeType }), suggestedName);
  return suggestedName;
}
```

This drops the `invoke("write_file", ...)` call entirely and routes the no-picker fallback through the factored helper. (Note: this keeps `IS_TAURI` defined for Tasks 2/3 — we only removed its use here.)

- [ ] **Step 5: Make `revealInFinder` a clean silent no-op on web.** Edit `src/main.js` lines 3580–3592. The function currently dynamically `import`s `@tauri-apps/api/core` and invokes `reveal_in_finder`. Replace with a no-op that early-returns before any Tauri import:

```js
async function revealInFinder(path) {
  // Desktop-only (Finder/Explorer reveal). On web there is no OS file path to
  // reveal, so this is intentionally a no-op — the breadcrumb / recent-row
  // click handlers still call it but nothing happens. Kept as a function so
  // those call sites don't need conditional wiring.
  if (!IS_TAURI) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("reveal_in_finder", { path });
  } catch (err) {
    console.error("[reveal] failed", err);
    alert(`Couldn't open in Finder:\n${err}`);
  }
}
```

The breadcrumb wiring (file:360, file:374) and recent-row wiring (file:2756–2762) are left untouched — they call `revealInFinder(...)` which now returns immediately on web. No button is removed; the path text simply isn't clickable-to-Finder on web, which is the desired Phase-1 behavior.

- [ ] **Step 6: Neutralize `data-tauri-drag-region` in index.html.** These attributes are only meaningful to the Tauri webview's custom window chrome; in a browser tab they are inert (no handler reads them), so removing them is the no-op-on-web requirement. Edit `index.html` lines 10–11:

```html
    <div id="workspace-tabs">
      <div id="ws-traffic-spacer"></div>
```

(was `<div id="workspace-tabs" data-tauri-drag-region>` and `<div id="ws-traffic-spacer" data-tauri-drag-region></div>`). The `ws-traffic-spacer` element stays for macOS traffic-light spacing in any future desktop build but carries no web behavior.

- [ ] **Step 7: Confirm clipboard already routes through the store (no edit).** Verify with grep that both clipboard call sites use the store contract and that no direct Tauri invoke remains:

```
grep -n "copyImageToClipboard\|copy_image_to_clipboard" src/main.js
```
Expected output: only the two `getStore().copyImageToClipboard(...)` calls at ~file:4150 and ~file:4756 — and NO `invoke("copy_image_to_clipboard", ...)`. FsaStore (src/storage/fsa-store.js:169) already implements it via `navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])`, and OpfsStore (Task 1) does the same. No code change in this task.

- [ ] **Step 8: Write the unit test for the pure helper.** Create `spec/tests/download.test.js`:

```js
// Unit tests for the pure part of the browser download helper
// (src/storage/download.js). buildDownloadBlob() is the load-bearing,
// DOM-free piece that replaced the desktop-only invoke("write_file").
// triggerDownload() is DOM glue and is verified manually (see Task 4).

import { describe, test, expect } from "bun:test";
import { buildDownloadBlob } from "../../src/storage/download.js";

describe("buildDownloadBlob", () => {
  test("wraps a string and applies the given mime type", async () => {
    const blob = buildDownloadBlob({ content: "hello", mimeType: "text/plain" });
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/plain");
    expect(await blob.text()).toBe("hello");
  });

  test("falls back to octet-stream when mime type is missing", () => {
    const blob = buildDownloadBlob({ content: "x", mimeType: undefined });
    expect(blob.type).toBe("application/octet-stream");
  });

  test("wraps binary bytes (Uint8Array) into a Blob", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const blob = buildDownloadBlob({ content: bytes, mimeType: "image/png" });
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(4);
    const out = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(out)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("passes an existing Blob through unchanged", () => {
    const original = new Blob(["abc"], { type: "text/csv" });
    const blob = buildDownloadBlob({ content: original, mimeType: "text/plain" });
    expect(blob).toBe(original);
    expect(blob.type).toBe("text/csv");
  });
});
```

- [ ] **Step 9: Run the new test.** Run:

```
bun run test spec/tests/download.test.js
```
Expected: PASS — 4 tests pass (`buildDownloadBlob` block).

- [ ] **Step 10: Run the full suite to confirm no regressions.** Run:

```
bun run test spec/tests/
```
Expected: PASS — all existing tests (anchoring, kind-detection, markrank, normalize) plus the new download tests pass.

- [ ] **Step 11: MANUAL verification — Blob download in the browser.** This exercises `triggerDownload` (DOM glue, not unit-testable in bun):
  1. `bun run dev` and open the printed localhost URL in a browser.
  2. Open any document, then trigger an export that calls `saveFile` (e.g. export/save action in the UI).
  3. In a browser **without** File System Access save support (or after dismissing the picker fallback path), confirm the file downloads via the browser download bar with the correct filename, and that the browser console shows **no** Tauri/`invoke`/`write_file` errors.

- [ ] **Step 12: MANUAL verification — copy-image-to-clipboard on web.** With `bun run dev` running and a document open that has an image/snippet clip:
  1. Trigger "copy image to clipboard" on a clip (the path that calls `getStore().copyImageToClipboard(...)`).
  2. Paste into an external app (e.g. a notes/chat app) and confirm the PNG pastes.
  3. Confirm the console shows no `invoke("copy_image_to_clipboard")` call and no Tauri error — the Clipboard API path in the store handled it.

- [ ] **Step 13: MANUAL verification — reveal no-op + no drag region.** With `bun run dev` running:
  1. Click a path breadcrumb segment and a recent-row folder label — confirm nothing throws (console shows no `reveal_in_finder` invoke / no Tauri import error); the click is simply inert on web.
  2. Confirm the top workspace-tabs bar renders normally and dragging it does not attempt any window-move (it no longer carries `data-tauri-drag-region`).

- [ ] **Step 14: Commit.** Run:

```
git add src/storage/download.js src/main.js index.html spec/tests/download.test.js && git commit -m "Strip desktop-only Tauri features for web shell

Remove write_file/reveal_in_finder invokes and tauri-drag-region; route
file export through a browser Blob download helper. Clipboard copy already
goes through the AnnotStore contract (browser Clipboard API).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 5: Remove BYOK key surface and hide AI until Phase 2

**Files:**
- Create: `src/ai/feature-flags.js` — pure `AI_ENABLED` constant + `isAiEnabled()` helper (Phase 2 flips the constant).
- Create (test): `spec/tests/ai-feature-flag.test.js`.
- Modify: `index.html:308-364` (delete `#ai-settings-modal` block); `index.html:113-120` (gate `#ai-ask-bar`).
- Modify: `src/main.js:64-69` (drop `initAllProviderKeys` import), `src/main.js:88` (drop `await initAllProviderKeys()`), `src/main.js:1175-1185` (gate `aiAsk`), `src/main.js:2156` (gate ask-submit binding), `src/main.js:2188-2229` (delete settings-modal bindings).
- Modify: `src/ai/anthropic.js:23-76`, `src/ai/openai.js:18-70`, `src/ai/gemini.js:27-76` (remove `_invoke`, `initApiKeyStore`, `setApiKey`, localStorage key fallback; keep `getApiKey`/`hasApiKey` returning the in-memory `_cachedKey`).
- Modify: `src/ai/providers.js:65-74` (delete `initAllProviderKeys`), `:101-103` and `:127-129` (delete `setApiKey`/`setProviderApiKey` forwarders).

**Interfaces:**
- Produces: `isAiEnabled(): boolean` (from `src/ai/feature-flags.js`), `AI_ENABLED: boolean` constant.
- Consumes: nothing new. Removes exports `initAllProviderKeys()`, `setApiKey(key)`, `setProviderApiKey(id,key)` from `providers.js`, and `initApiKeyStore()` / `setApiKey()` from the three provider modules.
- Untouched / still exported for Phase 2: `callMessages`, `getApiKey`, `hasApiKey`, `getModel`, `setModel`, `getMaxOutputTokens`, `getProviderHasKey`, `getProviderModel`, `setProviderModel`, plus `reader.js`/`planner.js`/`figure-detect.js`/`onnx-layout.js` request-building code.

---

- [ ] **Step 1: Create the feature-flag module.** Write `src/ai/feature-flags.js`:
```js
// Single switch that gates every AI entry point in the UI. Phase 1 is a
// browser-only shell with NO backend / AI server, so the "Ask" surface and
// the BYOK key UI are hidden. Phase 2 flips AI_ENABLED to true once the
// server proxy exists — reader.js / planner.js / providers.js stay intact
// behind this flag and are reused then.
export const AI_ENABLED = false;

export function isAiEnabled() {
  return AI_ENABLED === true;
}
```

- [ ] **Step 2: Unit-test the helper.** Write `spec/tests/ai-feature-flag.test.js`:
```js
import { test, expect, describe } from "bun:test";
import { isAiEnabled, AI_ENABLED } from "../../src/ai/feature-flags.js";

describe("isAiEnabled", () => {
  test("AI is disabled in Phase 1", () => {
    expect(AI_ENABLED).toBe(false);
    expect(isAiEnabled()).toBe(false);
  });
  test("returns a strict boolean", () => {
    expect(typeof isAiEnabled()).toBe("boolean");
  });
});
```

- [ ] **Step 3: Run the new test (PASS).** Run:
```
bun run test spec/tests/ai-feature-flag.test.js
```
Expect: 2 pass, 0 fail.

- [ ] **Step 4: Delete the `#ai-settings-modal` block from index.html.** Remove the entire block (currently `index.html:308-364`). Before (first/last lines):
```html
    <div id="ai-settings-modal" hidden>
      <div class="modal-backdrop"></div>
      ...
      </div>
    </div>
    <script type="module" src="/src/main.js"></script>
```
After — the modal `<div>` is gone, leaving:
```html
    </div>
    <script type="module" src="/src/main.js"></script>
```
(Delete from the line `<div id="ai-settings-modal" hidden>` through its matching closing `</div>` immediately before `<script type="module" src="/src/main.js">`. Leave the preceding `#ws-import` modal's closing tags intact.)

- [ ] **Step 5: Remove the ask bar + settings button from index.html.** In `index.html:108-120`, delete the settings button and replace the ask bar with a Phase-2 placeholder comment. Before:
```html
            <button id="ai-settings-btn" title="AI settings">
              <svg width="12" height="12" viewBox="0 0 24 24" ...></svg>
            </button>
            <button id="ai-section-collapse" class="pane-section-collapse" title="Collapse / expand AI section">▾</button>
          </div>
          <div id="ai-ask-bar">
            <div class="ai-ask-row">
              <input id="ai-ask-input" placeholder="Ask about this document…   ⌘↵ to send" autocomplete="off" />
              <button id="ai-ask-submit" title="Ask">↵</button>
            </div>
            <div id="ai-loading-bar" aria-hidden="true"></div>
            <span id="ai-ask-status" hidden></span>
          </div>
```
After:
```html
            <button id="ai-section-collapse" class="pane-section-collapse" title="Collapse / expand AI section">▾</button>
          </div>
          <!-- Phase 1: AI Ask surface + BYOK settings hidden behind AI_ENABLED (src/ai/feature-flags.js). Re-enabled in Phase 2 behind the server proxy. -->
          <div id="ai-ask-bar" hidden>
            <div class="ai-ask-row">
              <input id="ai-ask-input" placeholder="Ask about this document…   ⌘↵ to send" autocomplete="off" />
              <button id="ai-ask-submit" title="Ask">↵</button>
            </div>
            <div id="ai-loading-bar" aria-hidden="true"></div>
            <span id="ai-ask-status" hidden></span>
          </div>
```
(We delete `#ai-settings-btn` outright since its only handler is being removed; we keep `#ai-ask-bar`'s inner nodes but add `hidden` and never wire the submit handler, so the elements exist for Phase 2 but are invisible and inert.)

- [ ] **Step 6: Drop `initAllProviderKeys` from the main.js import + boot.** In `src/main.js:64-69`, before:
```js
import {
  PROVIDER_IDS, getProviderId, setProviderId, getProviderDef,
  getProviderHasKey, setProviderApiKey,
  getProviderModel, setProviderModel,
  initAllProviderKeys,
} from "./ai/providers.js";
```
After (also drop `setProviderApiKey`, which is being removed in Step 12):
```js
import {
  PROVIDER_IDS, getProviderId, setProviderId, getProviderDef,
  getProviderHasKey,
  getProviderModel, setProviderModel,
} from "./ai/providers.js";
```
Then delete the boot call at `src/main.js:88`. Before:
```js
// getApiKey() accessors. Single round-trip; the Tauri command is fast.
await initAllProviderKeys();
```
After:
```js
// getApiKey() accessors. Phase 1: AI is gated off (see feature-flags.js),
// so there are no keys to hydrate.
```

- [ ] **Step 7: Add the feature-flag import to main.js.** In `src/main.js:57-59`, before:
```js
import {
  hasApiKey,
} from "./ai/providers.js";
```
After:
```js
import {
  hasApiKey,
} from "./ai/providers.js";
import { isAiEnabled } from "./ai/feature-flags.js";
```

- [ ] **Step 8: Gate `aiAsk()`.** In `src/main.js:1175-1185`, before:
```js
async function aiAsk() {
  if (aiInFlight) return;
  const input = document.getElementById("ai-ask-input");
  const query = (input.value || "").trim();
  if (!query) return;

  if (!hasApiKey()) {
    aiSetStatus("Set your Anthropic API key in AI settings.", "error");
    openAiSettings();
    return;
  }
```
After:
```js
async function aiAsk() {
  if (!isAiEnabled()) return; // Phase 1: AI disabled — no server proxy yet.
  if (aiInFlight) return;
  const input = document.getElementById("ai-ask-input");
  const query = (input.value || "").trim();
  if (!query) return;

  if (!hasApiKey()) {
    aiSetStatus("AI is not available yet.", "error");
    return;
  }
```
(`openAiSettings` is removed in Step 9; this also drops the only caller of it.)

- [ ] **Step 9: Remove the AI-settings modal DOM bindings and gate the ask-submit binding in main.js.** In `src/main.js:2156-2229`, before:
```js
document.getElementById("ai-ask-submit").addEventListener("click", aiAsk);
document.getElementById("ai-ask-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    aiAsk();
  } else if (e.key === "Escape") {
    e.target.blur();
  }
});
```
After (wrap so no handler is attached when AI is off):
```js
if (isAiEnabled()) {
  document.getElementById("ai-ask-submit").addEventListener("click", aiAsk);
  document.getElementById("ai-ask-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      aiAsk();
    } else if (e.key === "Escape") {
      e.target.blur();
    }
  });
}
```
Then delete the entire settings-modal binding block (`src/main.js:2183-2229`), from the comment header through the `ai-settings-clear` handler's closing `});`. Before:
```js
// ── AI settings modal ────────────────────────────────────────────
// openAiSettings, closeAiSettings, rebuildAiModelDropdown,
// updateAiKeyFieldForProvider moved to src/ai-panel.js in Wave 3.
// DOM event bindings (ai-settings-btn click, provider change, save,
// clear) stay here so the wiring is centralized.
document.getElementById("ai-settings-btn").addEventListener("click", openAiSettings);
document.getElementById("ai-settings-close").addEventListener("click", closeAiSettings);
document.getElementById("ai-settings-modal").querySelector(".modal-backdrop").addEventListener("click", closeAiSettings);
document.getElementById("ai-settings-key").addEventListener("input", (e) => {
  e.target.dataset.touched = "1";
});
document.getElementById("ai-settings-provider").addEventListener("change", (e) => {
  ...
});
document.getElementById("ai-settings-save").addEventListener("click", async () => {
  ...
});
document.getElementById("ai-settings-clear").addEventListener("click", async () => {
  ...
});
```
After:
```js
// ── AI settings modal ────────────────────────────────────────────
// Phase 1: the BYOK key UI and its DOM bindings were removed. The settings
// modal (#ai-settings-modal) no longer exists in index.html. ai-panel.js
// (openAiSettings/closeAiSettings/rebuildAiModelDropdown/updateAiKeyFieldForProvider)
// is kept intact for Phase 2 but is no longer wired to any trigger.
```
(This removes the last references to `openAiSettings`, `closeAiSettings`, `rebuildAiModelDropdown`, `updateAiKeyFieldForProvider`, `setProviderApiKey`, `setConsented`, `setIncludeFigures` from the binding block. Leave the `src/main.js:34-43` `ai-panel.js` import statement as-is — those functions stay exported for Phase 2; an unused import is not an error in Vite/Bun.)

- [ ] **Step 10: Verify main.js still parses (no dropped-symbol references).** Run grep to confirm the removed symbols are no longer referenced in main.js:
```
grep -n "initAllProviderKeys\|setProviderApiKey\|ai-settings-btn\|ai-settings-save\|ai-settings-clear\|ai-settings-modal\|ai-settings-provider\|ai-settings-key" /Users/jung/PersonalProjects/pdf-annotator/src/main.js
```
Expect: no output (exit 1). If any line prints, fix that reference before proceeding.

- [ ] **Step 11: Strip the BYOK paths from `src/ai/anthropic.js`.** Replace `src/ai/anthropic.js:18-76`. Before:
```js
const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

let _cachedKey = "";
let _hydrated = false;

async function _invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// Called once from main.js startup. Hydrates the in-memory cache from
// the encrypted store, migrating any pre-encryption plaintext key from
// localStorage on first run.
export async function initApiKeyStore() {
  ...
  _cachedKey = k;
}

export function getApiKey() { return _cachedKey; }
export function hasApiKey() { return !!_cachedKey; }

export async function setApiKey(key) {
  ...
  _cachedKey = v;
}
```
After:
```js
// Phase 1: AI is disabled (see src/ai/feature-flags.js) and there is no
// backend yet, so the BYOK key surface is gone. The in-memory cache stays
// empty; Phase 2 will supply credentials via the server proxy. The legacy
// Tauri set_provider_key / get_provider_key paths and the localStorage
// fallback were removed.
let _cachedKey = "";

export function getApiKey() { return _cachedKey; }
export function hasApiKey() { return !!_cachedKey; }
```
Also delete the now-stale `LEGACY_KEY_STORAGE` constant (`src/ai/anthropic.js:12`) and update the file-header comment (`:1-7`) that describes `initApiKeyStore()`. Before (`:1-7`):
```js
// Minimal Anthropic Messages API client for Marklee.
//
// API key is stored encrypted at rest via the Rust-side commands
// set_provider_key / get_provider_key (AES-256-GCM with a machine-
// bound key — see src-tauri/src/secrets.rs). An in-memory cache
// keeps getApiKey() / hasApiKey() synchronous; main.js awaits
// initApiKeyStore() at startup before any AI UI is reachable.
```
After:
```js
// Minimal Anthropic Messages API client for Marklee.
//
// Phase 1 (browser-only shell) has no backend and AI is disabled, so the
// key store is gone. callMessages() and the request-building code below
// are kept intact for Phase 2, where credentials arrive via a server proxy
// rather than BYOK. getApiKey()/hasApiKey() report an empty in-memory cache.
```

- [ ] **Step 12: Strip the BYOK paths from `src/ai/openai.js`.** Replace `src/ai/openai.js:13-70` analogously. Before:
```js
const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

let _cachedKey = "";
let _hydrated = false;

async function _invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// See src/ai/anthropic.js — same pattern. ...
export async function initApiKeyStore() {
  ...
  _cachedKey = k;
}

export function getApiKey() { return _cachedKey; }
export function hasApiKey() { return !!_cachedKey; }

export async function setApiKey(key) {
  ...
  _cachedKey = v;
}
```
After:
```js
// Phase 1: AI disabled, no backend — BYOK key store removed (see
// src/ai/anthropic.js for the rationale). Phase 2 supplies credentials via
// the server proxy.
let _cachedKey = "";

export function getApiKey() { return _cachedKey; }
export function hasApiKey() { return !!_cachedKey; }
```
Also delete `LEGACY_KEY_STORAGE` (`src/ai/openai.js:9`).

- [ ] **Step 13: Strip the BYOK paths from `src/ai/gemini.js`.** Replace `src/ai/gemini.js:22-76` analogously. Before:
```js
const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

let _cachedKey = "";
let _hydrated = false;

async function _invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export async function initApiKeyStore() {
  ...
  _cachedKey = k;
}

export function getApiKey() { return _cachedKey; }
export function hasApiKey() { return !!_cachedKey; }

export async function setApiKey(key) {
  ...
  _cachedKey = v;
}
```
After:
```js
// Phase 1: AI disabled, no backend — BYOK key store removed (see
// src/ai/anthropic.js for the rationale). Phase 2 supplies credentials via
// the server proxy.
let _cachedKey = "";

export function getApiKey() { return _cachedKey; }
export function hasApiKey() { return !!_cachedKey; }
```
Also delete `LEGACY_KEY_STORAGE` (`src/ai/gemini.js:18`).

- [ ] **Step 14: Remove `initAllProviderKeys` and the `setApiKey` forwarders from `src/ai/providers.js`.** Delete the block at `src/ai/providers.js:65-74`. Before:
```js
// Hydrate every provider's encrypted-key cache before the UI consults
// hasApiKey()/getApiKey(). Called once from main.js startup.
export async function initAllProviderKeys() {
  await Promise.all(
    PROVIDER_IDS.map((id) => {
      const mod = PROVIDER_DEFS[id].module;
      return mod.initApiKeyStore ? mod.initApiKeyStore() : Promise.resolve();
    })
  );
}

export function getProviderId() {
```
After:
```js
export function getProviderId() {
```
Delete the unified `setApiKey` forwarder (`src/ai/providers.js:101-103`). Before:
```js
export function getApiKey() {
  return activeProvider().module.getApiKey();
}
export function setApiKey(key) {
  return activeProvider().module.setApiKey(key);
}
export function getModel() {
```
After:
```js
export function getApiKey() {
  return activeProvider().module.getApiKey();
}
export function getModel() {
```
Delete the per-provider `setProviderApiKey` forwarder (`src/ai/providers.js:127-129`). Before:
```js
export function getProviderHasKey(id) {
  return getProviderDef(id).module.hasApiKey();
}
export function setProviderApiKey(id, key) {
  return getProviderDef(id).module.setApiKey(key);
}
export function getProviderModel(id) {
```
After:
```js
export function getProviderHasKey(id) {
  return getProviderDef(id).module.hasApiKey();
}
export function getProviderModel(id) {
```

- [ ] **Step 15: Confirm no remaining references to the removed key API across src/.** Run:
```
grep -rn "initApiKeyStore\|initAllProviderKeys\|setApiKey\|setProviderApiKey\|set_provider_key\|get_provider_key\|LEGACY_KEY_STORAGE" /Users/jung/PersonalProjects/pdf-annotator/src /Users/jung/PersonalProjects/pdf-annotator/index.html
```
Expect: only hits inside `src/ai-panel.js` (its internal Save/Clear helpers, which are now dead code retained for Phase 2 and no longer imported by main.js) — and NO hits in `main.js`, `providers.js`, `anthropic.js`, `openai.js`, `gemini.js`, or `index.html`. If `ai-panel.js` references `setProviderApiKey` from `providers.js`, note it: those functions are unused dead code in Phase 1; leaving them is acceptable since ai-panel.js is no longer wired to any trigger. (Do not delete ai-panel.js — Phase 2 reuses it.)

- [ ] **Step 16: Run the full bun test suite (PASS).** Run:
```
bun run test spec/tests/
```
Expect: all suites pass, including the existing `anchoring`, `kind-detection`, `markrank`, `normalize` tests and the new `ai-feature-flag` test. No import-resolution errors from the edited modules.

- [ ] **Step 17: MANUAL browser verification (cannot be unit-tested — DOM + bundler glue).** Run `bun run dev`, open the app in a browser, and confirm ALL of:
  1. Open DevTools Console BEFORE the page finishes loading. No errors referencing `initAllProviderKeys`, `setProviderApiKey`, `setApiKey`, `ai-settings-btn`, or any "Cannot read properties of null (addEventListener)" from the removed `#ai-settings-*` elements.
  2. The AI section header is present but there is NO gear/settings button (`#ai-settings-btn` is gone) — verify via "Inspect" that no element with id `ai-settings-btn` exists.
  3. The "Ask about this document…" input + `↵` submit button are not visible (the `#ai-ask-bar` carries the `hidden` attribute). In DevTools, `document.getElementById('ai-settings-modal')` returns `null`.
  4. There is no way to open a key-entry modal: clicking anywhere in the AI section does not surface a key field, and `document.querySelector('#ai-settings-key')` returns `null`.
  
  Record PASS only if all four hold. This step replaces an in-browser unit test for the gating, which cannot run under bun.

- [ ] **Step 18: Commit.** Run:
```
git add src/ai/feature-flags.js spec/tests/ai-feature-flag.test.js src/main.js index.html src/ai/anthropic.js src/ai/openai.js src/ai/gemini.js src/ai/providers.js && git commit -m "Phase 1: remove BYOK key UI, gate AI behind AI_ENABLED flag

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
