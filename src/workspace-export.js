// Workspace backup: export every document's Marklee annotations (sidecars +
// image clips, inlined as base64) into one re-importable JSON file, and import
// it back. This is the durability story for the local-first (OPFS) web build —
// OPFS can be evicted or cleared, so this is the user's backup + the way to
// move work to another browser/device.
//
// Source PDFs are NOT bundled (they're large and the user has the originals);
// on restore, re-import the PDFs and these annotations re-attach to them by
// the same OPFS path. contentHash is recorded for verification.
import { getStore } from "./storage/store.js";
import { buildDownloadBlob, triggerDownload } from "./storage/download.js";

const BUNDLE_KIND = "marklee-workspace-export";
const BUNDLE_VERSION = "0.1";

function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < arr.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// imagePath is ".marklee/clips/<id>.png" (relative to the sidecar); writeClip
// takes the bare clip id, so recover it from the stored path.
function clipIdFromPath(imagePath) {
  const name = (imagePath || "").split("/").pop() || "";
  return name.replace(/\.png$/i, "");
}

export async function exportWorkspace(docPaths) {
  const store = getStore();
  const documents = [];
  for (const path of docPaths || []) {
    let annot;
    try {
      annot = await store.readAnnot(path);
    } catch {
      continue;
    }
    if (!annot) continue;
    const { _mtimeMs, ...clean } = annot; // drop runtime-only field
    const hasContent =
      (clean.snippets || []).length || (clean.edges || []).length || (clean.groups || []).length;
    if (!hasContent) continue; // skip docs with no annotations

    const clips = [];
    for (const s of clean.snippets || []) {
      if (s.kind === "image" && s.imagePath) {
        try {
          const bytes = await store.readClip(path, s.imagePath);
          clips.push({ imagePath: s.imagePath, base64: bytesToBase64(bytes) });
        } catch {
          /* clip missing — skip; the snippet's rect still re-renders from source */
        }
      }
    }
    documents.push({
      path,
      contentHash: clean.source?.contentHash || null,
      annot: clean,
      clips,
    });
  }

  const bundle = {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    documentCount: documents.length,
    documents,
  };
  const stamp = new Date().toISOString().slice(0, 10);
  triggerDownload(
    buildDownloadBlob({ content: JSON.stringify(bundle, null, 2), mimeType: "application/json" }),
    `marklee-workspace-${stamp}.json`,
  );
  return documents.length;
}

export async function importWorkspace(file) {
  const store = getStore();
  let bundle;
  try {
    bundle = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (bundle?.kind !== BUNDLE_KIND || !Array.isArray(bundle.documents)) {
    throw new Error("Not a Marklee workspace export file.");
  }

  let docs = 0;
  let snippets = 0;
  for (const d of bundle.documents) {
    if (!d?.path || !d.annot) continue;
    // Write clips first so the snippets' imagePaths resolve after import.
    for (const c of d.clips || []) {
      if (!c?.imagePath || !c.base64) continue;
      try {
        await store.writeClip(d.path, clipIdFromPath(c.imagePath), base64ToBytes(c.base64));
      } catch {
        /* clip write failed — annotation still imports */
      }
    }
    try {
      await store.writeAnnot(d.path, d.annot, -1); // -1 = overwrite, skip mtime check
      docs++;
      snippets += (d.annot.snippets || []).length;
    } catch {
      /* skip this doc */
    }
  }
  return { docs, snippets };
}
