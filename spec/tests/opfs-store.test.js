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
