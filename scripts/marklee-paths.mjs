// Shared sidecar / global-groups path resolution for the CLI tools.
//
// Mirrors the app's storage layer (src/storage/*, src-tauri/src/lib.rs):
// sidecars and clips live in a hidden per-directory `.marklee/` folder
// beside the source document; global groups live at `~/.marklee/groups.json`.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const STORE_DIR = ".marklee";

// Sidecar path: <dir>/.marklee/<filename>.annot.json
export function sidecarPath(docPath) {
  return path.join(path.dirname(docPath), STORE_DIR, `${path.basename(docPath)}.annot.json`);
}

// The sidecar to read, or null when none exists.
export function resolveSidecar(docPath) {
  const p = sidecarPath(docPath);
  return existsSync(p) ? p : null;
}

// Ensure a document's `.marklee/` folder exists before writing into it.
export async function ensureStoreDir(docPath) {
  await mkdir(path.join(path.dirname(docPath), STORE_DIR), { recursive: true });
}

// Global groups index: ~/.marklee/groups.json
export function groupsPath() {
  return path.join(process.env.HOME || os.homedir(), ".marklee", "groups.json");
}
