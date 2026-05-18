import { invoke } from "@tauri-apps/api/core";

const KIND_BY_EXT = { pdf: "pdf", md: "markdown", markdown: "markdown", docx: "docx" };
function kindFromPath(p) {
  const m = (p || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? KIND_BY_EXT[m[1]] || null : null;
}

export class TauriStore {
  capabilities() {
    return { rectClips: true, persistentPaths: true, kind: "tauri" };
  }

  async listDocuments(dir) {
    if (!dir) throw new Error("listDocuments(dir) requires a directory path");
    const docs = await invoke("list_documents", { dir });
    return docs.map((d) => ({
      path: d.path,
      name: d.path.split("/").pop() || d.path,
      kind: d.kind,
    }));
  }

  async readDocumentBytes(path) {
    const bytes = await invoke("read_pdf", { path });
    return new Uint8Array(bytes);
  }

  async readAnnot(path) {
    // Rust side flattens AnnotFile + adds _mtimeMs (0 when sidecar
    // doesn't exist). normalizeAnnotFile passes the extra field through.
    const af = await invoke("read_annot", { pdfPath: path });
    return normalizeAnnotFile(af, path);
  }

  // expectedMtimeMs:
  //   -1 → skip the check (explicit user-consent overwrite)
  //    0 → caller expects no prior file (first write)
  //   >0 → must match the sidecar's current mtime, else returns conflict
  // Returns { ok, mtimeMs, conflict? } from the Rust side.
  async writeAnnot(path, annot, expectedMtimeMs = -1) {
    return await invoke("write_annot", {
      pdfPath: path,
      payload: annot,
      expectedMtimeMs,
    });
  }

  async readGlobalGroups() {
    return await invoke("read_global_groups");
  }

  async writeGlobalGroups(groups) {
    await invoke("write_global_groups", { groups });
  }

  async writeClip(path, clipId, bytes) {
    return await invoke("write_clip", { pdfPath: path, clipId, bytes: Array.from(bytes) });
  }

  async readClip(path, imagePath) {
    const bytes = await invoke("read_clip", { pdfPath: path, imagePath });
    return new Uint8Array(bytes);
  }

  async deleteClip(path, imagePath) {
    await invoke("delete_clip", { pdfPath: path, imagePath });
  }

  async copyImageToClipboard(path, imagePath) {
    await invoke("copy_image_to_clipboard", { pdfPath: path, imagePath });
  }

  async checkPaths(paths) {
    return await invoke("check_paths", { paths });
  }
}

function normalizeAnnotFile(af, path) {
  af = af || {};
  af.source = af.source || { path, filename: path.split("/").pop() || path };
  if (!af.source.kind) af.source.kind = kindFromPath(path) || "pdf";
  af.snippets = af.snippets || [];
  af.edges = af.edges || [];
  af.groups = af.groups || [];
  // _mtimeMs is added by the Rust read_annot wrapper; default to 0 so
  // callers can treat absence as "no prior file" uniformly.
  if (typeof af._mtimeMs !== "number") af._mtimeMs = 0;
  return af;
}
