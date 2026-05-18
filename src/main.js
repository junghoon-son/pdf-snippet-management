import "pdfjs-dist/web/pdf_viewer.css";
import { open } from "@tauri-apps/plugin-dialog";
import {
  loadDocument as loadPdfDocument,
  renderPages,
  fitWidthScale,
  getSelectionSnippet,
  applyHighlights,
  renderRegionPng,
  ensurePageRendered,
  setHoverSnippetId,
  pulseSnippet,
} from "./pdf-viewer.js";
import * as FlowView from "./flow-viewer.js";
import * as MapView from "./map-view.js";
import * as LineageView from "./lineage-view.js";
import { openGroupOverlay } from "./group-overlay.js";
import { setStore, getStore } from "./storage/store.js";
import {
  setup as setupClipboard,
  createPastedTextSnippet,
  createPastedImageSnippet,
  PASTED_PSEUDO_PATH,
} from "./clipboard.js";
import {
  setup as setupPersistence,
  persist,
  flushPersist,
  persistImmediate,
  pruneOrphanGroups,
} from "./persistence.js";
import {
  setup as setupAiPanel,
  aiSetStatus,
  aiSetBusy,
  mergeRectsIntoBands,
  rebuildAiModelDropdown,
  updateAiKeyFieldForProvider,
  openAiSettings,
  closeAiSettings,
} from "./ai-panel.js";
import { TauriStore } from "./storage/tauri-store.js";
import { FsaStore } from "./storage/fsa-store.js";
import { computeMarkRank, rankPercentiles } from "./markrank.js";
import { buildPermalink, parsePermalink } from "./marklee-permalink.js";
import { runReader } from "./ai/reader.js";
import { planQuery } from "./ai/planner.js";
import { extractPdfText, extractFlowText, extractPdfPageImages, extractPdfPageTextContent, findCaptionRectInPageContent } from "./ai/doc-text.js";
import { resolveQuoteToSnippet } from "./ai/resolver.js";
import { detectFiguresPerPage, detectFiguresHybrid } from "./ai/figure-detect.js";
import {
  isOnnxLayoutEnabled, setOnnxLayoutEnabled,
  runOnnxLayout,
} from "./ai/onnx-layout.js";
import {
  hasApiKey,
} from "./ai/providers.js";
import {
  hasConsented, setConsented,
  getIncludeFigures, setIncludeFigures,
} from "./ai/anthropic.js";
import {
  PROVIDER_IDS, getProviderId, setProviderId, getProviderDef,
  getProviderHasKey, setProviderApiKey,
  getProviderModel, setProviderModel,
  initAllProviderKeys,
} from "./ai/providers.js";
import {
  GROUP_TEMPLATES,
  findTemplate,
  listAllTemplates,
  addUserTemplate,
  deleteUserTemplate,
  isBuiltinTemplate,
} from "./group-templates.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
const fsaStore = IS_TAURI ? null : new FsaStore();
setStore(IS_TAURI ? new TauriStore() : fsaStore);
document.body.dataset.runtime = IS_TAURI ? "tauri" : "web";

// Hydrate every provider's encrypted-key cache before the rest of the
// module evaluates — top-level await pauses execution here, so all UI
// bindings below see the cached keys via the sync hasApiKey() /
// getApiKey() accessors. Single round-trip; the Tauri command is fast.
await initAllProviderKeys();

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

function makeLocateButton(oldPath, mode, folder) {
  const btn = document.createElement("button");
  btn.className = "ws-file-locate";
  btn.textContent = "↻";
  btn.title = "File missing — locate it on disk";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await locateMissingFile(oldPath, mode, folder);
  });
  return btn;
}

async function locateMissingFile(oldPath, mode, folder) {
  let newPath = null;
  try {
    if (IS_TAURI) {
      newPath = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Documents", extensions: ["pdf", "md", "markdown", "docx", "txt", "text"] }],
      });
    } else {
      const file = await pickBrowserFile([{ description: "Document", accept: { "application/octet-stream": [".pdf", ".md", ".markdown", ".docx"] } }]);
      newPath = file ? file.name : null;
    }
  } catch (err) {
    alert(`Locate failed: ${err.message || err}`);
    return;
  }
  if (!newPath) return;
  if (newPath === oldPath) {
    alert("That's the same path. The file is still missing at that location.");
    return;
  }
  let oldAnnot = null;
  try { oldAnnot = await getStore().readAnnot(oldPath); } catch {}
  let newAnnot = null;
  try { newAnnot = await getStore().readAnnot(newPath); } catch {}

  let migrated = false;
  let hashMatch = null;
  try {
    const newBytes = await getStore().readDocumentBytes(newPath);
    const newHash = await hashBytes(newBytes);
    if (oldAnnot?.source?.contentHash && oldAnnot.source.contentHash === newHash) {
      hashMatch = true;
    } else if (oldAnnot?.source?.contentHash) {
      hashMatch = false;
    }
  } catch {}

  const hasOldAnnotations = !!(oldAnnot && (oldAnnot.snippets?.length || oldAnnot.edges?.length));
  const newSidecarHasContent = !!(newAnnot && (newAnnot.snippets?.length || newAnnot.edges?.length));

  if (hasOldAnnotations && !newSidecarHasContent) {
    let proceed = true;
    if (hashMatch === false) {
      proceed = confirm(
        "The picked file's content hash doesn't match the original. Copy the old annotations to the new file anyway?",
      );
    }
    if (proceed) {
      const merged = {
        ...oldAnnot,
        source: {
          ...(oldAnnot.source || {}),
          path: newPath,
          filename: newPath.split("/").pop() || newPath,
        },
      };
      try {
        await getStore().writeAnnot(newPath, merged);
        migrated = true;
      } catch (err) {
        console.warn("annotation migration failed", err);
      }
    }
  }

  if (mode === "folder" && folder) {
    folder.pdfs = (folder.pdfs || []).map((p) => (p === oldPath ? newPath : p));
  } else if (mode === "loose") {
    state.workspace.files = state.workspace.files.map((p) => (p === oldPath ? newPath : p));
  }
  if (state.workspace.currentPdfPath === oldPath) state.workspace.currentPdfPath = newPath;
  saveWorkspace();
  removeRecent(oldPath);
  await renderWorkspace();
  await loadPdf(newPath);
  if (migrated) flashButton(null, ""); // no-op; alert below instead
  if (hasOldAnnotations && migrated) {
    console.log(`Annotations migrated from ${oldPath} → ${newPath}`);
  }
}

function fileKindBadge(path) {
  const ext = (path || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  const kind = ext ? ext[1] : "";
  const span = document.createElement("span");
  span.className = "file-kind";
  if (kind === "pdf") {
    span.textContent = "PDF";
    span.dataset.kind = "pdf";
  } else if (kind === "md" || kind === "markdown") {
    span.textContent = "MD";
    span.dataset.kind = "md";
  } else if (kind === "docx") {
    span.textContent = "DOC";
    span.dataset.kind = "docx";
  } else if (kind === "txt" || kind === "text") {
    span.textContent = "TXT";
    span.dataset.kind = "txt";
  } else {
    span.textContent = (kind || "·").toUpperCase().slice(0, 4);
    span.dataset.kind = "other";
  }
  return span;
}

async function hashBytes(bytes) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  );
  const arr = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, "0");
  return hex;
}

async function pickBrowserFile(types) {
  if ("showOpenFilePicker" in window) {
    try {
      const [handle] = await window.showOpenFilePicker({ types, multiple: false });
      return await handle.getFile();
    } catch (err) {
      if (err && err.name === "AbortError") return null;
      throw err;
    }
  }
  return await new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    const accept = types?.[0]?.accept;
    if (accept) {
      const exts = Object.values(accept).flat();
      input.accept = exts.join(",");
    }
    input.onchange = () => resolve(input.files?.[0] || null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

const FLOW_EXTS = ["md", "markdown", "txt", "text"];
function detectKindFromPath(path) {
  const m = (path || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return "pdf";
  const ext = m[1];
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "docx") return "docx";
  if (ext === "txt" || ext === "text") return "text";
  return "pdf";
}

const fileListEl = document.getElementById("file-list");
const snippetsListEl = document.getElementById("snippets-list");
const viewerEmpty = document.getElementById("viewer-empty");
const viewerContainer = document.getElementById("viewer-container");
const viewerScroll = document.getElementById("viewer-scroll");
const zoomLevelEl = document.getElementById("zoom-level");

const SCALE_STEP = 1.2;
const MIN_SCALE = 0.4;
const MAX_SCALE = 5;
const FIT_PADDING = 96;

const state = {
  currentPdfPath: null,
  pdfDoc: null,
  flowDoc: null,
  scale: 1.5,
  snippets: [],
  edges: [],
  // Mtime of the active doc's sidecar at last read. Drives optimistic
  // concurrent-write protection in persistImmediate. 0 = no prior file
  // (first write); -1 = skip check (explicit overwrite consent).
  sidecarMtimeMs: 0,
  // Per-document group metadata. Hydrated from the active sidecar's
  // `groups` array on every loadAnyDocument; cleared synchronously on
  // doc switch. Was previously a workspace-level accumulator (proxied
  // to state.workspace.groupsMeta) which caused cross-doc and cross-
  // window leakage. The data model (SPEC §3.1, §3.5) keeps groups in
  // each sidecar — this matches it. Workspace-scope reads recompute
  // the union by walking sidecars on demand (loadWorkspaceMapData).
  groupsMeta: [],
  source: { path: "", filename: "", title: "", author: "", kind: "pdf" },
  view: "list",
  layout: "group",
  mapScope: "doc",
  summaryScope: "doc",
  summaryFormat: "rich",
  summaryImageSize: (() => {
    try { return localStorage.getItem("marklee-summary-img-size") || "compact"; }
    catch { return "compact"; }
  })(),
  // Sort mode is hard-pinned to "order" while the order/rank toggle
  // is hidden. Ignoring any stale "rank" value persisted from before.
  snippetSort: "order",
};
let selectedEdge = null;
let mapInitialized = false;
let lineageInitialized = false;
let rectDraw = null;
let docLoadToken = 0;
const GROUP_PALETTE_SLOTS = 12;
const clipUrlCache = new Map();
state.tool = "select";

const docTitleEl = document.getElementById("doc-title");

// Render the document path as a clickable breadcrumb. Each parent
// segment reveals that directory in Finder; the filename is the bold
// last segment (and also reveals the file itself). Home dir collapses
// to "~" so the trail stays readable.
function renderDocTitle(path, title, author) {
  if (!path) { docTitleEl.replaceChildren(); docTitleEl.title = ""; return; }
  const home = path.match(/^(\/Users\/[^\/]+)\//);
  const display = home ? "~" + path.slice(home[1].length) : path;
  const parts = display.split("/").filter(Boolean);
  const frag = document.createDocumentFragment();
  let accum = home ? home[1] : "";
  parts.forEach((seg, i) => {
    if (seg === "~") {
      const span = document.createElement("span");
      span.className = "path-seg path-seg-home";
      span.textContent = "~";
      span.title = home[1];
      span.addEventListener("click", () => revealInFinder(home[1]));
      frag.appendChild(span);
    } else {
      accum += "/" + seg;
      const sep = document.createElement("span");
      sep.className = "path-sep";
      sep.textContent = "/";
      frag.appendChild(sep);
      const span = document.createElement("span");
      span.className = "path-seg";
      if (i === parts.length - 1) span.classList.add("path-seg-leaf");
      span.textContent = seg;
      span.title = accum;
      const revealPath = accum;
      span.addEventListener("click", () => revealInFinder(revealPath));
      frag.appendChild(span);
    }
  });
  docTitleEl.replaceChildren(frag);
  docTitleEl.title = `${title || ""}${author ? " — " + author : ""}\n${path}`;
}

const undoStack = [];
const expandedIds = new Set();

const WORKSPACE_KEY = "pdf-annotator-workspace";
const WORKSPACES_KEY = "pdf-annotator-workspaces";
state.workspaces = loadAllWorkspaces();
state.workspace = activeWorkspaceData();
if (!IS_TAURI) {
  state.workspace.folders = [];
  state.workspace.files = [];
  state.workspace.currentPdfPath = null;
}
document.body.dataset.theme = state.workspace.theme || "cream";
const collapsedFolders = new Set();

function makeWorkspaceId() {
  return "ws_" + Math.random().toString(36).slice(2, 10);
}

function loadAllWorkspaces() {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.byId && parsed.order && parsed.active) {
        return parsed;
      }
    }
  } catch {}
  let seed = { folders: [], files: [] };
  try {
    const legacy = localStorage.getItem(WORKSPACE_KEY);
    if (legacy) {
      const p = JSON.parse(legacy);
      seed = { folders: p.folders || [], files: p.files || [] };
    }
  } catch {}
  const id = makeWorkspaceId();
  return {
    byId: {
      [id]: {
        id,
        name: "Workspace 1",
        files: seed.files,
        folders: seed.folders,
        groupsMeta: [],
        theme: "cream",
        currentPdfPath: null,
      },
    },
    order: [id],
    active: id,
  };
}

function activeWorkspaceData() {
  const ws = state.workspaces.byId[state.workspaces.active];
  if (!ws) return { folders: [], files: [], theme: "cream", pastedSnippets: [] };
  if (!Array.isArray(ws.pastedSnippets)) ws.pastedSnippets = [];
  if (!ws.theme) ws.theme = "cream";
  // Legacy `groupsMeta` field on the workspace is silently ignored —
  // groups are reconstituted per-document from sidecars on each load.
  return {
    folders: ws.folders || [],
    files: ws.files || [],
    pastedSnippets: ws.pastedSnippets,
    theme: ws.theme,
  };
}

function saveAllWorkspaces() {
  // Snapshot current active workspace before serializing
  const cur = state.workspaces.byId[state.workspaces.active];
  if (cur) {
    cur.files = state.workspace.files;
    cur.folders = state.workspace.folders;
    cur.pastedSnippets = state.workspace.pastedSnippets || [];
    cur.theme = state.workspace.theme || cur.theme || "cream";
    cur.currentPdfPath = state.currentPdfPath;
    // Legacy `cur.groupsMeta` is no longer touched here. Existing
    // entries in localStorage are read-tolerated and ignored.
  }
  let ok = true;
  try { localStorage.setItem(WORKSPACES_KEY, JSON.stringify(state.workspaces)); }
  catch { ok = false; }
  flashSaveIndicator(ok ? "saved" : "error");
}

let _saveIndicatorTimer = null;
let _saveIndicatorSeq = 0;
function flashSaveIndicator(state) {
  const el = document.getElementById("save-indicator");
  if (!el) return;
  const seq = ++_saveIndicatorSeq;
  if (_saveIndicatorTimer) clearTimeout(_saveIndicatorTimer);
  el.dataset.state = state;
  if (state === "saved" || state === "error") {
    _saveIndicatorTimer = setTimeout(() => {
      if (seq !== _saveIndicatorSeq) return;
      el.dataset.state = "idle";
    }, state === "error" ? 4000 : 1400);
  }
}

// Wire the extracted modules now that their deps (state object, store
// accessor, the workspace + save indicator helpers) are all defined.
// Function decls below this point are hoisted, so refreshActiveView and
// loadAnyDocument are already valid references here. Setup runs once
// per session.
setupClipboard({
  state,
  getStore,
  saveAllWorkspaces,
  refreshActiveView,
  flashSaveIndicator,
  IS_TAURI,
});
setupPersistence({
  state,
  getStore,
  mapView: MapView,
  saveAllWorkspaces,
  flashSaveIndicator,
  reloadDocument: (path) => loadAnyDocument(path),
});
setupAiPanel({
  hasConsented,
  getIncludeFigures,
  isOnnxLayoutEnabled,
});

const VALID_THEMES = ["cream", "slate", "sepia", "paper", "forest", "ocean", "bubblegum", "dark", "midnight", "terminal", "steampunk", "popshow", "vapor"];
const THEME_CATEGORIES = [
  { label: "Light",   themes: ["cream", "slate", "sepia", "paper", "forest", "ocean", "bubblegum"] },
  { label: "Dark",    themes: ["dark", "midnight", "terminal", "steampunk"] },
  { label: "Playful", themes: ["popshow", "vapor"] },
];
function applyTheme(name) {
  const theme = VALID_THEMES.includes(name) ? name : "cream";
  document.body.dataset.theme = theme;
  const family = THEME_CATEGORIES.find((c) => c.themes.includes(theme))?.label.toLowerCase() || "light";
  document.body.dataset.themeFamily = family;
}
function setWorkspaceTheme(name) {
  if (!VALID_THEMES.includes(name)) return;
  state.workspace.theme = name;
  applyTheme(name);
  saveAllWorkspaces();
  renderWorkspaceTabs();
  try { LineageView.applyTheme(); } catch {}
}

function saveWorkspace() {
  saveAllWorkspaces();
}

function renderWorkspaceTabs() {
  const list = document.getElementById("ws-tabs-list");
  list.innerHTML = "";
  for (const id of state.workspaces.order) {
    const ws = state.workspaces.byId[id];
    if (!ws) continue;
    const tab = document.createElement("div");
    tab.className = "ws-tab";
    if (id === state.workspaces.active) tab.classList.add("active");
    tab.dataset.wsId = id;
    tab.dataset.theme = (ws.theme && VALID_THEMES.includes(ws.theme)) ? ws.theme : "cream";

    const name = document.createElement("input");
    name.className = "ws-tab-name";
    name.value = ws.name;
    name.readOnly = true;
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      name.readOnly = false;
      name.focus();
      name.select();
    });
    name.addEventListener("blur", () => {
      name.readOnly = true;
      const v = name.value.trim() || ws.name;
      ws.name = v;
      name.value = v;
      saveAllWorkspaces();
    });
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
      if (e.key === "Escape") { name.value = ws.name; name.blur(); }
    });

    const close = document.createElement("button");
    close.className = "ws-tab-close";
    close.textContent = "×";
    close.title = "Close workspace";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeWorkspace(id);
    });

    tab.append(name, close);
    tab.addEventListener("click", () => switchWorkspace(id));
    list.appendChild(tab);
  }
}

function switchWorkspace(id) {
  if (id === state.workspaces.active) return;
  saveAllWorkspaces();
  state.workspaces.active = id;
  closeCurrentPdf();
  state.workspace = activeWorkspaceData();
  applyTheme(state.workspace.theme);
  saveAllWorkspaces();
  renderWorkspaceTabs();
  renderWorkspace();
  renderGroups();
  refreshActiveView();
  const next = state.workspaces.byId[id];
  if (next.currentPdfPath) {
    const exists = next.files.includes(next.currentPdfPath) ||
      next.folders.some((f) => (f.pdfs || []).includes(next.currentPdfPath));
    if (exists) loadPdf(next.currentPdfPath);
  }
}

function newWorkspace() {
  const id = makeWorkspaceId();
  const n = state.workspaces.order.length + 1;
  state.workspaces.byId[id] = {
    id,
    name: `Workspace ${n}`,
    files: [],
    folders: [],
    pastedSnippets: [],
    theme: "cream",
    currentPdfPath: null,
  };
  state.workspaces.order.push(id);
  saveAllWorkspaces();
  switchWorkspace(id);
}

function closeWorkspace(id) {
  if (state.workspaces.order.length === 1) return;
  const idx = state.workspaces.order.indexOf(id);
  state.workspaces.order.splice(idx, 1);
  delete state.workspaces.byId[id];
  if (state.workspaces.active === id) {
    const fallback = state.workspaces.order[Math.max(0, idx - 1)];
    state.workspaces.active = fallback;
    state.workspace = activeWorkspaceData();
    closeCurrentPdf();
  }
  saveAllWorkspaces();
  renderWorkspaceTabs();
  renderWorkspace();
  const next = state.workspaces.byId[state.workspaces.active];
  if (next?.currentPdfPath) {
    const exists = next.files.includes(next.currentPdfPath) ||
      next.folders.some((f) => (f.pdfs || []).includes(next.currentPdfPath));
    if (exists) loadPdf(next.currentPdfPath);
  }
}

document.getElementById("ws-tab-add").addEventListener("click", newWorkspace);

document.getElementById("open-file").addEventListener("click", async () => {
  if (!IS_TAURI) {
    alert("In the browser build, click “+ folder” to pick a directory — individual file picking is not yet supported.");
    return;
  }
  const path = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "Documents", extensions: ["pdf", "md", "markdown", "docx", "txt", "text"] }],
  });
  if (!path) return;
  const paths = Array.isArray(path) ? path : [path];
  for (const p of paths) {
    if (!state.workspace.files.includes(p)) state.workspace.files.push(p);
  }
  saveWorkspace();
  await renderWorkspace();
  if (paths[0]) await loadPdf(paths[0]);
});

document.getElementById("open-folder").addEventListener("click", async () => {
  let dir;
  if (IS_TAURI) {
    dir = await open({ multiple: false, directory: true });
    if (!dir) return;
  } else {
    try {
      const picked = await fsaStore.pickRoot();
      dir = picked.name;
    } catch (err) {
      if (err && err.name !== "AbortError") alert(`Folder access failed: ${err.message || err}`);
      return;
    }
    state.workspace.folders = [];
  }
  let folder = state.workspace.folders.find((f) => f.path === dir);
  const docs = await getStore().listDocuments(dir);
  const pdfs = docs.map((d) => d.path);
  if (!folder) {
    folder = { path: dir, pdfs };
    state.workspace.folders.push(folder);
  } else {
    folder.pdfs = pdfs;
  }
  saveWorkspace();
  await renderWorkspace();
  if (folder.pdfs.length > 0) await loadPdf(folder.pdfs[0]);
});

document.getElementById("clear-workspace").addEventListener("click", () => {
  if (!confirm("Clear all files and folders from the workspace?")) return;
  state.workspace = { folders: [], files: [] };
  saveWorkspace();
  closeCurrentPdf();
  renderWorkspace();
});

function closeCurrentPdf() {
  state.currentPdfPath = null;
  state.pdfDoc = null;
  state.snippets = [];
  state.edges = [];
  state.source = { path: "", filename: "", title: "", author: "" };
  undoStack.length = 0;
  expandedIds.clear();
  viewerContainer.innerHTML = "";
  viewerEmpty.style.display = "";
  docTitleEl.textContent = "";
  docTitleEl.title = "";
  refreshActiveView();
  applyAllHighlights();
}

async function renderWorkspace() {
  fileListEl.innerHTML = "";
  for (const folder of state.workspace.folders) {
    const section = document.createElement("li");
    section.className = "ws-folder";
    const collapsed = collapsedFolders.has(folder.path);
    if (collapsed) section.classList.add("collapsed");

    const header = document.createElement("div");
    header.className = "ws-folder-header";

    const caret = document.createElement("span");
    caret.className = "ws-caret";
    caret.textContent = collapsed ? "▸" : "▾";

    const name = document.createElement("span");
    name.className = "ws-folder-name";
    name.textContent = folder.path.split("/").pop() || folder.path;
    name.title = folder.path;

    const count = document.createElement("span");
    count.className = "ws-folder-count";
    count.textContent = String((folder.pdfs || []).length);

    const remove = document.createElement("button");
    remove.className = "ws-folder-remove";
    remove.textContent = "×";
    remove.title = "Remove from workspace";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      const removedPaths = folder.pdfs || [];
      state.workspace.folders = state.workspace.folders.filter((f) => f.path !== folder.path);
      if (removedPaths.includes(state.currentPdfPath)) {
        state.currentPdfPath = null;
        state.workspace.currentPdfPath = null;
      }
      saveWorkspace();
      // Workspace removal != recents removal. The user explicitly removed
      // from workspace, but the doc itself still exists on disk and we
      // want it findable under "Recent" for re-opening.
      renderWorkspace();
    });

    header.append(caret, name, count, remove);
    header.addEventListener("click", () => {
      if (collapsedFolders.has(folder.path)) collapsedFolders.delete(folder.path);
      else collapsedFolders.add(folder.path);
      renderWorkspace();
    });

    const ul = document.createElement("ul");
    ul.className = "ws-folder-pdfs";
    for (const p of folder.pdfs || []) {
      const li = document.createElement("li");
      li.dataset.path = p;
      const nameSpan = document.createElement("span");
      nameSpan.className = "ws-file-name";
      nameSpan.textContent = p.split("/").pop();
      li.append(fileKindBadge(p), nameSpan);
      li.appendChild(makeLocateButton(p, "folder", folder));
      li.title = p;
      li.addEventListener("click", () => {
        if (li.classList.contains("missing")) return;
        loadPdf(p);
      });
      ul.appendChild(li);
    }

    section.append(header, ul);
    fileListEl.appendChild(section);
  }
  if (state.workspace.files.length > 0) {
    const section = document.createElement("li");
    section.className = "ws-loose";
    const header = document.createElement("div");
    header.className = "ws-folder-header";
    const name = document.createElement("span");
    name.className = "ws-folder-name";
    name.textContent = "Files";
    const count = document.createElement("span");
    count.className = "ws-folder-count";
    count.textContent = String(state.workspace.files.length);
    header.append(name, count);
    const ul = document.createElement("ul");
    ul.className = "ws-folder-pdfs";
    for (const p of state.workspace.files) {
      const li = document.createElement("li");
      li.dataset.path = p;
      const nameSpan = document.createElement("span");
      nameSpan.className = "ws-file-name";
      nameSpan.textContent = p.split("/").pop();
      li.append(fileKindBadge(p), nameSpan);
      li.appendChild(makeLocateButton(p, "loose"));
      li.title = p;
      li.addEventListener("click", () => {
        if (li.classList.contains("missing")) return;
        loadPdf(p);
      });
      const x = document.createElement("button");
      x.className = "ws-file-remove";
      x.textContent = "×";
      x.title = "Remove from workspace";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        state.workspace.files = state.workspace.files.filter((f) => f !== p);
        if (state.currentPdfPath === p) {
          state.currentPdfPath = null;
          state.workspace.currentPdfPath = null;
        }
        saveWorkspace();
        // Don't drop from recents — see folder-remove handler above.
        renderWorkspace();
      });
      li.appendChild(x);
      ul.appendChild(li);
    }
    section.append(header, ul);
    fileListEl.appendChild(section);
  }
  if (state.currentPdfPath) setActiveFile(state.currentPdfPath);
  await refreshFileExistence();
}

function zoomIn() {
  if (state.source.kind === "pdf" && state.pdfDoc) {
    setScale(state.scale * SCALE_STEP);
  } else if (state.flowDoc) {
    state.flowZoom = Math.min(FLOW_MAX_ZOOM, state.flowZoom * SCALE_STEP);
    applyFlowZoom();
  }
}
function zoomOut() {
  if (state.source.kind === "pdf" && state.pdfDoc) {
    setScale(state.scale / SCALE_STEP);
  } else if (state.flowDoc) {
    state.flowZoom = Math.max(FLOW_MIN_ZOOM, state.flowZoom / SCALE_STEP);
    applyFlowZoom();
  }
}
function zoomFit() {
  if (state.source.kind === "pdf" && state.pdfDoc) {
    fitWidth();
  } else if (state.flowDoc) {
    state.flowZoom = 1;
    applyFlowZoom();
  }
}
document.getElementById("zoom-in").addEventListener("click", zoomIn);
document.getElementById("zoom-out").addEventListener("click", zoomOut);
document.getElementById("zoom-fit").addEventListener("click", zoomFit);
document.getElementById("summary-btn").addEventListener("click", openSummary);

document.getElementById("delete-all-btn").addEventListener("click", async () => {
  if (!state.currentPdfPath) return;
  const n = state.snippets.length;
  if (n === 0) {
    flashButton("delete-all-btn", "nothing to delete");
    return;
  }
  const ok = window.confirm(
    `Delete all ${n} annotation${n === 1 ? "" : "s"} in this document?\n\n` +
    `This is undoable with ⌘Z.`
  );
  if (!ok) return;
  // Capture snapshot for undo (single bulk entry — one ⌘Z restores all).
  const removed = state.snippets.slice();
  // Clean up image clip files for any rect snippets.
  for (const s of removed) {
    if (s.kind === "image" && s.imagePath) {
      try { await getStore().deleteClip(state.currentPdfPath, s.imagePath); } catch {}
      const cacheKey = `${state.currentPdfPath}::${s.imagePath}`;
      const cached = clipUrlCache.get(cacheKey);
      if (cached) { URL.revokeObjectURL(cached); clipUrlCache.delete(cacheKey); }
    }
  }
  state.snippets = [];
  // Edges that referenced any of these snippets are now dangling — drop them.
  const removedIds = new Set(removed.map((s) => s.id));
  const removedEdges = (state.edges || []).filter((e) => removedIds.has(e.from) || removedIds.has(e.to));
  state.edges = (state.edges || []).filter((e) => !removedIds.has(e.from) && !removedIds.has(e.to));
  undoStack.push({ type: "delete-all", snippets: removed, edges: removedEdges });
  await persist();
  refreshActiveView();
  applyAllHighlights();
  flashButton("delete-all-btn", `${n} deleted`);
});

// ── AI: semantic-highlight Reader ────────────────────────────────
// Single-doc query → LLM returns verbatim quotes → suggestion drawer →
// user accepts to materialize as snippets. Phase 0+1 of the AI plan.

let aiSuggestions = [];        // current run's suggestions (orphan flag set after locate)
let aiInFlight = false;

// Visual-content keywords. When a query mentions any of these (or a
// near-typo of any), we run the (slow) figure-detection pipeline.
// Otherwise text-only — much faster, no GPU load.
const FIGURE_KEYWORDS = /\b(figure|figures|fig\.?|sub-?figure|panel|panels|chart|charts|graph|graphs|plot|plots|diagram|diagrams|schematic|table|tables|image|images|screenshot|screenshots|illustration|illustrations|infographic|map|maps|drawing|drawings|photo|photos|photograph|picture|pictures|visual|visualization|visualisation|graphic|graphics|snippet|snippets)\b/i;

// Canonical lexicon for fuzzy fallback (typo tolerance). Plural forms
// are derived automatically; short variants (e.g. "fig") are listed
// explicitly so the edit-distance threshold doesn't false-positive.
const FIGURE_LEXICON = [
  "figure", "subfigure", "panel", "chart", "graph", "plot",
  "diagram", "schematic", "table", "image", "screenshot",
  "illustration", "infographic", "drawing", "photo", "photograph",
  "picture", "visual", "visualization", "graphic", "snippet",
];

// Damerau-Levenshtein distance — counts insertions, deletions,
// substitutions, AND adjacent transpositions (so "tabel" ↔ "table"
// counts as 1 edit, not 2). Word lengths are short enough that the
// O(n×m) DP cost is negligible.
function damerauLevenshtein(a, b) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  const dp = Array.from({ length: la + 1 }, () => new Array(lb + 1));
  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 &&
          a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[la][lb];
}

function queryNeedsFigures(query) {
  if (!query) return false;
  // Fast path — exact word match.
  if (FIGURE_KEYWORDS.test(query)) return true;
  // Fuzzy fallback — Damerau-Levenshtein against the lexicon, with
  // a length-scaled tolerance so 4-letter words allow 1 edit and
  // longer words allow 2.
  const words = query.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
  for (const w of words) {
    for (const term of FIGURE_LEXICON) {
      const tolerance = Math.min(2, Math.max(1, Math.floor(term.length / 5)));
      // Tolerance gating: also require the word's length to be within
      // ±2 of the lexicon term to avoid wildly different words matching
      // (e.g., "snippet" vs "snip" with distance 3 shouldn't match).
      if (Math.abs(w.length - term.length) > tolerance + 1) continue;
      if (damerauLevenshtein(w, term) <= tolerance) return true;
    }
  }
  return false;
}

// Column-aware bbox clipping. RT-DETR sometimes detects figures wider
// than the actual figure column (it includes surrounding whitespace
// from training). Clip each detection's horizontal extent to the
// dominant text column its caption sits in — captions are always
// aligned with their figures horizontally, so the caption line's
// x-range is a reliable bound on the figure's column width.
//
// Conservative: only narrows boxes, never widens. Skips detections
// that don't have enough text near them to compute a column reliably.
function clipDetectionsToTextColumns(figureDetections, pageTextContent) {
  if (!Array.isArray(figureDetections) || !pageTextContent) return figureDetections;
  return figureDetections.map((d) => {
    const pageContent = pageTextContent.get(d.page);
    if (!pageContent || !pageContent.ranges) return d;
    const candidates = (d.candidates || []).map((c) =>
      clipRectToTextColumn(c, pageContent),
    );
    return { ...d, candidates };
  });
}

function clipRectToTextColumn(rect, pageContent) {
  const W = pageContent.width;
  const H = pageContent.height;
  if (!W || !H) return rect;
  const detBottom = rect.top + rect.height;
  const detLeft = rect.left;

  // Caption text typically lives just BELOW the figure body and starts
  // at (or very near) the figure's left edge. Find items that match
  // both: below the detection AND left-aligned with the detection.
  // This excludes text in adjacent columns that happens to overlap the
  // detection's x-range.
  const LEFT_TOLERANCE = 0.05; // 5% of page width
  const BELOW_MAX = 0.15;      // up to 15% below detection's bottom
  const items = [];
  for (const r of pageContent.ranges) {
    const tx = r.item.transform;
    const itemH = (r.item.height || Math.abs(tx[3]) || 12) / H;
    const yTop = 1 - tx[5] / H;
    if (yTop < detBottom - 0.01) continue;
    if (yTop > detBottom + BELOW_MAX) continue;
    const left = tx[4] / W;
    const right = left + (r.item.width || 0) / W;
    if (right - left < 0.005) continue;
    if (Math.abs(left - detLeft) > LEFT_TOLERANCE) continue;
    items.push({ left, right, yTop, h: itemH });
  }
  if (items.length < 2) return rect; // no caption-like text found

  // Caption "Fig. N." line + a few wrapped lines below it. Use the
  // smallest yTop (closest line below the detection) and walk down,
  // collecting all items within the same caption block (consecutive
  // line spacings ~= item height).
  items.sort((a, b) => a.yTop - b.yTop);
  const firstLine = items[0];
  const blockItems = [firstLine];
  for (let i = 1; i < items.length; i++) {
    const gap = items[i].yTop - items[i - 1].yTop;
    // Cap caption block to a few lines: if we hit a line-gap > 3x the
    // average item height, we've left the caption.
    if (gap > Math.max(0.03, firstLine.h * 3)) break;
    blockItems.push(items[i]);
  }

  // Block's x extent → the figure's column.
  let colLeft = Infinity, colRight = -Infinity;
  for (const it of blockItems) {
    if (it.left < colLeft) colLeft = it.left;
    if (it.right > colRight) colRight = it.right;
  }
  if (!Number.isFinite(colLeft) || !Number.isFinite(colRight)) return rect;

  // Only narrow, never widen. Small padding so we don't clip the
  // figure body's own extent.
  const PAD = 0.01;
  const newLeft = Math.max(rect.left, colLeft - PAD);
  const newRight = Math.min(rect.left + rect.width, colRight + PAD);
  if (newRight - newLeft < rect.width * 0.4) return rect; // sanity guard
  return {
    ...rect,
    left: newLeft,
    width: newRight - newLeft,
  };
}

// Geometry helpers used by the image-suggestion resolution step.
function clampRect(r) {
  const left   = Math.max(0, Math.min(1, r.left   ?? 0));
  const top    = Math.max(0, Math.min(1, r.top    ?? 0));
  const width  = Math.max(0, Math.min(1 - left, r.width  ?? 0));
  const height = Math.max(0, Math.min(1 - top,  r.height ?? 0));
  return { left, top, width, height };
}
function ensureMinSize(r, min = 0.04) {
  let { left, top, width, height } = r;
  if (width < min) {
    const center = left + width / 2;
    width = min;
    left = Math.max(0, Math.min(1 - width, center - width / 2));
  }
  if (height < min) {
    const center = top + height / 2;
    height = min;
    top = Math.max(0, Math.min(1 - height, center - height / 2));
  }
  return { left, top, width, height };
}
function iou(a, b) {
  const ax2 = a.left + a.width, ay2 = a.top + a.height;
  const bx2 = b.left + b.width, by2 = b.top + b.height;
  const ix1 = Math.max(a.left, b.left), iy1 = Math.max(a.top, b.top);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const uni = (a.width * a.height) + (b.width * b.height) - inter;
  return uni > 0 ? inter / uni : 0;
}
function bestOverlap(rect, candidates, minIoU = 0.2) {
  let best = null, bestScore = 0;
  for (const c of candidates) {
    const s = iou(rect, c);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return bestScore >= minIoU ? best : null;
}

// Caption-anchor fallback: when the model says "Figure N: …" but no
// candidate region matches, search the page's rendered textLayer for
// the caption text and use its bounding rect. Last-resort highlight
// that at least lands SOMEWHERE relevant on the page.
function captionAnchorRect(viewerContainer, page, label) {
  if (!page || !label) return null;
  const wrap = viewerContainer.querySelector(`.page-wrap[data-page="${page}"]`);
  if (!wrap) return null;
  const textLayer = wrap.querySelector(".textLayer");
  if (!textLayer) return null;
  // The model's label often starts with "Figure N", "Fig. N", "Table N",
  // possibly with a colon. Extract a distinctive search head: the
  // leading capitalized words up to the first 60 characters.
  const head = label.split(/[.:]/)[0].trim().slice(0, 60);
  if (head.length < 5) return null;
  const candidates = [
    head,
    head.replace(/^Figure\s+/i, "Fig. "),
    head.replace(/^Fig\.?\s+/i, "Figure "),
  ];
  const flat = textLayer.textContent || "";
  for (const probe of candidates) {
    let i = flat.indexOf(probe);
    if (i === -1) i = flat.toLowerCase().indexOf(probe.toLowerCase());
    if (i === -1) continue;
    // Walk text nodes to find the range matching that flat offset.
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
    let acc = 0, startNode = null, startOff = 0, endNode = null, endOff = 0;
    const targetStart = i, targetEnd = i + probe.length;
    let n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      if (!startNode && acc + len > targetStart) {
        startNode = n; startOff = targetStart - acc;
      }
      if (startNode && acc + len >= targetEnd) {
        endNode = n; endOff = targetEnd - acc;
        break;
      }
      acc += len;
    }
    if (!startNode || !endNode) continue;
    try {
      const range = document.createRange();
      range.setStart(startNode, startOff);
      range.setEnd(endNode, endOff);
      const wrapRect = wrap.getBoundingClientRect();
      const r = range.getBoundingClientRect();
      return {
        left:   (r.left - wrapRect.left) / wrapRect.width,
        top:    (r.top  - wrapRect.top)  / wrapRect.height,
        width:  r.width / wrapRect.width,
        height: r.height / wrapRect.height,
      };
    } catch {}
  }
  return null;
}

// aiSetStatus, aiSetBusy moved to src/ai-panel.js in Wave 3.

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
  if (!hasConsented()) {
    const ok = window.confirm(
      "This query will send the full text of the open document to Anthropic.\n\n" +
      "Tick the consent box in AI settings (or just continue here) to skip this prompt next time."
    );
    if (!ok) return;
    setConsented(true);
  }
  if (!state.currentPdfPath) {
    aiSetStatus("Open a document first.", "error");
    return;
  }

  aiInFlight = true;
  aiSetBusy(true);
  aiSetStatus("Reading document…");
  document.getElementById("ai-ask-submit").disabled = true;

  try {
    const kind = state.source.kind || "pdf";
    let docText;
    let pageImages = null;
    let figureDetections = null;
    let pageTextContent = null;
    // Two-stage dispatch: a tiny "planner" call classifies the query
    // into { needsText, needsFigures, figurePages } before any heavy
    // work runs. The figure detector (ONNX or built-in hybrid) only
    // fires when the planner says figures are wanted. Provider-agnostic
    // — same call works regardless of which Claude/OpenAI model the
    // user picked.
    //
    // The user can force-on figures via the global toggle even when the
    // planner thinks they aren't needed (gives a manual override).
    aiSetStatus("Planning…");
    const plan = await planQuery({
      query,
      docTitle: state.source?.title || state.source?.filename || "",
    });
    const wantsFigures = plan.needsFigures || getIncludeFigures();
    const wantsText = plan.needsText;
    console.log("[ai] plan:", plan, "→ runFigures:", wantsFigures, "runText:", wantsText);
    if (kind === "pdf") {
      docText = await extractPdfText(state.pdfDoc);
      // Always pull per-page positioned text content. Used to resolve
      // text quotes against pages that haven't been rendered in the
      // viewer yet (DOM textLayer absent on lazy-load pages), and as
      // the caption-anchor source for figure suggestions.
      aiSetStatus("Indexing page text positions…");
      pageTextContent = await extractPdfPageTextContent(state.pdfDoc);
      if (wantsFigures) {
        // Render page images. Resolution depends on which backend will
        // process them. RT-DETR needs 640 (we render 1024 for resize
        // quality). Claude vision uses 1400.
        const visionRes = isOnnxLayoutEnabled() ? 1024 : 1400;
        aiSetStatus(`Rendering ${state.pdfDoc.numPages} page image(s)…`);
        pageImages = await extractPdfPageImages(state.pdfDoc, { targetWidth: visionRes });

        if (isOnnxLayoutEnabled()) {
          aiSetStatus(`Running RT-DETR v2 layout on ${pageImages.length} page(s) (first run downloads ~171 MB)…`);
          try {
            figureDetections = await runOnnxLayout(
              pageImages,
              state.source?.contentHash,
              (i, total, page) => aiSetStatus(`ONNX layout ${i}/${total} pages…`)
            );
            console.log("[ai] onnx detection:", figureDetections);
          } catch (err) {
            console.warn("[ai] ONNX failed, falling back:", err);
            aiSetStatus(`ONNX failed (${err.message || err}); falling back.`, "error");
            figureDetections = await detectFiguresHybrid(state.pdfDoc, { targetWidth: 800 });
          }
        } else {
          aiSetStatus(`Detecting figures (PDF XObjects + grid) on ${state.pdfDoc.numPages} page(s)…`);
          figureDetections = await detectFiguresHybrid(state.pdfDoc, { targetWidth: 800 });
        }
      }
    } else {
      docText = extractFlowText(state.flowDoc, viewerContainer);
    }
    if (!docText) throw new Error("Could not read the document text.");

    const detectedCount = figureDetections
      ? figureDetections.reduce((n, d) => n + (d.candidates?.length || 0), 0)
      : 0;
    // If layout detection ran but came back empty, that's a signal
    // something went wrong upstream. Log loudly and ALWAYS ensure page
    // images go to Claude so it can detect figures itself from the
    // rendered pages (fallback to vision-only path).
    if (wantsFigures && figureDetections && detectedCount === 0) {
      console.warn(
        "[ai] Layout detector returned 0 candidates across all pages — falling back to Claude vision-only.",
        figureDetections
      );
      // Make sure pageImages is populated for the vision pass.
      if (!pageImages && state.pdfDoc) {
        pageImages = await extractPdfPageImages(state.pdfDoc, { targetWidth: 1400 });
      }
      // Clear empty detections so the prompt doesn't show an empty
      // candidate list (which makes Claude think there are NO figures).
      figureDetections = null;
    }
    const visionTag = pageImages ? ` + ${pageImages.length} page image(s)` : "";
    const detTag = figureDetections ? ` · ${detectedCount} candidate regions` : (wantsFigures ? " · vision-only (no candidates)" : "");
    const skipTag = "";
    aiSetStatus(`Asking Claude… (${(docText.length / 1000).toFixed(0)}k chars${visionTag}${detTag}${skipTag})`);
    const groupNames = (state.groupsMeta || []).map((g) => g.name).filter(Boolean);
    const { highlights, usage, debugText } = await runReader({
      query,
      docText,
      docTitle: state.source.title || state.source.filename || "",
      groupNames,
      pageImages,
      figureDetections,
      plan: { wantsText, wantsFigures },
    });

    // Step 2 — resolve each highlight against the rendered document.
    // Text → DOM lookup. Image → prefer the model's `figure_id` (maps
    // to a pre-detected region with pixel-accurate coords); fall back
    // to the model's free-form rect when figure_id is omitted.
    const detectionByPage = new Map();
    if (figureDetections) {
      for (const d of figureDetections) detectionByPage.set(d.page, d.candidates || []);
    }
    console.log("[ai] raw highlights from model:", highlights);
    console.log("[ai] figure detections by page:", detectionByPage);
    // Candidate-kind whitelist for fallback paths (B-snap and C-largest).
    // Layout detectors classify each region; only figure/table/chart-ish
    // kinds are valid for an image-snippet anchor. Header/title/text
    // regions used to slip through the C-fallback and produce orphan
    // "Research Articles" boxes — drop them here instead. Explicit
    // figure_id requests (path A) still honor whatever the model asked
    // for; the model owns that decision.
    const figureLikeKind = (k) => {
      if (!k) return true; // unlabeled candidate — old detector path; keep
      const s = String(k).toLowerCase();
      return s.includes("figure") || s.includes("picture") || s.includes("image")
          || s.includes("table") || s.includes("chart") || s.includes("plot")
          || s === "diagram";
    };
    aiSuggestions = highlights.map((h) => {
      const isImage = h.kind === "image";
      let resolved = null;
      let found = false;
      if (isImage) {
        const hintPage = h.page;
        let resolvedPage = hintPage;
        let cands = hintPage ? (detectionByPage.get(hintPage) || []) : [];

        // (A) explicit figure_id → look up the candidate on the hinted
        //     page; if not found, search ALL pages for that ID.
        const wantId = (h.figure_id || "").toString().trim().toUpperCase();
        let pick = wantId ? cands.find((c) => c.id === wantId) : null;
        let source = pick ? "detected" : null;
        if (wantId && !pick) {
          for (const [p, list] of detectionByPage) {
            const hit = list.find((c) => c.id === wantId);
            if (hit) { pick = hit; resolvedPage = p; cands = list; source = "detected-other-page"; break; }
          }
        }

        // (B) model gave a free-form rect — try to snap to a candidate
        //     on the hinted page (or fall back to model-bbox). Snapping
        //     is restricted to figure-like candidates so an image
        //     suggestion can't accidentally lock onto a text/header
        //     region just because it geometrically overlaps.
        if (!pick && h.rect && hintPage) {
          const modelRect = clampRect(h.rect);
          const figureCands = cands.filter((c) => figureLikeKind(c.kind));
          const snapped = bestOverlap(modelRect, figureCands, 0.2);
          if (snapped) { pick = snapped; source = "snapped"; }
          else if (modelRect.width > 0 && modelRect.height > 0) {
            pick = { ...ensureMinSize(modelRect) };
            source = "model-bbox";
          }
        }

        // (C) detected-fallback on the hinted page — only over figure-
        //     like candidates. If the page has none, skip the fallback
        //     entirely; the caption-anchor path below or the orphan
        //     drop at the end will handle the suggestion.
        if (!pick && hintPage && cands.length) {
          const figureCands = cands.filter((c) => figureLikeKind(c.kind));
          if (figureCands.length) {
            const largest = figureCands.slice().sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
            pick = largest;
            source = "detected-fallback";
          }
        }

        if (pick && resolvedPage) {
          resolved = {
            kind: "image",
            page: resolvedPage,
            rect: { left: pick.left, top: pick.top, width: pick.width, height: pick.height },
            label: h.label || `Region p.${resolvedPage}`,
            source,
          };
          found = true;
        }

        // (D) Caption-anchor — search hinted page FIRST, then ALL pages.
        //     If the label ("Figure 2A: …") is found on a different
        //     page than the model claimed, use the page where it
        //     actually lives. Catches "wrong page" hallucinations.
        if (!resolved && h.label && pageTextContent) {
          const order = [];
          if (hintPage && pageTextContent.has(hintPage)) order.push(hintPage);
          for (const p of pageTextContent.keys()) if (p !== hintPage) order.push(p);
          for (const p of order) {
            const cap = findCaptionRectInPageContent(pageTextContent.get(p), h.label);
            if (cap) {
              resolved = {
                kind: "image",
                page: p,
                rect: cap,
                label: h.label,
                source: p === hintPage ? "caption-anchor" : "caption-anchor-other-page",
              };
              found = true;
              break;
            }
          }
        }
      } else {
        const r = resolveQuoteToSnippet({
          quote: h.quote,
          kind: state.source.kind || "pdf",
          viewerContainer,
          hintPage: h.page || null,
          pageTextContent,
        });
        if (r) { resolved = r; found = true; }
      }
      return {
        ...h,
        resolved,
        found,
        resolvedPage: resolved?.page ?? h.page ?? null,
        accepted: false,
        rejected: false,
        // Stamp the doc this suggestion was generated for. acceptAiSuggestion
        // checks this before writing — if the user switched docs since the
        // query, applying would silently retarget the new doc (data hazard).
        _sourcePath: state.currentPdfPath,
      };
    });

    // If the model returned 0 highlights but wrote prose, that usually
    // means it refused or declared nothing matched. Surface its text.
    if (highlights.length === 0 && debugText) {
      const snippet = debugText.length > 140 ? debugText.slice(0, 137) + "…" : debugText;
      aiSetStatus(`0 highlights · model said: "${snippet}"`, "error");
    } else {
      aiSetStatus(`${highlights.length} highlights`);
    }
    showAiDrawer(query);
  } catch (err) {
    console.error("AI ask failed", err);
    aiSetStatus(err.message || String(err), "error");
  } finally {
    aiInFlight = false;
    aiSetBusy(false);
    document.getElementById("ai-ask-submit").disabled = false;
  }
}

function showAiDrawer(query) {
  const drawer = document.getElementById("ai-drawer");
  drawer.hidden = false;
  document.getElementById("ai-drawer-query").textContent = query;
  renderAiDrawer();
  paintAiPreviews();
}
function hideAiDrawer() {
  const drawer = document.getElementById("ai-drawer");
  drawer.hidden = true;
  aiSuggestions = [];
  clearAiPreviews();
  aiSetStatus("");
}

// Paint all pending suggestions as dashed overlays on the document so
// the user can SEE where each highlight would land before accepting.
// Cleared when the drawer closes or all suggestions are handled.
// mergeRectsIntoBands moved to src/ai-panel.js in Wave 3.

function paintAiPreviews() {
  clearAiPreviews();
  const pending = aiSuggestions.filter((s) => !s.accepted && !s.rejected && s.resolved);
  if (!pending.length) return;
  if (state.source.kind === "pdf") {
    const byPage = new Map();
    for (const sug of pending) {
      const page = sug.resolved.page;
      if (!page) continue;
      if (!byPage.has(page)) byPage.set(page, []);
      // Image kind has a single rect; text kind has rects[]. For text
      // we merge intra-suggestion rects into per-line bands first so a
      // multi-rect quote renders as one clean strip per line instead
      // of a fence of abutting dashed boxes.
      if (sug.resolved.kind === "image" && sug.resolved.rect) {
        byPage.get(page).push({ rect: sug.resolved.rect, sug, type: "image" });
      } else if (sug.resolved.rects && sug.resolved.rects.length) {
        const merged = mergeRectsIntoBands(sug.resolved.rects);
        for (const r of merged) byPage.get(page).push({ rect: r, sug, type: "text" });
      }
    }
    for (const [page, items] of byPage) {
      const wrap = viewerContainer.querySelector(`.page-wrap[data-page="${page}"]`);
      if (!wrap) continue;
      let layer = wrap.querySelector(".ai-preview-layer");
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "ai-preview-layer";
        wrap.appendChild(layer);
      }
      layer.innerHTML = "";
      for (const it of items) {
        const div = document.createElement("div");
        div.className = `ai-preview-rect ai-preview-${it.type}`;
        div.dataset.sugQuote = (it.sug.quote || it.sug.label || "").slice(0, 60);
        const idAttr = aiSuggestions.indexOf(it.sug);
        div.dataset.sugIdx = String(idAttr);
        div.style.left = (it.rect.left * 100) + "%";
        div.style.top = (it.rect.top * 100) + "%";
        div.style.width = (it.rect.width * 100) + "%";
        div.style.height = (it.rect.height * 100) + "%";
        div.title = it.sug.reason || it.sug.quote || it.sug.label || "";
        // Image rects are editable: drag body to move, drag handles to
        // resize. Text rects stay fixed (they're derived from string
        // match positions; editing wouldn't make sense).
        if (it.type === "image") {
          attachImageRectEditing(div, wrap, it.sug);
        } else {
          div.addEventListener("click", () => focusDrawerCard(idAttr));
        }
        layer.appendChild(div);
      }
    }
  }
  // Flow docs (Markdown / TXT / DOCX): wrap each pending suggestion's
  // resolved text range in <mark class="ai-preview-text"> so the user
  // sees previews directly on the rendered article.
  else {
    paintFlowAiPreviews(pending);
  }
}

function paintFlowAiPreviews(pending) {
  const article = viewerContainer.querySelector(".flow-doc");
  if (!article) return;
  for (const sug of pending) {
    const r = sug.resolved;
    if (!r || typeof r.flowPos !== "number" || !r.text) continue;
    const start = r.flowPos;
    const end = start + r.text.length;
    const range = rangeAtFlatOffsetInArticle(article, start, end);
    if (!range) continue;
    const mark = document.createElement("mark");
    mark.className = "ai-preview-text";
    mark.dataset.sugIdx = String(aiSuggestions.indexOf(sug));
    mark.title = sug.reason || sug.quote || "";
    try {
      range.surroundContents(mark);
    } catch {
      // Range crosses an element boundary — extract & wrap instead.
      try {
        const frag = range.extractContents();
        mark.appendChild(frag);
        range.insertNode(mark);
      } catch (err) {
        console.warn("[ai] flow preview wrap failed", err);
        continue;
      }
    }
    mark.addEventListener("click", () => focusDrawerCard(mark.dataset.sugIdx));
  }
}

function rangeAtFlatOffsetInArticle(article, start, end) {
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
      const tag = n.parentNode?.nodeName;
      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let acc = 0;
  let startNode = null, startOff = 0, endNode = null, endOff = 0;
  let n;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    if (!startNode && acc + len > start) {
      startNode = n;
      startOff = start - acc;
    }
    if (startNode && acc + len >= end) {
      endNode = n;
      endOff = end - acc;
      break;
    }
    acc += len;
  }
  if (!startNode || !endNode) return null;
  try {
    const r = document.createRange();
    r.setStart(startNode, startOff);
    r.setEnd(endNode, endOff);
    return r;
  } catch {
    return null;
  }
}

function clearAiPreviews() {
  for (const layer of viewerContainer.querySelectorAll(".ai-preview-layer")) {
    layer.remove();
  }
  // Unwrap flow-doc preview marks and merge adjacent text nodes.
  const article = viewerContainer.querySelector(".flow-doc");
  if (article) {
    for (const m of article.querySelectorAll("mark.ai-preview-text")) {
      const parent = m.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    }
  }
}

// Fuzzy-match a proposed group name against existing groups; if no
// reasonable match exists, create a new group with the proposed name.
// Returns the group id (existing or newly created).
//
// Matching ladder:
//   1. exact case-insensitive
//   2. simple lemma match (singular/plural, common suffixes)
//   3. substring containment (proposed contains existing, or vice versa)
//   4. otherwise create a new group with a fresh palette slot
function resolveOrCreateGroup(proposed) {
  if (!proposed) return null;
  const name = proposed.trim();
  if (!name) return null;
  const groups = state.groupsMeta || (state.groupsMeta = []);
  const norm = (s) => (s || "").toLowerCase().trim();
  const stem = (s) => norm(s).replace(/(?:ies|es|s|y|ology|ologies)$/, "");
  const target = norm(name);
  const targetStem = stem(name);

  // (1) exact
  let hit = groups.find((g) => norm(g.name) === target);
  if (hit) return hit.id;
  // (2) stem
  hit = groups.find((g) => stem(g.name) === targetStem && targetStem.length >= 4);
  if (hit) return hit.id;
  // (3) substring (short names only — avoid "Cost" matching "Costs and limitations")
  if (target.length >= 4 && target.length <= 18) {
    hit = groups.find((g) => {
      const n = norm(g.name);
      if (!n) return false;
      return n.includes(target) || target.includes(n);
    });
    if (hit) return hit.id;
  }
  // (4) create new
  const id = crypto.randomUUID();
  const slot = nextPaletteIndex();
  groups.push({ id, name, paletteSlot: slot });
  saveAllWorkspaces();
  renderGroups();
  return id;
}

function focusDrawerCard(idx) {
  const card = document.querySelector(`#ai-drawer-list .ai-suggestion[data-sug-idx="${idx}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 700);
}

// Attach drag-to-move and corner-drag-to-resize behavior to an image
// preview rect so the user can adjust the AI's bounding box before
// accepting. Updates sug.resolved.rect on every gesture; the suggestion
// card displays a small "edited" indicator after the first change.
function attachImageRectEditing(rectEl, wrap, sug) {
  const handleDirs = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  for (const dir of handleDirs) {
    const h = document.createElement("div");
    h.className = `ai-preview-handle ai-preview-handle-${dir}`;
    h.dataset.dir = dir;
    h.addEventListener("pointerdown", (e) => startResize(e, rectEl, wrap, sug, dir));
    rectEl.appendChild(h);
  }
  rectEl.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("ai-preview-handle")) return;
    if (e.detail === 2) {
      // Double-click: focus drawer card. Single-click drags.
      focusDrawerCard(rectEl.dataset.sugIdx);
      return;
    }
    startMove(e, rectEl, wrap, sug);
  });
}

function startMove(e, rectEl, wrap, sug) {
  e.preventDefault();
  e.stopPropagation();
  const wrapRect = wrap.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  const orig = { ...sug.resolved.rect };
  rectEl.setPointerCapture?.(e.pointerId);
  const onMove = (ev) => {
    const dx = (ev.clientX - startX) / wrapRect.width;
    const dy = (ev.clientY - startY) / wrapRect.height;
    const nextLeft = Math.max(0, Math.min(1 - orig.width, orig.left + dx));
    const nextTop  = Math.max(0, Math.min(1 - orig.height, orig.top + dy));
    sug.resolved.rect = { ...orig, left: nextLeft, top: nextTop };
    sug.resolved.source = (sug.resolved.source || "") + (sug.resolved.source?.endsWith("-edited") ? "" : "-edited");
    rectEl.style.left = (nextLeft * 100) + "%";
    rectEl.style.top  = (nextTop * 100)  + "%";
  };
  const onUp = (ev) => {
    rectEl.releasePointerCapture?.(ev.pointerId);
    rectEl.removeEventListener("pointermove", onMove);
    rectEl.removeEventListener("pointerup", onUp);
    renderAiDrawer();
  };
  rectEl.addEventListener("pointermove", onMove);
  rectEl.addEventListener("pointerup", onUp);
}

function startResize(e, rectEl, wrap, sug, dir) {
  e.preventDefault();
  e.stopPropagation();
  const wrapRect = wrap.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  const orig = { ...sug.resolved.rect };
  const handle = e.currentTarget;
  handle.setPointerCapture?.(e.pointerId);
  const MIN = 0.02;
  const onMove = (ev) => {
    const dx = (ev.clientX - startX) / wrapRect.width;
    const dy = (ev.clientY - startY) / wrapRect.height;
    let { left, top, width, height } = orig;
    // Each direction adjusts a different combination of edges.
    if (dir.includes("e")) width  = Math.max(MIN, Math.min(1 - left, orig.width + dx));
    if (dir.includes("s")) height = Math.max(MIN, Math.min(1 - top,  orig.height + dy));
    if (dir.includes("w")) {
      const newLeft = Math.max(0, Math.min(orig.left + orig.width - MIN, orig.left + dx));
      width = orig.width + (orig.left - newLeft);
      left = newLeft;
    }
    if (dir.includes("n")) {
      const newTop = Math.max(0, Math.min(orig.top + orig.height - MIN, orig.top + dy));
      height = orig.height + (orig.top - newTop);
      top = newTop;
    }
    sug.resolved.rect = { left, top, width, height };
    sug.resolved.source = (sug.resolved.source || "") + (sug.resolved.source?.endsWith("-edited") ? "" : "-edited");
    rectEl.style.left   = (left * 100) + "%";
    rectEl.style.top    = (top * 100)  + "%";
    rectEl.style.width  = (width * 100)  + "%";
    rectEl.style.height = (height * 100) + "%";
  };
  const onUp = (ev) => {
    handle.releasePointerCapture?.(ev.pointerId);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    renderAiDrawer();
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
}

function renderAiDrawer() {
  const list = document.getElementById("ai-drawer-list");
  list.innerHTML = "";
  const pending = aiSuggestions.filter((s) => !s.accepted && !s.rejected);
  document.getElementById("ai-drawer-count").textContent =
    `${pending.length} pending · ${aiSuggestions.filter((s) => s.accepted).length} accepted`;
  for (const sug of aiSuggestions) {
    if (sug.accepted || sug.rejected) continue;
    const li = document.createElement("li");
    li.className = "ai-suggestion";
    li.dataset.sugIdx = String(aiSuggestions.indexOf(sug));
    if (!sug.found) li.classList.add("orphan");
    // Hovering the card emphasizes the preview rect on the document.
    li.addEventListener("mouseenter", () => {
      viewerContainer.querySelectorAll(`.ai-preview-rect[data-sug-idx="${li.dataset.sugIdx}"]`)
        .forEach((r) => r.classList.add("hot"));
    });
    li.addEventListener("mouseleave", () => {
      viewerContainer.querySelectorAll(`.ai-preview-rect.hot`)
        .forEach((r) => r.classList.remove("hot"));
    });
    // Clicking anywhere on the card (except buttons) scrolls the
    // viewer to the suggestion's preview rect.
    li.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const rect = viewerContainer.querySelector(`.ai-preview-rect[data-sug-idx="${li.dataset.sugIdx}"]`);
      if (rect) {
        rect.scrollIntoView({ behavior: "smooth", block: "center" });
        rect.classList.add("pulse");
        setTimeout(() => rect.classList.remove("pulse"), 800);
      }
    });

    if (sug.kind === "image") {
      const head = document.createElement("div");
      head.className = "ai-suggestion-quote ai-suggestion-figure";
      const src = sug.resolved?.source;
      const tag = src ? ` (${src})` : sug.found ? "" : " ⚠ no rect";
      head.textContent = `🖼 ${sug.label || `Figure on p.${sug.page}`}${tag}`;
      li.appendChild(head);
    } else {
      const quote = document.createElement("div");
      quote.className = "ai-suggestion-quote";
      quote.textContent = `"${sug.quote || ""}"`;
      li.appendChild(quote);
    }

    if (sug.reason) {
      const reason = document.createElement("div");
      reason.className = "ai-suggestion-reason";
      reason.textContent = sug.reason;
      li.appendChild(reason);
    }

    const meta = document.createElement("div");
    meta.className = "ai-suggestion-meta";
    if (sug.confidence) {
      const c = document.createElement("span");
      c.className = "ai-suggestion-conf";
      c.dataset.conf = sug.confidence;
      c.textContent = sug.confidence;
      meta.appendChild(c);
    }
    if (sug.resolvedPage) {
      const p = document.createElement("span");
      p.className = "ai-suggestion-page";
      p.textContent = `p.${sug.resolvedPage}`;
      meta.appendChild(p);
    }
    if (sug.group_hint) {
      const g = document.createElement("span");
      g.className = "ai-suggestion-group";
      g.textContent = sug.group_hint;
      meta.appendChild(g);
    }
    if (!sug.found) {
      const o = document.createElement("span");
      o.className = "ai-suggestion-page";
      o.style.background = "rgba(217,119,87,0.15)";
      o.style.color = "#d97757";
      o.textContent = "no match";
      o.title = "Quote not found verbatim in the document — accepting will still save the snippet but it won't paint on the page.";
      meta.appendChild(o);
    }
    li.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "ai-suggestion-actions";
    const acc = document.createElement("button");
    acc.className = "ai-suggestion-accept";
    acc.textContent = "✓ accept";
    acc.addEventListener("click", () => acceptAiSuggestion(sug));
    const rej = document.createElement("button");
    rej.className = "ai-suggestion-reject";
    rej.textContent = "✕ reject";
    rej.addEventListener("click", () => rejectAiSuggestion(sug));
    actions.append(acc, rej);
    li.appendChild(actions);

    list.appendChild(li);
  }
  if (pending.length === 0) {
    const done = document.createElement("li");
    done.style.padding = "12px";
    done.style.color = "var(--pane-fg-dim)";
    done.style.fontSize = "11.5px";
    done.style.textAlign = "center";
    done.textContent = aiSuggestions.length
      ? `All ${aiSuggestions.length} suggestions handled.`
      : "No suggestions.";
    list.appendChild(done);
  }
}

// Refuse accept when the user has switched docs since the query ran.
// Suggestions were resolved against the source doc's rects/pages; applying
// them to a different doc would create snippets with rects that don't
// correspond to anything in the new doc.
function canAcceptSuggestion(sug) {
  if (sug._sourcePath && sug._sourcePath !== state.currentPdfPath) {
    const fname = sug._sourcePath.split("/").pop() || sug._sourcePath;
    aiSetStatus(`These suggestions are for ${fname} — switch back to that doc to accept.`, "error");
    return false;
  }
  return true;
}

async function acceptAiSuggestion(sug) {
  if (!canAcceptSuggestion(sug)) return;
  sug.accepted = true;
  // Group hint → existing group (fuzzy-matched) or auto-create a new one.
  let groupIds = [];
  if (sug.group_hint) {
    const id = resolveOrCreateGroup(sug.group_hint);
    if (id) groupIds = [id];
  }

  if (sug.kind === "image") {
    const r = sug.resolved?.rect;
    const page = sug.resolved?.page || sug.page;
    const label = sug.resolved?.label || sug.label || `Region p.${page || 1}`;

    // Happy path: we have a real rect on a real page → render the clip.
    if (r && page && state.pdfDoc) {
      const id = crypto.randomUUID();
      try {
        const pngBytes = await renderRegionPng(state.pdfDoc, page, r, 2);
        const imagePath = await getStore().writeClip(state.currentPdfPath, id, pngBytes);
        const snippet = {
          id,
          kind: "image",
          page,
          text: label,
          rects: [r],
          imagePath,
          comment: sug.reason || "",
          created: new Date().toISOString(),
          groups: groupIds,
          meta: { source: "ai" },
        };
        state.snippets.push(snippet);
        undoStack.push({ type: "add", id: snippet.id });
        await persist();
        refreshActiveView();
        applyAllHighlights();
        renderAiDrawer();
        aiSetStatus(`Accepted: ${label}`);
        return;
      } catch (err) {
        console.error("[ai] image clip render/save failed; degrading to text snippet", err);
        aiSetStatus(`Image clip failed — marked at page top: ${err.message || err}`, "error");
        // fall through to degraded text snippet
      }
    } else {
      console.warn("[ai] image suggestion missing rect or page; ghost marker on page", {
        hasRect: !!r, hasPage: !!page, sug,
      });
      aiSetStatus(`No usable rect from model — placed ghost marker on page ${page || 1}.`);
    }
    // Degraded path: no rect or render failed → store as a text snippet
    // describing the figure. User can locate manually with the R tool.
    const tSnippet = {
      id: crypto.randomUUID(),
      kind: "text",
      page: page || 1,
      text: label,
      rects: [],
      comment: sug.reason || "",
      created: new Date().toISOString(),
      groups: groupIds,
      meta: { source: "ai", origin: "image-fallback" },
    };
    state.snippets.push(tSnippet);
    undoStack.push({ type: "add", id: tSnippet.id });
    persist();
    refreshActiveView();
    applyAllHighlights();
    renderAiDrawer();
    paintAiPreviews();
    return;
  }

  // Text suggestion: spread the resolver's canonical spec output.
  const base = sug.resolved || {
    text: sug.quote,
    page: sug.page || 1,
    rects: [],
    kind: "text",
    textNormalized: (sug.quote || "").replace(/\s+/g, " ").trim(),
  };
  const snippet = {
    ...base,
    id: crypto.randomUUID(),
    comment: sug.reason || "",
    created: new Date().toISOString(),
    groups: groupIds,
    meta: { source: "ai" },
  };
  state.snippets.push(snippet);
  undoStack.push({ type: "add", id: snippet.id });
  persist();
  refreshActiveView();
  applyAllHighlights();
  renderAiDrawer();
  paintAiPreviews();
  aiSetStatus(sug.resolved ? "Accepted" : "Accepted — ghost marker (locator failed; refine manually).");
}
function rejectAiSuggestion(sug) {
  sug.rejected = true;
  renderAiDrawer();
  paintAiPreviews();
}

// AI is treated as a premium add-on — surfaces are hidden by default
// so the snippets pane reads clean. Click the AI toggle (✨) in the
// header to expand; click again to collapse. State persists.
const AI_EXPANDED_KEY = "marklee-ai-expanded";
function isAiExpanded() {
  try { return localStorage.getItem(AI_EXPANDED_KEY) === "1"; } catch { return false; }
}
function setAiExpanded(v) {
  try { localStorage.setItem(AI_EXPANDED_KEY, v ? "1" : "0"); } catch {}
  applyAiExpandedState();
}
function applyAiExpandedState() {
  const on = isAiExpanded();
  document.body.classList.toggle("ai-expanded", on);
  const btn = document.getElementById("ai-toggle-btn");
  if (btn) btn.setAttribute("aria-pressed", on ? "true" : "false");
  // Collapsing also hides any open drawer + clears its preview overlays
  if (!on) {
    const drawer = document.getElementById("ai-drawer");
    if (drawer && !drawer.hidden) hideAiDrawer();
  } else {
    // Focus the ask input when expanding so the user can type immediately.
    setTimeout(() => document.getElementById("ai-ask-input")?.focus(), 50);
  }
}
applyAiExpandedState();
document.getElementById("ai-toggle-btn").addEventListener("click", () => {
  setAiExpanded(!isAiExpanded());
});

document.getElementById("ai-ask-submit").addEventListener("click", aiAsk);
document.getElementById("ai-ask-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    aiAsk();
  } else if (e.key === "Escape") {
    e.target.blur();
  }
});
document.getElementById("ai-drawer-close").addEventListener("click", hideAiDrawer);
document.getElementById("ai-drawer-accept-all").addEventListener("click", () => {
  // Single-shot guard so the user sees the error once, not per-suggestion.
  // All pending suggestions in this batch share the same _sourcePath, so
  // checking the first pending one is sufficient.
  const firstPending = aiSuggestions.find((s) => !s.accepted && !s.rejected);
  if (firstPending && !canAcceptSuggestion(firstPending)) return;
  for (const s of aiSuggestions) {
    if (!s.accepted && !s.rejected) acceptAiSuggestion(s);
  }
});
document.getElementById("ai-drawer-reject-all").addEventListener("click", () => {
  for (const s of aiSuggestions) {
    if (!s.accepted && !s.rejected) s.rejected = true;
  }
  renderAiDrawer();
});

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
  // Switching the dropdown previews that provider's models + key state
  // but doesn't persist until Save. To keep things simple we DO persist
  // the provider choice immediately so the model dropdown reflects it.
  const id = e.target.value;
  setProviderId(id);
  rebuildAiModelDropdown(id);
  updateAiKeyFieldForProvider(id);
});
document.getElementById("ai-settings-save").addEventListener("click", async () => {
  const provId = document.getElementById("ai-settings-provider").value;
  setProviderId(provId);
  const keyEl = document.getElementById("ai-settings-key");
  if (keyEl.dataset.touched === "1") {
    const v = keyEl.value.trim();
    if (v) {
      try { await setProviderApiKey(provId, v); }
      catch (err) { aiSetStatus("Failed to save API key: " + (err.message || err), "error"); return; }
    }
  }
  setProviderModel(provId, document.getElementById("ai-settings-model").value);
  setConsented(document.getElementById("ai-settings-consent").checked);
  setIncludeFigures(document.getElementById("ai-settings-figures").checked);
  setOnnxLayoutEnabled(document.getElementById("ai-settings-onnx").checked);
  closeAiSettings();
  if (!hasApiKey()) aiSetStatus("No API key set for the selected provider.", "error");
  else aiSetStatus("Settings saved.");
});
document.getElementById("ai-settings-clear").addEventListener("click", async () => {
  const provId = document.getElementById("ai-settings-provider").value;
  try { await setProviderApiKey(provId, ""); }
  catch (err) { aiSetStatus("Failed to clear API key: " + (err.message || err), "error"); }
  document.getElementById("ai-settings-key").value = "";
  document.getElementById("ai-settings-key").dataset.touched = "1";
  document.getElementById("ai-settings-key-state").textContent = "— not set";
});
function toggleMaximizePane() {
  document.body.classList.toggle("pane-max");
  setTimeout(() => {
    if (state.view === "map" && mapInitialized) MapView.resize();
    if (state.view === "lineage" && lineageInitialized) {
      LineageView.resize();
      LineageView.fit();
    }
  }, 80);
}
document.getElementById("maximize-btn").addEventListener("click", toggleMaximizePane);

const THEME_LABELS = {
  cream:     { label: "Cream",     swatch: "#2ea58c" },
  slate:     { label: "Slate",     swatch: "#2563b3" },
  dark:      { label: "Dark",      swatch: "#4ec9b0" },
  sepia:     { label: "Sepia",     swatch: "#b85c2a" },
  bubblegum: { label: "Bubblegum", swatch: "#ff3b8a" },
  popshow:   { label: "Popshow",   swatch: "#ff2d8a" },
  forest:    { label: "Forest",    swatch: "#4d8a5a" },
  ocean:     { label: "Ocean",     swatch: "#1f7a96" },
  midnight:  { label: "Midnight",  swatch: "#7c9fff" },
  terminal:  { label: "Terminal",  swatch: "#4dff88" },
  paper:     { label: "Paper",     swatch: "#c92128" },
  steampunk: { label: "Steampunk", swatch: "#c98a3a" },
  vapor:     { label: "Vapor",     swatch: "#a78bfa" },
};

function buildThemeMenu() {
  const menu = document.getElementById("theme-menu");
  const cur = state.workspace.theme || "cream";
  menu.innerHTML = "";
  for (const cat of THEME_CATEGORIES) {
    const head = document.createElement("div");
    head.className = "theme-menu-category";
    head.textContent = cat.label;
    menu.appendChild(head);
    for (const t of cat.themes) {
      const meta = THEME_LABELS[t] || { label: t, swatch: "#888" };
      const item = document.createElement("button");
      item.type = "button";
      item.className = "theme-menu-item";
      item.role = "menuitemradio";
      item.dataset.theme = t;
      if (t === cur) item.classList.add("active");
      item.innerHTML = `<span class="theme-swatch" style="background:${meta.swatch}"></span><span>${meta.label}</span>`;
      item.addEventListener("click", () => {
        setWorkspaceTheme(t);
        closeThemeMenu();
      });
      menu.appendChild(item);
    }
  }
}
function openThemeMenu() {
  buildThemeMenu();
  const menu = document.getElementById("theme-menu");
  const btn = document.getElementById("theme-btn");
  menu.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  // Position below + right-aligned to the button.
  const r = btn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.right = `${window.innerWidth - r.right}px`;
  setTimeout(() => {
    document.addEventListener("mousedown", themeMenuOutsideClick);
    document.addEventListener("keydown", themeMenuKeydown);
  }, 0);
}
function closeThemeMenu() {
  const menu = document.getElementById("theme-menu");
  if (menu.hidden) return;
  menu.hidden = true;
  document.getElementById("theme-btn").setAttribute("aria-expanded", "false");
  document.removeEventListener("mousedown", themeMenuOutsideClick);
  document.removeEventListener("keydown", themeMenuKeydown);
}
function themeMenuOutsideClick(e) {
  const menu = document.getElementById("theme-menu");
  const btn = document.getElementById("theme-btn");
  if (menu.contains(e.target) || btn.contains(e.target)) return;
  closeThemeMenu();
}
function themeMenuKeydown(e) {
  if (e.key === "Escape") { e.preventDefault(); closeThemeMenu(); }
}

document.getElementById("theme-btn").addEventListener("click", () => {
  const menu = document.getElementById("theme-menu");
  if (menu.hidden) openThemeMenu();
  else closeThemeMenu();
});

function toggleSidebar() {
  document.body.classList.toggle("sidebar-collapsed");
  try {
    localStorage.setItem("pdf-annotator-sidebar-collapsed",
      document.body.classList.contains("sidebar-collapsed") ? "1" : "0");
  } catch {}
}
document.getElementById("sidebar-collapse").addEventListener("click", toggleSidebar);
try {
  if (localStorage.getItem("pdf-annotator-sidebar-collapsed") === "1") {
    document.body.classList.add("sidebar-collapsed");
  }
} catch {}

// VSCode-style collapsible sidebar sections. Click the section header
// (anywhere except inline buttons/inputs) to toggle. State persists.
const SIDEBAR_SECTION_KEY = "pdf-annotator-sidebar-sections-collapsed";
function getCollapsedSections() {
  try { return new Set(JSON.parse(localStorage.getItem(SIDEBAR_SECTION_KEY) || "[]")); }
  catch { return new Set(); }
}
function persistCollapsedSections(set) {
  try { localStorage.setItem(SIDEBAR_SECTION_KEY, JSON.stringify([...set])); } catch {}
}
(() => {
  const collapsed = getCollapsedSections();
  for (const sec of document.querySelectorAll("#sidebar .sidebar-section")) {
    if (collapsed.has(sec.id)) sec.classList.add("collapsed");
    const header = sec.querySelector(":scope > .sidebar-section-header");
    if (!header) continue;
    header.addEventListener("click", (e) => {
      // Inline buttons/inputs in the header keep their own behavior.
      if (e.target.closest("button, input")) return;
      sec.classList.toggle("collapsed");
      const set = getCollapsedSections();
      if (sec.classList.contains("collapsed")) set.add(sec.id);
      else set.delete(sec.id);
      persistCollapsedSections(set);
    });
  }
})();

document.getElementById("help-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const pop = document.getElementById("help-popover");
  pop.hidden = !pop.hidden;
});
document.addEventListener("click", (e) => {
  const pop = document.getElementById("help-popover");
  if (pop.hidden) return;
  if (!pop.contains(e.target) && e.target.id !== "help-btn") pop.hidden = true;
});
document.getElementById("summary-close").addEventListener("click", closeSummary);
document.getElementById("summary-copy").addEventListener("click", copySummary);
document.getElementById("summary-export").addEventListener("click", exportSummaryHtml);
document.querySelectorAll("#summary-scope .seg-btn").forEach((b) => {
  b.addEventListener("click", () => setSummaryScope(b.dataset.scope));
});
document.querySelectorAll("#summary-format .seg-btn").forEach((b) => {
  b.addEventListener("click", () => setSummaryFormat(b.dataset.format));
});
document.querySelectorAll("#summary-image-size .seg-btn").forEach((b) => {
  b.addEventListener("click", () => setSummaryImageSize(b.dataset.imgSize));
});
document.querySelector("#summary-modal .modal-backdrop").addEventListener("click", closeSummary);

document.querySelectorAll(".tool-btn").forEach((b) => {
  b.addEventListener("click", () => setTool(b.dataset.tool));
});

document.querySelectorAll(".tab-btn").forEach((b) => {
  b.addEventListener("click", () => switchView(b.dataset.view));
});

document.querySelectorAll("#map-scope .seg-btn").forEach((b) => {
  b.addEventListener("click", () => setMapScope(b.dataset.scope));
});

// Sort toggle (order ↔ rank) removed for now. state.snippetSort is
// still defaulted to "order" in the state initializer so the existing
// rank-sort branch in renderSnippets stays inert; restore the toggle
// HTML + handler if the option is re-introduced later.

document.getElementById("edge-save").addEventListener("click", saveEdgeLabel);
document.getElementById("edge-delete").addEventListener("click", () => {
  if (selectedEdge) {
    MapView.deleteEdge(selectedEdge);
    selectedEdge = null;
    document.getElementById("edge-editor").hidden = true;
  }
});
document.getElementById("edge-label-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); saveEdgeLabel(); }
});

// Capture-phase listener so we beat the webview's built-in Cmd+F /
// Cmd+- / Cmd+= zoom handlers (WKWebView grabs these before bubble phase).
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey) {
    if (e.key === "=" || e.key === "+") { e.preventDefault(); zoomIn(); }
    else if (e.key === "-") { e.preventDefault(); zoomOut(); }
    else if (e.key === "0") { e.preventDefault(); zoomFit(); }
    else if (e.key === "z" || e.key === "Z") {
      const tag = e.target.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      e.preventDefault();
      undo();
    }
    else if ((e.key === "f" || e.key === "F") && e.shiftKey) {
      e.preventDefault();
      openGlobalSearch();
    }
    else if ((e.key === "m" || e.key === "M") && e.shiftKey) {
      e.preventDefault();
      toggleMaximizePane();
    }
    else if (e.key === "b" || e.key === "B") {
      const tag = e.target.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      e.preventDefault();
      toggleSidebar();
    }
    else if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      openFindInDoc();
    }
    return;
  }
  const tag = e.target.tagName;
  if (e.key === "Escape") {
    if (document.activeElement && document.activeElement.id === "local-search-input") {
      clearLocalSearch();
      return;
    }
    const gs = document.getElementById("global-search");
    if (!gs.hidden) { closeGlobalSearch(); return; }
  }
  if (tag === "TEXTAREA" || tag === "INPUT") return;
  if (e.key === "t" || e.key === "T") setTool("select");
  else if (e.key === "r" || e.key === "R") {
    if (state.source.kind === "pdf") setTool("rect");
  }
}, { capture: true });

const LOCAL_SEARCH_KEY = "pdf-annotator-local-search";
let localSearchQuery = "";
try { localSearchQuery = localStorage.getItem(LOCAL_SEARCH_KEY) || ""; } catch {}

function openLocalSearch() {
  const input = document.getElementById("local-search-input");
  if (input.value !== localSearchQuery) input.value = localSearchQuery;
  input.focus();
  input.select();
}
function clearLocalSearch() {
  const input = document.getElementById("local-search-input");
  input.value = "";
  localSearchQuery = "";
  try { localStorage.setItem(LOCAL_SEARCH_KEY, ""); } catch {}
  input.blur();
  refreshActiveView();
}
function closeLocalSearch() { clearLocalSearch(); }

(() => {
  const input = document.getElementById("local-search-input");
  input.value = localSearchQuery;
  input.addEventListener("input", (e) => {
    localSearchQuery = e.target.value;
    try { localStorage.setItem(LOCAL_SEARCH_KEY, localSearchQuery); } catch {}
    refreshActiveView();
  });
})();

// ── Find in document (⌘F) ─────────────────────────────────────────
let findHits = [];
let findCurrent = -1;

function openFindInDoc() {
  const bar = document.getElementById("find-bar");
  const input = document.getElementById("find-input");
  bar.hidden = false;
  input.focus();
  input.select();
}
function closeFindInDoc() {
  const bar = document.getElementById("find-bar");
  bar.hidden = true;
  clearFindHighlights();
  findHits = [];
  findCurrent = -1;
  updateFindCount();
}
function clearFindHighlights() {
  for (const m of viewerContainer.querySelectorAll("mark.find-hit")) {
    const parent = m.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  }
}
function updateFindCount() {
  const el = document.getElementById("find-count");
  if (!el) return;
  if (findHits.length === 0) {
    el.textContent = document.getElementById("find-input").value ? "no matches" : "0 / 0";
  } else {
    el.textContent = `${findCurrent + 1} / ${findHits.length}`;
  }
  document.getElementById("find-prev").disabled = findHits.length === 0;
  document.getElementById("find-next").disabled = findHits.length === 0;
}
function runFindInDoc(query) {
  clearFindHighlights();
  findHits = [];
  findCurrent = -1;
  if (!query) { updateFindCount(); return; }
  const q = query.toLowerCase();
  // For PDF, the textLayer wraps each text run in a <span>. For flow docs
  // (md/txt/docx), the article has nested elements. In both cases we walk
  // text nodes, find substring matches, and wrap them in <mark>.
  const walker = document.createTreeWalker(
    viewerContainer,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        // Skip text inside existing find marks (we cleared them above) and
        // inside <script>/<style>.
        const p = n.parentNode;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.nodeName;
        if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (const node of nodes) {
    const lower = node.nodeValue.toLowerCase();
    let i = 0;
    let lastEnd = 0;
    const frag = document.createDocumentFragment();
    let any = false;
    while ((i = lower.indexOf(q, lastEnd)) !== -1) {
      any = true;
      if (i > lastEnd) frag.appendChild(document.createTextNode(node.nodeValue.slice(lastEnd, i)));
      const mark = document.createElement("mark");
      mark.className = "find-hit";
      mark.textContent = node.nodeValue.slice(i, i + q.length);
      frag.appendChild(mark);
      findHits.push(mark);
      lastEnd = i + q.length;
    }
    if (any) {
      if (lastEnd < node.nodeValue.length) frag.appendChild(document.createTextNode(node.nodeValue.slice(lastEnd)));
      node.parentNode.replaceChild(frag, node);
    }
  }
  if (findHits.length > 0) {
    findCurrent = 0;
    activateCurrentFindHit();
  }
  updateFindCount();
}
function activateCurrentFindHit() {
  for (const m of findHits) m.classList.remove("find-hit-current");
  const cur = findHits[findCurrent];
  if (!cur) return;
  cur.classList.add("find-hit-current");
  cur.scrollIntoView({ behavior: "smooth", block: "center" });
}
function nextFindHit() {
  if (findHits.length === 0) return;
  findCurrent = (findCurrent + 1) % findHits.length;
  activateCurrentFindHit();
  updateFindCount();
}
function prevFindHit() {
  if (findHits.length === 0) return;
  findCurrent = (findCurrent - 1 + findHits.length) % findHits.length;
  activateCurrentFindHit();
  updateFindCount();
}

(() => {
  const input = document.getElementById("find-input");
  let debounce = 0;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => runFindInDoc(input.value), 100);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) prevFindHit();
      else nextFindHit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFindInDoc();
    }
  });
  document.getElementById("find-next").addEventListener("click", nextFindHit);
  document.getElementById("find-prev").addEventListener("click", prevFindHit);
  document.getElementById("find-close").addEventListener("click", closeFindInDoc);
})();

function snippetMatchesLocal(s) {
  if (!localSearchQuery) return true;
  const ql = localSearchQuery.toLowerCase();
  return (s.text || "").toLowerCase().includes(ql) ||
         (s.comment || "").toLowerCase().includes(ql);
}

function updateLocalSearchCount(n) {
  const el = document.getElementById("local-search-count");
  if (!el) return;
  el.textContent = localSearchQuery ? `${n}` : "";
}

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll(".tool-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === tool);
  });
  document.body.classList.toggle("tool-rect", tool === "rect");
  document.body.classList.toggle("tool-select", tool === "select");
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("summary-modal").hidden) {
    closeSummary();
  }
});

async function undo() {
  const action = undoStack.pop();
  if (!action) return;
  if (action.type === "add") {
    state.snippets = state.snippets.filter((s) => s.id !== action.id);
    if (state.workspace?.pastedSnippets) {
      state.workspace.pastedSnippets = state.workspace.pastedSnippets.filter((s) => s.id !== action.id);
    }
  } else if (action.type === "delete") {
    state.snippets.splice(Math.min(action.index, state.snippets.length), 0, action.snippet);
  } else if (action.type === "delete-pasted") {
    if (!Array.isArray(state.workspace.pastedSnippets)) state.workspace.pastedSnippets = [];
    const arr = state.workspace.pastedSnippets;
    arr.splice(Math.min(action.index, arr.length), 0, action.snippet);
  } else if (action.type === "delete-all") {
    state.snippets = action.snippets.slice();
    if (action.edges?.length) {
      if (!Array.isArray(state.edges)) state.edges = [];
      state.edges.push(...action.edges);
    }
  }
  saveAllWorkspaces();
  await persist();
  refreshActiveView();
  applyAllHighlights();
}

async function refreshFileExistence() {
  const items = Array.from(document.querySelectorAll("#file-list li[data-path], #recents-list li[data-path]"));
  if (!items.length) return;
  const paths = items.map((li) => li.dataset.path);
  let exists;
  try { exists = await getStore().checkPaths(paths); } catch { return; }
  items.forEach((li, i) => {
    li.classList.toggle("missing", !exists[i]);
    if (!exists[i]) li.title = `${li.dataset.path} (missing)`;
    else li.title = li.dataset.path;
  });
}

const RECENTS_KEY = "pdf-annotator-recents";
const RECENTS_LIMIT = 20;

function getRecents() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    // Filter out synthetic paths that can't be reopened (marklee:pasted etc.)
    // — these crept in from older code that called addRecent on every load.
    const cleaned = raw.filter((p) => typeof p === "string" && !p.startsWith("marklee:"));
    if (cleaned.length !== raw.length) {
      try { localStorage.setItem(RECENTS_KEY, JSON.stringify(cleaned)); } catch {}
    }
    return cleaned;
  } catch { return []; }
}

function addRecent(path) {
  // Don't track pseudo-sources — they're not real files.
  if (typeof path !== "string" || path.startsWith("marklee:")) return;
  const next = getRecents().filter((p) => p !== path);
  next.unshift(path);
  next.splice(RECENTS_LIMIT);
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch {}
  renderRecents();
}

function removeRecent(path) {
  const next = getRecents().filter((p) => p !== path);
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch {}
  renderRecents();
}

function renderRecents() {
  const list = document.getElementById("recents-list");
  const section = document.getElementById("recents-section");
  const recents = getRecents();
  list.innerHTML = "";
  if (recents.length === 0) { section.hidden = true; return; }
  section.hidden = false;
  for (const path of recents) {
    const li = document.createElement("li");
    li.dataset.path = path;
    li.title = path;
    const parts = path.split("/");
    const filename = parts.pop() || path;
    const parent = parts.pop() || "/";
    const name = document.createElement("div");
    name.className = "recent-name";
    const nameInner = document.createElement("span");
    nameInner.className = "recent-name-text";
    nameInner.textContent = filename;
    name.append(fileKindBadge(path), nameInner);
    const folder = document.createElement("div");
    folder.className = "recent-folder";
    folder.textContent = parent;
    folder.title = `Reveal in Finder: ${parent}`;
    folder.addEventListener("click", (e) => {
      // Click on the folder/path text reveals the file in Finder/Explorer
      // instead of opening it in the app — cheaper way to peek at the
      // surrounding directory.
      e.stopPropagation();
      revealInFinder(path);
    });
    li.append(name, folder);
    li.addEventListener("click", async () => {
      if (li.classList.contains("missing")) {
        alert(`File no longer exists:\n${path}`);
        return;
      }
      const inFolder = state.workspace.folders.some((f) => (f.pdfs || []).includes(path));
      const inFiles = state.workspace.files.includes(path);
      if (!inFolder && !inFiles) {
        state.workspace.files.push(path);
        saveWorkspace();
        await renderWorkspace();
      }
      loadPdf(path);
    });
    list.appendChild(li);
  }
  if (state.currentPdfPath) setActiveFile(state.currentPdfPath);
  refreshFileExistence();
}

function renderClipped() {
  const list = document.getElementById("clipped-list");
  const countEl = document.getElementById("clipped-count");
  if (!list) return;
  list.innerHTML = "";
  const items = (state.workspace?.pastedSnippets) || [];
  countEl.textContent = items.length ? String(items.length) : "";
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "clipped-empty";
    empty.textContent = "Pastes appear here";
    list.appendChild(empty);
    return;
  }
  for (const s of items) {
    const li = document.createElement("li");
    li.className = "clipped-item";
    li.dataset.snippetId = s.id;
    const icon = document.createElement("span");
    icon.className = "clipped-icon";
    icon.textContent = s.kind === "image" ? "🖼" : "📋";
    const label = document.createElement("span");
    label.className = "clipped-label";
    label.textContent = clippedLabelFor(s);
    const renameBtn = document.createElement("button");
    renameBtn.className = "clipped-rename";
    renameBtn.title = "Rename";
    renameBtn.textContent = "✎";
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startRenameClipped(li, s);
    });
    li.append(icon, label, renameBtn);
    li.title = s.kind === "image"
      ? (s.name ? `${s.name} — pasted image` : "Pasted image")
      : (s.name ? `${s.name} — ${s.text || ""}` : (s.text || ""));
    li.addEventListener("click", () => {
      const card = snippetsListEl.querySelector(`.snippet[data-snippet-id="${s.id}"]`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("flash");
        setTimeout(() => card.classList.remove("flash"), 900);
      }
    });
    li.addEventListener("dblclick", (e) => {
      // Don't hijack a dblclick on the rename button itself.
      if (e.target.closest(".clipped-rename")) return;
      e.preventDefault();
      startRenameClipped(li, s);
    });
    list.appendChild(li);
  }
}

function clippedLabelFor(s) {
  if (s.name) return s.name;
  if (s.kind === "image") return "Image clip";
  const text = (s.text || "").replace(/\s+/g, " ").trim();
  return text.length > 60 ? text.slice(0, 59) + "…" : text;
}

function startRenameClipped(li, s) {
  const label = li.querySelector(".clipped-label");
  if (!label || label.querySelector("input")) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "clipped-rename-input";
  input.value = s.name || "";
  input.placeholder = s.kind === "image" ? "Image clip" : "Untitled clip";
  label.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      const v = input.value.trim();
      s.name = v || undefined;
      persist();
      saveAllWorkspaces();
    }
    renderClipped();
    renderSnippets();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

document.getElementById("clear-recents").addEventListener("click", () => {
  try { localStorage.removeItem(RECENTS_KEY); } catch {}
  renderRecents();
});

renderRecents();
renderWorkspaceTabs();
renderWorkspace();
renderGroups();
renderClipped();

document.getElementById("groups-collapse").addEventListener("click", () => {
  document.getElementById("groups-panel").classList.toggle("collapsed");
});

// Snippets / Lineage / Map section collapse — toggles a class on the
// outer #snippets-pane so the view-stack hides but the section header
// stays clickable to expand again.
document.getElementById("snippets-section-collapse").addEventListener("click", () => {
  document.getElementById("snippets-pane").classList.toggle("snippets-collapsed");
});

document.getElementById("groups-template").addEventListener("click", openTemplatesModal);
document.getElementById("groups-overflow").addEventListener("click", (e) => {
  e.stopPropagation();
  openGroupsOverflowMenu(e.currentTarget);
});

function openGroupsOverflowMenu(anchor) {
  closeGroupsOverflow();
  const pop = document.createElement("div");
  pop.className = "groups-overflow-menu";
  const items = [
    { label: "Import from workspace…", fn: importGroupsFromWorkspace },
    { label: "Import from JSON…",      fn: importGroups },
    { label: "Export as JSON…",        fn: exportGroups },
  ];
  for (const item of items) {
    const b = document.createElement("button");
    b.className = "groups-overflow-item";
    b.textContent = item.label;
    b.addEventListener("click", () => { closeGroupsOverflow(); item.fn(); });
    pop.appendChild(b);
  }
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  let left = r.right - pop.offsetWidth;
  let top = r.bottom + 4;
  if (left < 8) left = 8;
  if (top + pop.offsetHeight > window.innerHeight - 8) top = r.top - pop.offsetHeight - 4;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  _activeGroupsOverflow = pop;
  setTimeout(() => {
    document.addEventListener("click", _onGroupsOverflowOutside, true);
    document.addEventListener("keydown", _onGroupsOverflowEsc, true);
  }, 0);
}
let _activeGroupsOverflow = null;
function closeGroupsOverflow() {
  if (_activeGroupsOverflow) { _activeGroupsOverflow.remove(); _activeGroupsOverflow = null; }
  document.removeEventListener("click", _onGroupsOverflowOutside, true);
  document.removeEventListener("keydown", _onGroupsOverflowEsc, true);
}
function _onGroupsOverflowOutside(e) {
  if (!_activeGroupsOverflow) return;
  if (_activeGroupsOverflow.contains(e.target)) return;
  closeGroupsOverflow();
}
function _onGroupsOverflowEsc(e) { if (e.key === "Escape") closeGroupsOverflow(); }
document.getElementById("templates-close").addEventListener("click", closeTemplatesModal);
document.querySelector("#templates-modal .modal-backdrop").addEventListener("click", closeTemplatesModal);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("templates-modal").hidden) {
    closeTemplatesModal();
  }
});

function openTemplatesModal() {
  const modal = document.getElementById("templates-modal");
  const body = document.getElementById("templates-body");
  renderTemplatesModalBody(body);
  modal.hidden = false;
}

function renderTemplatesModalBody(body) {
  body.innerHTML = "";

  // "Save current as template" — top of the modal so it's always reachable
  const saveBar = document.createElement("div");
  saveBar.className = "tpl-savebar";
  const saveLabel = document.createElement("div");
  saveLabel.className = "tpl-savebar-label";
  saveLabel.innerHTML = "Save the current workspace's groups as a reusable template";
  const saveBtn = document.createElement("button");
  saveBtn.className = "tpl-savebtn";
  saveBtn.textContent = "Save current as template";
  saveBtn.addEventListener("click", () => saveCurrentGroupsAsTemplate(body));
  saveBar.append(saveLabel, saveBtn);
  body.appendChild(saveBar);

  for (const tpl of listAllTemplates()) {
    const item = document.createElement("div");
    item.className = "tpl-item";
    if (!isBuiltinTemplate(tpl.id)) item.classList.add("tpl-item-user");

    const title = document.createElement("div");
    title.className = "tpl-title";
    title.textContent = tpl.name;
    if (!isBuiltinTemplate(tpl.id)) {
      const userTag = document.createElement("span");
      userTag.className = "tpl-user-tag";
      userTag.textContent = "yours";
      title.appendChild(userTag);
    }

    const desc = document.createElement("div");
    desc.className = "tpl-desc";
    desc.textContent = tpl.description || "";

    const preview = document.createElement("div");
    preview.className = "tpl-preview";
    for (const g of tpl.groups) {
      const pill = document.createElement("span");
      pill.className = "tpl-pill";
      const dot = document.createElement("span");
      dot.className = "tpl-pill-dot";
      dot.style.background = readPaletteColor(g.slot);
      const name = document.createElement("span");
      name.textContent = g.name;
      pill.append(dot, name);
      preview.appendChild(pill);
    }

    const actions = document.createElement("div");
    actions.className = "tpl-actions";
    const apply = document.createElement("button");
    apply.className = "tpl-apply";
    apply.textContent = "Apply";
    apply.addEventListener("click", () => {
      applyGroupTemplate(tpl.id);
      closeTemplatesModal();
    });
    actions.appendChild(apply);
    if (!isBuiltinTemplate(tpl.id)) {
      const del = document.createElement("button");
      del.className = "tpl-delete";
      del.textContent = "Delete";
      del.title = "Delete this user template (built-ins can't be deleted)";
      del.addEventListener("click", () => {
        if (!confirm(`Delete template "${tpl.name}"? This doesn't affect any groups already created from it.`)) return;
        deleteUserTemplate(tpl.id);
        renderTemplatesModalBody(body);
      });
      actions.appendChild(del);
    }

    item.append(title, desc, preview, actions);
    body.appendChild(item);
  }
}

function saveCurrentGroupsAsTemplate(body) {
  const groupsMeta = state.groupsMeta || [];
  if (groupsMeta.length === 0) {
    alert("This workspace has no groups yet. Create a few groups first, then save them as a template.");
    return;
  }
  const name = prompt("Template name", `${state.workspace.name || "My"} groups`);
  if (!name || !name.trim()) return;
  const description = prompt("Short description (optional)", "") || "";
  const tpl = {
    id: `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim(),
    description: description.trim(),
    groups: groupsMeta.map((g, i) => ({
      name: g.name || `Group ${i + 1}`,
      slot: typeof g.paletteSlot === "number" ? g.paletteSlot : (i % GROUP_PALETTE_SLOTS),
    })),
  };
  addUserTemplate(tpl);
  renderTemplatesModalBody(body);
}

function closeTemplatesModal() {
  document.getElementById("templates-modal").hidden = true;
}

function applyGroupTemplate(id) {
  const tpl = findTemplate(id);
  if (!tpl) return;
  const existingNames = new Set((state.groupsMeta || []).map((g) => g.name.toLowerCase()));
  let added = 0;
  for (const g of tpl.groups) {
    if (existingNames.has(g.name.toLowerCase())) continue;
    state.groupsMeta.push({
      id: crypto.randomUUID(),
      name: g.name,
      paletteSlot: g.slot,
    });
    added++;
  }
  saveAllWorkspaces();
  renderGroups();
  flashButton("groups-template", added ? `+${added}` : "no new");
}

function importGroupsFromWorkspace() {
  const others = state.workspaces.order
    .map((id) => state.workspaces.byId[id])
    .filter((ws) => ws && ws.id !== state.workspaces.active)
    .map((ws) => ({
      id: ws.id,
      name: ws.name || "Workspace",
      groups: Array.isArray(ws.groupsMeta) ? ws.groupsMeta : [],
    }))
    .filter((ws) => ws.groups.length > 0);

  if (others.length === 0) {
    alert("No other workspaces have groups defined yet.");
    return;
  }
  openWsImportModal(others);
}

function openWsImportModal(workspaces) {
  const modal = document.getElementById("ws-import-modal");
  const body = document.getElementById("ws-import-body");
  const countEl = document.getElementById("ws-import-count");
  const confirmBtn = document.getElementById("ws-import-confirm");
  const cancelBtn = document.getElementById("ws-import-cancel");
  const closeBtn = document.getElementById("ws-import-close");
  body.innerHTML = "";

  const existingIds = new Set((state.groupsMeta || []).map((g) => g.id));
  const checkboxes = [];

  for (const ws of workspaces) {
    const section = document.createElement("div");
    section.className = "ws-import-section";

    const header = document.createElement("div");
    header.className = "ws-import-section-header";
    const name = document.createElement("span");
    name.className = "ws-import-section-name";
    name.textContent = `${ws.name} · ${ws.groups.length} group${ws.groups.length === 1 ? "" : "s"}`;
    const selectAll = document.createElement("button");
    selectAll.className = "ws-import-select-all";
    selectAll.textContent = "select all";
    header.append(name, selectAll);
    section.appendChild(header);

    const list = document.createElement("div");
    list.className = "ws-import-grouplist";
    const sectionBoxes = [];
    for (const g of ws.groups) {
      const row = document.createElement("label");
      row.className = "ws-import-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.workspaceId = ws.id;
      cb.dataset.groupId = g.id;
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = g.color
        || (typeof g.paletteSlot === "number"
          ? `var(--group-palette-${g.paletteSlot + 1})`
          : "#888");
      const label = document.createElement("span");
      label.className = "name";
      label.textContent = g.name || `(unnamed: ${g.id.slice(0, 6)})`;
      row.append(cb, swatch, label);
      if (existingIds.has(g.id)) {
        const tag = document.createElement("span");
        tag.className = "conflict";
        tag.textContent = "exists";
        tag.title = "A group with this id already exists; importing will update its name/color if missing.";
        row.appendChild(tag);
      }
      cb.addEventListener("change", updateCount);
      sectionBoxes.push(cb);
      checkboxes.push({ cb, group: g });
      list.appendChild(row);
    }
    selectAll.addEventListener("click", () => {
      const allChecked = sectionBoxes.every((b) => b.checked);
      sectionBoxes.forEach((b) => { b.checked = !allChecked; });
      updateCount();
    });
    section.appendChild(list);
    body.appendChild(section);
  }

  function updateCount() {
    const n = checkboxes.filter((c) => c.cb.checked).length;
    countEl.textContent = n === 0 ? "Nothing selected" : `${n} group${n === 1 ? "" : "s"} selected`;
    confirmBtn.disabled = n === 0;
  }
  updateCount();

  function close() {
    modal.hidden = true;
    document.removeEventListener("keydown", onKey, true);
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  }
  function confirm() {
    const existing = new Map((state.groupsMeta || []).map((g) => [g.id, g]));
    let added = 0;
    let updated = 0;
    for (const { cb, group } of checkboxes) {
      if (!cb.checked) continue;
      if (existing.has(group.id)) {
        const cur = existing.get(group.id);
        let touched = false;
        if (group.name && !cur.name) { cur.name = group.name; touched = true; }
        if (group.color && !cur.color) { cur.color = group.color; touched = true; }
        if (typeof group.paletteSlot === "number" && cur.paletteSlot == null) {
          cur.paletteSlot = group.paletteSlot;
          touched = true;
        }
        if (touched) updated++;
      } else {
        existing.set(group.id, { ...group });
        added++;
      }
    }
    state.groupsMeta = [...existing.values()];
    saveAllWorkspaces();
    renderGroups();
    refreshActiveView();
    flashButton("groups-import-ws", `+${added}~${updated}`);
    close();
  }

  modal.hidden = false;
  document.addEventListener("keydown", onKey, true);
  confirmBtn.onclick = confirm;
  cancelBtn.onclick = close;
  closeBtn.onclick = close;
  modal.querySelector(".modal-backdrop").onclick = close;
}

async function exportGroups() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    groups: state.groupsMeta || [],
  };
  const json = JSON.stringify(payload, null, 2);
  const suggestedName = `pdf-annotator-groups-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    const saved = await saveFile({ suggestedName, mimeType: "application/json", content: json });
    if (saved) flashButton("groups-export", "exported");
  } catch (err) {
    console.error("groups export failed", err);
    flashButton("groups-export", "failed");
  }
}

async function importGroups() {
  let bytes;
  if (IS_TAURI) {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    bytes = await getStore().readDocumentBytes(path);
  } else {
    const file = await pickBrowserFile([{ description: "JSON", accept: { "application/json": [".json"] } }]);
    if (!file) return;
    bytes = new Uint8Array(await file.arrayBuffer());
  }
  try {
    const json = new TextDecoder().decode(new Uint8Array(bytes));
    const parsed = JSON.parse(json);
    const incoming = Array.isArray(parsed) ? parsed : (parsed.groups || []);
    if (!Array.isArray(incoming)) throw new Error("File doesn't contain a groups array");

    const choice = confirm(
      `Import ${incoming.length} group(s)?\n\n` +
      `OK: merge with existing (incoming names/colors win on duplicate ids)\n` +
      `Cancel: abort`,
    );
    if (!choice) return;

    const map = new Map((state.groupsMeta || []).map((g) => [g.id, { ...g }]));
    let added = 0;
    let updated = 0;
    for (const g of incoming) {
      if (!g || !g.id) continue;
      if (map.has(g.id)) {
        const e = map.get(g.id);
        if (g.name) e.name = g.name;
        if (g.color) e.color = g.color;
        updated++;
      } else {
        map.set(g.id, { id: g.id, name: g.name || "", color: g.color || undefined });
        added++;
      }
    }
    state.groupsMeta = [...map.values()];
    saveAllWorkspaces();
    refreshActiveView();
    applyAllHighlights();
    flashButton("groups-import", `+${added} ~${updated}`);
  } catch (err) {
    console.error("import failed", err);
    alert(`Import failed: ${err.message || err}`);
  }
}

function flashButton(id, text) {
  const btn = document.getElementById(id);
  if (!btn) return;
  // Preserve innerHTML, not textContent — icon buttons hold inline SVGs
  // whose textContent is "", so restoring textContent destroys the icon.
  const prev = btn.innerHTML;
  btn.textContent = text;
  setTimeout(() => { btn.innerHTML = prev; }, 1100);
}

// Legacy groups-bootstrap IIFE removed when state.groupsMeta moved from
// workspace-level (persistent) to per-document (ephemeral, hydrated from
// each sidecar's `groups` array on doc load). Both the legacy-group
// migration and the DEFAULT_GROUP seeding ran at startup and wrote into
// state.groupsMeta, which is now cleared on every loadAnyDocument — so
// they had no lasting effect. The default group, if desired, can be
// added when a sidecar is first created; the legacy migration is
// long-past for any active user.

function setActiveFile(path) {
  document.querySelectorAll("#file-list li, #recents-list li").forEach((li) => {
    li.classList.toggle("active", li.dataset.path === path);
  });
}

async function loadPdf(path) {
  try {
    return await loadAnyDocument(path);
  } catch (err) {
    console.error("[loadPdf] failed for", path, err);
    alert(`Failed to open ${path.split("/").pop()}:\n${err?.message || err}`);
    throw err;
  }
}

async function loadAnyDocument(path) {
  const myToken = ++docLoadToken;
  const kind = detectKindFromPath(path);

  // Clear stale doc state synchronously so an interleaved load can't
  // see another doc's snippets/edges/highlights between awaits.
  state.snippets = [];
  state.edges = [];
  state.groupsMeta = [];
  state.sidecarMtimeMs = 0;
  state.pdfDoc = null;
  state.flowDoc = null;
  state.currentPdfPath = path;
  state.source = { path, filename: path.split("/").pop() || "", title: "", author: "", kind };
  applyAllHighlights();

  addRecent(path);
  saveAllWorkspaces();
  undoStack.length = 0;
  expandedIds.clear();
  setActiveFile(path);
  viewerEmpty.style.display = "none";
  viewerContainer.innerHTML = "";
  delete viewerContainer.dataset.flow;
  delete viewerContainer.dataset.kind;
  viewerScroll.scrollLeft = 0;
  viewerScroll.scrollTop = 0;
  document.body.dataset.sourceKind = kind;

  const bytes = await getStore().readDocumentBytes(path);
  if (myToken !== docLoadToken) return;
  const filename = path.split("/").pop() || "";
  const existing = await getStore().readAnnot(path);
  if (myToken !== docLoadToken) return;

  let title = filename.replace(/\.(pdf|md|markdown|docx|txt|text)$/i, "");
  let author = "";

  if (kind === "pdf") {
    const data = new Uint8Array(bytes);
    state.pdfDoc = await loadPdfDocument(data);
    if (myToken !== docLoadToken) return;
    const meta = await state.pdfDoc.getMetadata().catch(() => null);
    if (myToken !== docLoadToken) return;
    const info = meta?.info || {};
    title = (info.Title || "").trim() || title;
    author = (info.Author || "").trim();
  } else if (kind === "markdown") {
    const text = new TextDecoder("utf-8").decode(new Uint8Array(bytes));
    state.flowDoc = { kind, text };
    const firstHeading = text.match(/^#{1,6}\s+(.+)$/m);
    if (firstHeading) title = firstHeading[1].trim();
  } else if (kind === "docx") {
    state.flowDoc = { kind, bytes: new Uint8Array(bytes) };
  } else if (kind === "text") {
    const text = new TextDecoder("utf-8").decode(new Uint8Array(bytes));
    state.flowDoc = { kind, text };
    // First non-empty line as the title.
    const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (firstLine) title = firstLine.slice(0, 120);
  }

  if (myToken !== docLoadToken) return;
  let contentHash = existing.source?.contentHash || null;
  if (!contentHash) {
    try {
      contentHash = await hashBytes(bytes);
    } catch (err) {
      console.warn("hashBytes failed", err);
    }
    if (myToken !== docLoadToken) return;
  }
  state.source = {
    path,
    filename,
    title: existing.source?.title || title,
    author: existing.source?.author || author,
    kind,
    contentHash,
  };
  state.snippets = existing.snippets || [];
  state.edges = existing.edges || [];
  // state.groupsMeta was reset to [] in the sync clear block at the top
  // of this function, so this is a direct copy — no dedup needed.
  state.groupsMeta = (existing.groups || []).map((g) => ({ ...g }));
  // Capture the sidecar's mtime at read time so the next persist can
  // do an optimistic-concurrency check (Wave 2).
  state.sidecarMtimeMs = Number(existing._mtimeMs) || 0;
  saveAllWorkspaces();
  if (myToken !== docLoadToken) return;

  renderDocTitle(path, state.source.title, state.source.author);

  if (kind === "pdf") {
    const fit = await fitWidthScale(state.pdfDoc, viewerScroll.clientWidth - FIT_PADDING);
    if (myToken !== docLoadToken) return;
    const savedZoom = loadZoomForDoc();
    const initial = savedZoom != null ? savedZoom : fit;
    state.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, initial));
    viewerScroll.style.visibility = "hidden";
    try {
      await renderPages(state.pdfDoc, viewerContainer, state.scale);
      if (myToken !== docLoadToken) return;
      const overflow = viewerScroll.scrollWidth - viewerScroll.clientWidth;
      viewerScroll.scrollLeft = overflow > 0 ? overflow / 2 : 0;
      viewerScroll.scrollTop = 0;
    } finally {
      viewerScroll.style.visibility = "";
    }
  } else if (kind === "markdown" || kind === "text") {
    await FlowView.renderFlowDoc(viewerContainer, state.flowDoc.text, kind);
    if (myToken !== docLoadToken) return;
    state.flowZoom = loadZoomForDoc() ?? 1;
    applyFlowZoom();
    if (state.tool === "rect") setTool("select");
  } else if (kind === "docx") {
    await FlowView.renderFlowDoc(viewerContainer, state.flowDoc.bytes.buffer, kind);
    if (myToken !== docLoadToken) return;
    state.flowZoom = loadZoomForDoc() ?? 1;
    applyFlowZoom();
    if (state.tool === "rect") setTool("select");
  }
  updateZoomLabel();

  refreshActiveView();
  applyAllHighlights();
  syncHorizontalOverflow();
  await persist();
  // After a doc opens, see if a pending Marklee Permalink can resolve.
  if (pendingPermalink) setTimeout(() => resolvePendingPermalink(), 200);
}

// Per-document zoom persistence — keyed by content hash when available
// (stable across moves/renames), falls back to the file path.
function zoomKey() {
  const h = state.source?.contentHash;
  if (h) return `pdf-annotator-zoom:hash:${h.replace(/^sha256:/, "")}`;
  if (state.currentPdfPath) return `pdf-annotator-zoom:path:${state.currentPdfPath}`;
  return null;
}
function saveZoomForDoc(scale) {
  const k = zoomKey();
  if (!k) return;
  try { localStorage.setItem(k, String(scale)); } catch {}
}
function loadZoomForDoc() {
  const k = zoomKey();
  if (!k) return null;
  try {
    const v = localStorage.getItem(k);
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0.4 && n <= 5 ? n : null;
  } catch { return null; }
}

window.addEventListener("resize", () => syncHorizontalOverflow());

// Paste-as-snippet — ⌘V (or ⌃V) anywhere outside an editable field grabs
// clipboard text or image and creates a new snippet attached to the
// active document. Useful for quoting from other tools / pasting figures
// from screenshots without having to flip back to the source first.
document.addEventListener("paste", async (e) => {
  // Skip when the user is typing into an input/textarea — let the native
  // paste behavior win.
  const tag = (e.target?.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
  if (!state.workspace) return;
  const cd = e.clipboardData;
  if (!cd) {
    console.warn("[paste] no clipboardData on event");
    return;
  }
  console.log("[paste] received", { types: cd.types, items: [...(cd.items || [])].map((it) => `${it.kind}/${it.type}`) });

  // Image first — most clipboard images come from screenshots.
  for (const item of cd.items || []) {
    if (item.kind === "file" && item.type?.startsWith("image/")) {
      const blob = item.getAsFile();
      if (!blob) continue;
      e.preventDefault();
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await createPastedImageSnippet(bytes, item.type);
      } catch (err) {
        console.error("[paste] image failed", err);
      }
      return;
    }
  }
  // Text fallback. iPhone → Mac via Universal Clipboard sometimes only
  // exposes text/uri-list or text/html instead of text/plain, so try
  // multiple types in priority order before giving up.
  let text = (cd.getData("text/plain") || "").trim();
  if (!text) text = (cd.getData("text") || "").trim();
  if (!text) {
    const html = cd.getData("text/html") || "";
    if (html) {
      // Strip HTML tags + decode common entities for a plain-text fallback.
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      text = (tmp.textContent || tmp.innerText || "").trim();
    }
  }
  if (!text) text = (cd.getData("text/uri-list") || "").trim();
  if (!text) {
    console.warn("[paste] no usable text in clipboard. types:", cd.types);
    return;
  }
  e.preventDefault();
  await createPastedTextSnippet(text);
});

// Pasted snippet helpers (createPastedTextSnippet, createPastedImageSnippet,
// getClipboardDocPath, PASTED_PSEUDO_PATH) moved to src/clipboard.js
// in Wave 3 of the hardening roadmap. Imports at the top of this file.

async function revealInFinder(path) {
  if (!IS_TAURI) {
    console.warn("[reveal] only supported in Tauri build");
    return;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("reveal_in_finder", { path });
  } catch (err) {
    console.error("[reveal] failed", err);
    alert(`Couldn't open in Finder:\n${err}`);
  }
}

async function setScale(next) {
  const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
  if (!state.pdfDoc || Math.abs(clamped - state.scale) < 0.001) {
    state.scale = clamped;
    updateZoomLabel();
    saveZoomForDoc(clamped);
    return;
  }
  state.scale = clamped;
  updateZoomLabel();
  saveZoomForDoc(clamped);
  await renderPages(state.pdfDoc, viewerContainer, state.scale);
  applyAllHighlights();
  // PDF re-render replaces page-wraps; re-paint AI preview overlays.
  paintAiPreviews();
  syncHorizontalOverflow();
}

function syncHorizontalOverflow() {
  // Toggle horizontal scroll on viewer-scroll only when content actually
  // overflows. Tolerance of 8px so micro-rounding (panel resize gutters,
  // sub-pixel render math, scrollbar gutter shifts) doesn't trip a
  // cosmetic scrollbar at fit-width.
  requestAnimationFrame(() => {
    const overflowsX = viewerContainer.scrollWidth > viewerScroll.clientWidth + 8;
    viewerScroll.classList.toggle("zoomed-overflow", overflowsX);
  });
}

state.flowZoom = 1;
const FLOW_MIN_ZOOM = 0.5;
const FLOW_MAX_ZOOM = 3;

function applyFlowZoom() {
  const article = viewerContainer.querySelector(".flow-doc");
  if (!article) return;
  article.style.zoom = String(state.flowZoom);
  updateZoomLabel(state.flowZoom);
  saveZoomForDoc(state.flowZoom);
}

function adjustScrollAfterZoom(anchor, factor) {
  if (!anchor) return;
  viewerScroll.scrollLeft = anchor.docX * factor - anchor.cursorScrollX;
  viewerScroll.scrollTop = anchor.docY * factor - anchor.cursorScrollY;
}

let pinchAnchor = null;
let pinchPending = false;
let pinchAccumFactor = 1;
let pinchEndTimer = null;
let pdfPinchPreviewScale = 1;
let pdfPinchActive = false;
let pdfPinchSettleTimer = null;

function captureAnchor(e) {
  const sRect = viewerScroll.getBoundingClientRect();
  const cursorScrollX = e.clientX - sRect.left;
  const cursorScrollY = e.clientY - sRect.top;
  return {
    cursorScrollX,
    cursorScrollY,
    docX: viewerScroll.scrollLeft + cursorScrollX,
    docY: viewerScroll.scrollTop + cursorScrollY,
  };
}

viewerScroll.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  if (state.source.kind === "pdf" && state.pdfDoc) {
    handlePdfPinch(e);
  } else if (state.flowDoc && (state.source.kind === "markdown" || state.source.kind === "docx" || state.source.kind === "text")) {
    handleFlowPinch(e);
  }
}, { passive: false });

function handlePdfPinch(e) {
  e.preventDefault();
  if (!pdfPinchActive) {
    pdfPinchActive = true;
    pdfPinchPreviewScale = 1;
    pinchAnchor = captureAnchor(e);
    const cRect = viewerContainer.getBoundingClientRect();
    const ox = e.clientX - cRect.left;
    const oy = e.clientY - cRect.top;
    viewerContainer.style.transformOrigin = `${ox}px ${oy}px`;
    viewerContainer.style.willChange = "transform";
  }
  const factor = Math.exp(-e.deltaY * 0.012);
  const minPreview = MIN_SCALE / state.scale;
  const maxPreview = MAX_SCALE / state.scale;
  pdfPinchPreviewScale = Math.max(minPreview, Math.min(maxPreview, pdfPinchPreviewScale * factor));
  viewerContainer.style.transform = `scale(${pdfPinchPreviewScale})`;
  updateZoomLabel(state.scale * pdfPinchPreviewScale);

  clearTimeout(pdfPinchSettleTimer);
  pdfPinchSettleTimer = setTimeout(async () => {
    pdfPinchActive = false;
    const finalScale = state.scale * pdfPinchPreviewScale;
    const realFactor = pdfPinchPreviewScale;
    const anchor = pinchAnchor;
    pdfPinchPreviewScale = 1;
    viewerContainer.style.transform = "";
    viewerContainer.style.transformOrigin = "";
    viewerContainer.style.willChange = "";
    // Skip the expensive re-rasterize if the change is too small to
    // matter visually — the user can pinch again to commit. Threshold
    // is 5% relative to current scale.
    const ratio = finalScale / state.scale;
    if (Math.abs(ratio - 1) < 0.05) {
      pinchAnchor = null;
      updateZoomLabel();
      return;
    }
    await setScale(finalScale);
    adjustScrollAfterZoom(anchor, realFactor);
    pinchAnchor = null;
  }, 220);
}

function handleFlowPinch(e) {
  e.preventDefault();
  if (!pinchAnchor) pinchAnchor = captureAnchor(e);
  pinchAccumFactor *= Math.exp(-e.deltaY * 0.012);

  if (!pinchPending) {
    pinchPending = true;
    requestAnimationFrame(() => {
      pinchPending = false;
      const factor = pinchAccumFactor;
      pinchAccumFactor = 1;
      const oldZoom = state.flowZoom;
      const newZoom = Math.max(FLOW_MIN_ZOOM, Math.min(FLOW_MAX_ZOOM, oldZoom * factor));
      const realFactor = newZoom / oldZoom;
      state.flowZoom = newZoom;
      applyFlowZoom();
      if (pinchAnchor) {
        adjustScrollAfterZoom(pinchAnchor, realFactor);
        pinchAnchor.docX *= realFactor;
        pinchAnchor.docY *= realFactor;
      }
    });
  }

  clearTimeout(pinchEndTimer);
  pinchEndTimer = setTimeout(() => { pinchAnchor = null; }, 220);
}

async function fitWidth() {
  if (!state.pdfDoc) return;
  const next = await fitWidthScale(state.pdfDoc, viewerScroll.clientWidth - FIT_PADDING);
  await setScale(next);
}

function updateZoomLabel(overrideScale) {
  const s = typeof overrideScale === "number" ? overrideScale : state.scale;
  zoomLevelEl.textContent = `${Math.round(s * 100)}%`;
}

viewerContainer.addEventListener("mousedown", (e) => {
  if (e.detail >= 2) e.preventDefault();
  if (state.tool !== "rect") return;
  if (state.source.kind !== "pdf") return;
  const wrap = e.target.closest?.(".page-wrap");
  if (!wrap) return;
  // If the click landed on an existing highlight, skip the rubber-band
  // so the press-gesture handler below can pick it up for drag-to-group.
  if (hitTestHighlight(e)) return;
  e.preventDefault();
  const rect = wrap.getBoundingClientRect();
  const startX = e.clientX - rect.left;
  const startY = e.clientY - rect.top;
  const overlay = document.createElement("div");
  overlay.className = "rubber-band";
  overlay.style.left = `${startX}px`;
  overlay.style.top = `${startY}px`;
  wrap.appendChild(overlay);
  rectDraw = { wrap, startX, startY, overlay };
});

viewerContainer.addEventListener("mousemove", (e) => {
  if (!rectDraw) return;
  const rect = rectDraw.wrap.getBoundingClientRect();
  const curX = e.clientX - rect.left;
  const curY = e.clientY - rect.top;
  const x = Math.min(rectDraw.startX, curX);
  const y = Math.min(rectDraw.startY, curY);
  const w = Math.abs(curX - rectDraw.startX);
  const h = Math.abs(curY - rectDraw.startY);
  rectDraw.overlay.style.left = `${x}px`;
  rectDraw.overlay.style.top = `${y}px`;
  rectDraw.overlay.style.width = `${w}px`;
  rectDraw.overlay.style.height = `${h}px`;
});

window.addEventListener("mouseup", async (e) => {
  if (!rectDraw) return;
  const draw = rectDraw;
  rectDraw = null;
  const wrapRect = draw.wrap.getBoundingClientRect();
  const left = parseFloat(draw.overlay.style.left) || 0;
  const top = parseFloat(draw.overlay.style.top) || 0;
  const width = parseFloat(draw.overlay.style.width) || 0;
  const height = parseFloat(draw.overlay.style.height) || 0;
  draw.overlay.remove();
  if (width < 8 || height < 8) return;
  const fracRect = {
    left: left / wrapRect.width,
    top: top / wrapRect.height,
    width: width / wrapRect.width,
    height: height / wrapRect.height,
  };
  const page = parseInt(draw.wrap.dataset.page, 10);
  await createImageSnippet(page, fracRect);
});

async function createImageSnippet(page, fracRect) {
  if (!state.pdfDoc || !state.currentPdfPath) return;
  const id = crypto.randomUUID();
  let pngBytes;
  try {
    pngBytes = await renderRegionPng(state.pdfDoc, page, fracRect, 2);
  } catch (err) {
    console.error("clip render failed", err);
    return;
  }
  let imagePath;
  try {
    imagePath = await getStore().writeClip(state.currentPdfPath, id, pngBytes);
  } catch (err) {
    console.error("clip save failed", err);
    return;
  }
  const snippet = {
    id,
    kind: "image",
    page,
    text: `Region p.${page}`,
    rects: [fracRect],
    imagePath,
    comment: "",
    created: new Date().toISOString(),
  };
  state.snippets.push(snippet);
  undoStack.push({ type: "add", id });
  await persist();
  refreshActiveView();
  applyAllHighlights();
}

let hoverSnippetId = null;

viewerContainer.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (state.tool !== "select") return;
  const tl = e.target.closest?.(".textLayer");
  if (!tl) return;
  tl.classList.add("selecting");
});
window.addEventListener("mouseup", () => {
  viewerContainer.querySelectorAll(".textLayer.selecting").forEach((tl) => {
    tl.classList.remove("selecting");
  });
});

viewerContainer.addEventListener("mousemove", (e) => {
  const hit = hitTestHighlight(e);
  const id = hit ? hit.id : null;
  if (id !== hoverSnippetId) {
    hoverSnippetId = id;
    updateHoverClasses();
  }
  viewerContainer.style.cursor = id ? "grab" : "";
});

viewerContainer.addEventListener("mouseleave", () => {
  if (hoverSnippetId !== null) {
    hoverSnippetId = null;
    updateHoverClasses();
  }
});

viewerContainer.addEventListener("click", (e) => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  let snippetId = null;
  const flowMark = e.target.closest?.("mark.hl");
  if (flowMark) {
    snippetId = flowMark.dataset.snippetId;
  } else {
    const hit = hitTestHighlight(e);
    if (hit) snippetId = hit.id;
  }
  if (!snippetId) return;
  const li = snippetsListEl.querySelector(`[data-snippet-id="${snippetId}"]`);
  if (!li) return;
  li.scrollIntoView({ behavior: "smooth", block: "center" });
  const ta = li.querySelector("textarea");
  if (ta) setTimeout(() => ta.focus(), 250);
});

// Right-click / ctrl-click / cmd-click on a highlight in the viewer opens
// a small popover with "Delete highlight". Plain left-click still starts
// the press gesture for drag-to-group.
viewerContainer.addEventListener("contextmenu", (e) => {
  let snippetId = null;
  // Flow docs: hover the <mark.hl> element directly.
  const flowMark = e.target.closest?.("mark.hl");
  if (flowMark) snippetId = flowMark.dataset.snippetId;
  // PDF: hit-test against snippet rects.
  if (!snippetId && state.source.kind === "pdf") {
    const hit = hitTestHighlight(e);
    if (hit) snippetId = hit.id;
  }
  if (!snippetId) return; // no highlight under cursor → let the OS menu fire
  e.preventDefault();
  e.stopPropagation();
  openHighlightActionMenu(e.clientX, e.clientY, snippetId);
});

viewerContainer.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  // Modifier-clicks (⌘/⌃/⇧/⌥) bypass our press gesture so OS-native
  // gestures still work — ctrl-click → context menu on macOS,
  // ⇧-click → range-extend selection, etc.
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  // Flow doc: <mark.hl> elements still carry data-snippet-id
  const flowMark = e.target.closest?.("mark.hl");
  if (flowMark) {
    const id = flowMark.dataset.snippetId;
    if (!id) return;
    const snippet = state.snippets.find((x) => x.id === id);
    if (!snippet) return;
    e.stopPropagation();
    beginPressGesture(snippet, e, flowMark);
    return;
  }
  // PDF: hit-test JS-side against snippet rects. If we hit one, block
  // the default text-selection behavior and start the press gesture.
  // Otherwise let the textLayer receive mousedown for normal selection.
  if (state.source.kind !== "pdf") return;
  const hit = hitTestHighlight(e);
  if (!hit) return;
  e.preventDefault();
  e.stopPropagation();
  beginPressGesture(hit, e, e.target);
});

function beginPressGesture(snippet, downEvent, sourceEl) {
  const DRAG_THRESHOLD = 3;
  const HOLD_MS = 180;
  const startX = downEvent.clientX;
  const startY = downEvent.clientY;
  let opened = false;
  let lastEvent = downEvent;

  const cleanup = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    clearTimeout(holdTimer);
  };
  const open = (ev) => {
    if (opened) return;
    opened = true;
    cleanup();
    document.body.classList.add("dragging-snippet");
    sourceEl?.classList.add("dragging");
    ev?.preventDefault?.();
    openSnippetGroupOverlay(snippet, ev || lastEvent, false)
      .then((result) => applyGroupOverlayResult(snippet, result))
      .finally(() => {
        document.body.classList.remove("dragging-snippet");
        sourceEl?.classList.remove("dragging");
      });
  };
  const onMove = (ev) => {
    lastEvent = ev;
    if (opened) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    open(ev);
  };
  const onUp = () => cleanup();
  const holdTimer = setTimeout(() => open(lastEvent), HOLD_MS);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function hitTestHighlight(e) {
  const wrap = e.target.closest?.(".page-wrap");
  if (!wrap) return null;
  const page = parseInt(wrap.dataset.page, 10);
  const rect = wrap.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  for (const s of state.snippets) {
    if (s.page !== page) continue;
    for (const r of s.rects || []) {
      if (x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) {
        return s;
      }
    }
  }
  return null;
}

function updateHoverClasses() {
  // PDF mode: redraw highlight canvases for the affected pages
  setHoverSnippetId(hoverSnippetId);
  // Flow mode: <mark.hl> elements still get a hover class
  viewerContainer.querySelectorAll("mark.hl").forEach((el) => {
    el.classList.toggle("hover", el.dataset.snippetId === hoverSnippetId);
  });
  snippetsListEl.querySelectorAll(".snippet").forEach((li) => {
    li.classList.toggle("hover", li.dataset.snippetId === hoverSnippetId);
  });
  updateHoverConnector();
  if (hoverSnippetId) startConnectorLoop();
  else stopConnectorLoop();
}

// Hover-connector — single Bézier curve from the hovered snippet card to
// its highlight in the document (and vice versa). Single fixed SVG layered
// above both panes; recomputes on scroll/resize while hover is active.
function ensureConnectorSvg() {
  let svg = document.getElementById("hover-connector");
  if (svg) return svg;
  const NS = "http://www.w3.org/2000/svg";
  svg = document.createElementNS(NS, "svg");
  svg.id = "hover-connector";
  svg.classList.add("hover-connector");

  // Gradient that fades from "anchored at the document" to "absorbed into
  // the card." Direction is set per render via x1/x2 so the fade lines
  // up with the connector's actual span.
  const defs = document.createElementNS(NS, "defs");
  const grad = document.createElementNS(NS, "linearGradient");
  grad.setAttribute("id", "hover-conn-grad");
  grad.setAttribute("gradientUnits", "userSpaceOnUse");
  const stop1 = document.createElementNS(NS, "stop");
  stop1.setAttribute("offset", "0%");
  stop1.setAttribute("class", "hover-conn-stop-doc");
  const stop2 = document.createElementNS(NS, "stop");
  stop2.setAttribute("offset", "50%");
  stop2.setAttribute("class", "hover-conn-stop-mid");
  const stop3 = document.createElementNS(NS, "stop");
  stop3.setAttribute("offset", "100%");
  stop3.setAttribute("class", "hover-conn-stop-card");
  grad.append(stop1, stop2, stop3);
  defs.appendChild(grad);
  svg.appendChild(defs);

  // Bracket: vertical bar with small ticks at the right margin of the
  // viewer, sized to the highlight's vertical extent — like a "]" pulled
  // out into the gutter so the connector never crosses document text.
  const bracket = document.createElementNS(NS, "path");
  bracket.classList.add("hover-connector-bracket");
  bracket.setAttribute("fill", "none");
  // Three layers stacked for the main beam: wide soft halo (channel glow)
  // → mid stroke (the visible beam) → thin bright core (sharp center line).
  const halo = document.createElementNS(NS, "path");
  halo.classList.add("hover-connector-halo");
  halo.setAttribute("fill", "none");
  const beam = document.createElementNS(NS, "path");
  beam.classList.add("hover-connector-beam");
  beam.setAttribute("fill", "none");
  beam.setAttribute("stroke", "url(#hover-conn-grad)");
  const core = document.createElementNS(NS, "path");
  core.classList.add("hover-connector-path");
  core.setAttribute("fill", "none");
  svg.append(bracket, halo, beam, core);

  document.body.appendChild(svg);
  return svg;
}
// Highlight-action popover — opened by right-click / ctrl-click / cmd-click
// on a highlight in the viewer. Five common actions; matches the right
// pane's per-card affordances so users don't have to find the card first.
let _activeHighlightMenu = null;
function openHighlightActionMenu(clientX, clientY, snippetId) {
  closeHighlightActionMenu();
  const menu = document.createElement("div");
  menu.className = "highlight-action-menu";
  const snippet = state.snippets.find((s) => s.id === snippetId)
    || (state.workspace.pastedSnippets || []).find((s) => s.id === snippetId);

  const addItem = (label, fn, opts = {}) => {
    const b = document.createElement("button");
    b.className = "highlight-action-item" + (opts.destructive ? " destructive" : "");
    b.textContent = label;
    b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      closeHighlightActionMenu();
      try { await fn(); } catch (err) { console.error("[highlight-action]", label, err); }
    });
    menu.appendChild(b);
    return b;
  };
  const addSeparator = () => {
    const s = document.createElement("div");
    s.className = "highlight-action-sep";
    menu.appendChild(s);
  };

  addItem("Show in list", () => {
    const card = snippetsListEl.querySelector(`.snippet[data-snippet-id="${snippetId}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("flash");
    setTimeout(() => card.classList.remove("flash"), 900);
  });

  addItem("Edit comment", () => {
    const card = snippetsListEl.querySelector(`.snippet[data-snippet-id="${snippetId}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => {
      // Open the existing add-comment affordance if present, else focus textarea.
      const addBtn = card.querySelector(".add-comment-btn");
      if (addBtn) addBtn.click();
      const ta = card.querySelector("textarea");
      if (ta) ta.focus();
    }, 280);
  });

  addSeparator();

  addItem("Copy quote", async () => {
    if (!snippet) return;
    if (snippet.kind === "image" && snippet.imagePath) {
      const owner = snippet._imageOwnerPath || state.currentPdfPath;
      try { await getStore().copyImageToClipboard(owner, snippet.imagePath); } catch (e) { console.warn(e); }
    } else {
      await navigator.clipboard.writeText(snippet.text || "");
    }
  });

  addItem("Copy share link", async () => {
    if (!snippet) return;
    const url = buildPermalink(snippet, state.source, { includeText: true });
    await navigator.clipboard.writeText(url);
  });

  addSeparator();

  addItem("Delete highlight", async () => {
    await deleteSnippetById(snippetId);
  }, { destructive: true });

  document.body.appendChild(menu);
  // Position near cursor; clamp to viewport
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = clientX + 4;
  let top = clientY + 4;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = clientY - mh - 4;
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  _activeHighlightMenu = menu;
  // Use mousedown (not click) for outside dismissal — click events
  // after a right-click can fire on the original target and close the
  // menu prematurely. mousedown fires only on the *next* user press,
  // not on the release of the right-click that opened the menu.
  setTimeout(() => {
    document.addEventListener("mousedown", _onHighlightMenuOutside, true);
    document.addEventListener("keydown", _onHighlightMenuEsc, true);
  }, 0);
}
function closeHighlightActionMenu() {
  if (_activeHighlightMenu) { _activeHighlightMenu.remove(); _activeHighlightMenu = null; }
  document.removeEventListener("mousedown", _onHighlightMenuOutside, true);
  document.removeEventListener("keydown", _onHighlightMenuEsc, true);
}
function _onHighlightMenuOutside(e) {
  if (!_activeHighlightMenu) return;
  if (_activeHighlightMenu.contains(e.target)) return;
  closeHighlightActionMenu();
}
function _onHighlightMenuEsc(e) { if (e.key === "Escape") closeHighlightActionMenu(); }

async function deleteSnippetById(snippetId) {
  // Mirror the in-card delete handler: undoable via ⌘Z.
  const snippet = state.snippets.find((s) => s.id === snippetId);
  if (snippet) {
    const index = state.snippets.indexOf(snippet);
    state.snippets.splice(index, 1);
    undoStack.push({ type: "delete", snippet, index });
    if (snippet.kind === "image" && snippet.imagePath) {
      try { await getStore().deleteClip(state.currentPdfPath, snippet.imagePath); } catch {}
      const cacheKey = `${state.currentPdfPath}::${snippet.imagePath}`;
      const cached = clipUrlCache.get(cacheKey);
      if (cached) { URL.revokeObjectURL(cached); clipUrlCache.delete(cacheKey); }
    }
    await persist();
    refreshActiveView();
    applyAllHighlights();
    return;
  }
  // Pasted? (rare for highlights but handle it cleanly)
  const pasted = (state.workspace?.pastedSnippets || []).find((s) => s.id === snippetId);
  if (pasted) {
    const i = state.workspace.pastedSnippets.indexOf(pasted);
    state.workspace.pastedSnippets.splice(i, 1);
    undoStack.push({ type: "delete-pasted", snippet: pasted, index: i });
    saveAllWorkspaces();
    refreshActiveView();
  }
}

async function removeGroupFromSnippet(snippetId, groupId, ownerPath) {
  // Three storage homes for a snippet's groups:
  //   1. Pasted: state.workspace.pastedSnippets (workspace localStorage).
  //   2. Active doc: state.snippets (per-doc sidecar, written by persist).
  //   3. Cross-doc (workspace scope, viewing another file's snippets):
  //      sidecar belongs to that file; we'd need to load + write it.
  //      Skipped for now — open the doc to manage its groups.
  if (ownerPath === PASTED_PSEUDO_PATH) {
    const live = (state.workspace.pastedSnippets || []).find((x) => x.id === snippetId);
    if (!live) return;
    live.groups = (live.groups || []).filter((g) => g !== groupId);
    saveAllWorkspaces();
    refreshActiveView();
    applyAllHighlights();
    return;
  }
  if (ownerPath && ownerPath !== state.currentPdfPath) {
    // Cross-doc — would need to load that doc's sidecar, mutate, write back.
    // For now, just refuse and tell the user.
    console.warn("[group-remove] cross-doc edits not supported; open the doc to remove groups");
    return;
  }
  const live = state.snippets.find((x) => x.id === snippetId);
  if (!live) return;
  live.groups = (live.groups || []).filter((g) => g !== groupId);
  await persist();
  refreshActiveView();
  applyAllHighlights();
}

function hideHoverConnector() {
  const svg = document.getElementById("hover-connector");
  if (svg) {
    svg.classList.remove("active");
    // Distance-fade sets svg.style.opacity inline; clear it so the CSS
    // base rule (opacity: 0 when not .active) takes effect again.
    svg.style.opacity = "";
  }
}

// Direction indicators. Two arrows positioned at pane edges that appear
// when the related element is scrolled off-screen. Click → scrolls it
// back into view via existing preview/scrollIntoView paths.
function ensureDirIndicator(side) {
  const id = `dir-indicator-${side}`;
  let el = document.getElementById(id);
  if (el) return el;
  el = document.createElement("button");
  el.id = id;
  el.className = "dir-indicator";
  el.setAttribute("aria-label", side === "doc" ? "Scroll to highlight" : "Scroll to snippet");
  el.innerHTML = '<span class="dir-arrow"></span>';
  document.body.appendChild(el);
  return el;
}
function updateDirIndicator(side, rect, paneRect, visible, anchorRect, anchorEdge, onClick) {
  const el = ensureDirIndicator(side);
  if (visible) { el.classList.remove("active"); return; }
  let dir;
  if (rect.bottom <= paneRect.top) dir = "up";
  else if (rect.top >= paneRect.bottom) dir = "down";
  else { el.classList.remove("active"); return; }
  el.dataset.direction = dir;
  // Position next to the anchor (the user's attention focus), not the
  // off-screen target's pane. anchorEdge picks the side of the anchor
  // rect we sit against.
  let x, y;
  if (anchorEdge === "left") {
    x = anchorRect.left - 18;
  } else if (anchorEdge === "right") {
    x = anchorRect.right + 18;
  } else {
    x = (anchorRect.left + anchorRect.right) / 2;
  }
  y = anchorRect.top + anchorRect.height / 2;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.classList.add("active");
  el.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick?.();
  };
}
function hideDirIndicators() {
  for (const side of ["doc", "list"]) {
    const el = document.getElementById(`dir-indicator-${side}`);
    if (el) el.classList.remove("active");
  }
}
function highlightRectForSnippet(snippetId) {
  const fmark = viewerContainer.querySelector(`mark.hl[data-snippet-id="${snippetId}"]`);
  if (fmark) return fmark.getBoundingClientRect();
  const snippet = state.snippets.find((s) => s.id === snippetId);
  if (!snippet || !snippet.rects?.[0]) return null;
  const wrap = viewerContainer.querySelector(`.page-wrap[data-page="${snippet.page}"]`);
  if (!wrap) return null;
  const pageRect = wrap.getBoundingClientRect();
  const r = snippet.rects[0];
  return {
    left: pageRect.left + r.left * pageRect.width,
    top: pageRect.top + r.top * pageRect.height,
    right: pageRect.left + (r.left + r.width) * pageRect.width,
    bottom: pageRect.top + (r.top + r.height) * pageRect.height,
    width: r.width * pageRect.width,
    height: r.height * pageRect.height,
  };
}
function updateHoverConnector() {
  if (!hoverSnippetId) { hideHoverConnector(); hideDirIndicators(); return; }
  const card = snippetsListEl.querySelector(`.snippet[data-snippet-id="${hoverSnippetId}"]`);
  const hRect = highlightRectForSnippet(hoverSnippetId);
  if (!card || !hRect) { hideHoverConnector(); hideDirIndicators(); return; }
  const cardRect = card.getBoundingClientRect();
  const viewerVis = viewerScroll.getBoundingClientRect();
  const listVis = snippetsListEl.getBoundingClientRect();
  const hVisible =
    hRect.bottom > viewerVis.top && hRect.top < viewerVis.bottom &&
    hRect.right  > viewerVis.left && hRect.left < viewerVis.right;
  const cVisible =
    cardRect.bottom > listVis.top && cardRect.top < listVis.bottom &&
    cardRect.right  > listVis.left && cardRect.left < listVis.right;

  // Off-screen direction indicators — when an endpoint is scrolled out of
  // view, show a small clickable arrow near the *hovered* element pointing
  // toward where the off-screen target lives. Click scrolls the target
  // back into view.
  //
  // Placement:
  //   "doc" indicator (highlight off-screen) → next to the card on its
  //     left edge in the gutter. The user is looking at the card; the
  //     hint should be next to the card.
  //   "list" indicator (card off-screen) → next to the highlight on its
  //     right edge. The user is looking at the highlight.
  updateDirIndicator("doc", hRect, viewerVis, hVisible, cardRect, "left", () => {
    const snippet = state.snippets.find((s) => s.id === hoverSnippetId);
    if (snippet) previewSnippetInPdf(snippet);
  });
  updateDirIndicator("list", cardRect, listVis, cVisible, hRect, "right", () => {
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  if (!hVisible || !cVisible) { hideHoverConnector(); return; }

  // Pin the doc-side endpoint just outside the page's right edge — not
  // glued to the viewer pane edge. Use the rendered page-wrap (PDF) or the
  // flow-doc article (markdown/docx) right edge plus a comfortable offset
  // so the bracket sits in the page's natural margin gutter.
  let pageRight;
  const snippet = state.snippets.find((s) => s.id === hoverSnippetId)
    || (state.workspace.pastedSnippets || []).find((s) => s.id === hoverSnippetId);
  if (snippet && state.source.kind === "pdf") {
    const pageWrap = viewerContainer.querySelector(`.page-wrap[data-page="${snippet.page}"]`);
    if (pageWrap) pageRight = pageWrap.getBoundingClientRect().right;
  }
  if (pageRight == null) {
    const article = viewerContainer.querySelector(".flow-doc");
    if (article) pageRight = article.getBoundingClientRect().right;
  }
  if (pageRight == null) pageRight = viewerVis.right - 48; // fallback
  // 14px past the page edge — about 0.15" — keeps the bracket clearly
  // separated from text without sliding all the way to the pane edge.
  // Clamp inside the viewer's visible right edge with a 6px inset.
  // Sit ~4px inside the page edge so the bracket visually overlaps the
  // document — reads as anchored to the page, not floating in the
  // marginalia gutter. Clamp to the visible viewer right edge.
  const marginX = Math.min(pageRight - 4, viewerVis.right - 6);
  // Connector starts ~10px right of the bracket so the halo's blur
  // doesn't bleed back over the bracket / page surface.
  const x1 = marginX + 10;
  const y1 = hRect.top + hRect.height / 2;
  // Land on the card's left border (not its inner content) so the
  // connector reads as "this card" rather than "this paragraph".
  const x2 = cardRect.left;
  const y2 = cardRect.top + cardRect.height / 2;
  const cy1 = Math.max(viewerVis.top + 4, Math.min(viewerVis.bottom - 4, y1));
  const cy2 = Math.max(listVis.top + 4, Math.min(listVis.bottom - 4, y2));
  // Orthogonal elbow — H out, V across, H in. Thick stroke so it reads
  // as a deliberate highlighter pull rather than chrome.
  const midX = x1 + (x2 - x1) * 0.5;
  const path = `M ${x1} ${cy1} H ${midX} V ${cy2} H ${x2}`;
  // Highlighter swipe at the margin: a single thick vertical line spanning
  // the highlight extent. No `[` tick marks — just the bar itself, like a
  // marker stripe down the page edge.
  const bracketTop = Math.max(viewerVis.top + 4, hRect.top);
  const bracketBot = Math.min(viewerVis.bottom - 4, hRect.bottom);
  const bracketPath = bracketBot > bracketTop + 2
    ? `M ${marginX} ${bracketTop} L ${marginX} ${bracketBot}`
    : "";
  const svg = ensureConnectorSvg();
  svg.querySelector(".hover-connector-bracket").setAttribute("d", bracketPath);
  for (const p of svg.querySelectorAll(".hover-connector-halo, .hover-connector-beam, .hover-connector-path")) {
    p.setAttribute("d", path);
  }
  const grad = svg.querySelector("#hover-conn-grad");
  grad.setAttribute("x1", x1);
  grad.setAttribute("y1", cy1);
  grad.setAttribute("x2", x2);
  grad.setAttribute("y2", cy2);

  // Distance-based fade. When the highlight and card are within ~one
  // viewport's vertical span the connector is fully visible. Past that
  // it ramps down toward zero so the line doesn't insist on a far-away
  // connection.
  const verticalSpan = Math.abs(cy2 - cy1);
  const vh = window.innerHeight || 800;
  // 0..1 strength: 1 when very close, 0.3 at vh, 0 past 1.5×vh.
  let strength = 1;
  if (verticalSpan > vh * 0.5) {
    const t = Math.max(0, Math.min(1, (verticalSpan - vh * 0.5) / vh));
    strength = Math.max(0, 1 - t);
  }
  svg.style.opacity = strength.toFixed(3);
  // Past ~one viewport span, switch to dashed for the "elsewhere" hint.
  svg.classList.toggle("far", verticalSpan > vh * 0.6);
  svg.classList.add("active");
}
// While hover is active, run a per-frame loop that recomputes endpoint
// rects and redraws the connector path. Cheaper than wiring scroll
// listeners to every possible scrollable ancestor — any change in screen
// position gets picked up next frame regardless of source. Loop self-
// terminates when hover clears.
let _connectorRafHandle = 0;
function startConnectorLoop() {
  if (_connectorRafHandle) return;
  const tick = () => {
    if (!hoverSnippetId) {
      _connectorRafHandle = 0;
      return;
    }
    updateHoverConnector();
    _connectorRafHandle = requestAnimationFrame(tick);
  };
  _connectorRafHandle = requestAnimationFrame(tick);
}
function stopConnectorLoop() {
  if (_connectorRafHandle) {
    cancelAnimationFrame(_connectorRafHandle);
    _connectorRafHandle = 0;
  }
}

viewerContainer.addEventListener("mouseup", async () => {
  if (state.source.kind === "pdf") {
    const snip = getSelectionSnippet();
    if (!snip) return;
    snip.text = normalizeText(snip.text);
    if (!snip.text) return;
    if (state.snippets.some((s) => s.page === snip.page && s.text === snip.text)) {
      window.getSelection().removeAllRanges();
      return;
    }
    snip.id = crypto.randomUUID();
    snip.kind = "text";
    snip.comment = "";
    snip.created = new Date().toISOString();
    state.snippets.push(snip);
    undoStack.push({ type: "add", id: snip.id });
    await persist();
    refreshActiveView();
    applyAllHighlights();
    window.getSelection().removeAllRanges();
    return;
  }
  if (state.source.kind === "markdown" || state.source.kind === "docx" || state.source.kind === "text") {
    const cap = FlowView.getSelectionFlowSnippet(viewerContainer);
    if (!cap) return;
    const text = normalizeText(cap.text);
    if (!text) return;
    if (state.snippets.some((s) =>
      s.text === text &&
      (s.anchor || "") === (cap.anchor || "") &&
      (s.flowPos || 0) === (cap.flowPos || 0))) {
      window.getSelection().removeAllRanges();
      return;
    }
    const snip = {
      id: crypto.randomUUID(),
      page: 1,
      kind: "text",
      text,
      rects: [],
      comment: "",
      created: new Date().toISOString(),
      contextBefore: cap.contextBefore,
      contextAfter: cap.contextAfter,
      anchor: cap.anchor || null,
      textNormalized: cap.textNormalized,
      flowPos: cap.flowPos,
    };
    state.snippets.push(snip);
    undoStack.push({ type: "add", id: snip.id });
    await persist();
    refreshActiveView();
    applyAllHighlights();
    window.getSelection().removeAllRanges();
  }
});

function normalizeText(t) {
  return t
    .replace(/-\n(\w)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalGroupIds() {
  const usedInDoc = new Set();
  for (const s of state.snippets) for (const g of s.groups || []) usedInDoc.add(g);
  const seen = new Set();
  const list = [];
  for (const g of state.groupsMeta || []) {
    if (usedInDoc.has(g.id) && !seen.has(g.id)) {
      seen.add(g.id); list.push(g.id);
    }
  }
  for (const id of usedInDoc) {
    if (!seen.has(id)) { seen.add(id); list.push(id); }
  }
  return list;
}

async function renderSnippets() {
  // Preserve scroll position across rebuilds — the list is a flat re-render
  // every time, so without this the user gets bounced to the top after any
  // edit (delete, comment, group toggle, etc.).
  const savedScrollTop = snippetsListEl.scrollTop;
  snippetsListEl.innerHTML = "";
  const isWorkspace = state.mapScope === "workspace";
  let source;
  let edgeSource;
  if (isWorkspace) {
    const data = await loadWorkspaceMapData();
    source = data.snippets;
    edgeSource = data.edges || [];
  } else {
    // Doc scope: current doc's snippets + workspace-level pasted snippets so
    // a user who just pasted doesn't see "nothing happened".
    const pasted = (state.workspace?.pastedSnippets || []).map((s) =>
      ({ ...s, _pdfPath: PASTED_PSEUDO_PATH }));
    source = [...state.snippets, ...pasted];
    edgeSource = state.edges || [];
  }
  const rankScores = computeMarkRank(source, edgeSource);
  const rankPct = rankPercentiles(rankScores);
  const linkedIds = new Set();
  for (const e of edgeSource) { linkedIds.add(e.source); linkedIds.add(e.target); }
  // Filter out snippets whose ALL groups are hidden. Snippets with no groups
  // pass through. Snippets with at least one visible group pass through.
  const hiddenGroupIds = new Set((state.groupsMeta || []).filter((g) => g.hidden).map((g) => g.id));
  const passesGroupFilter = (s) => {
    const gs = s.groups || [];
    if (gs.length === 0) return true;
    return gs.some((gid) => !hiddenGroupIds.has(gid));
  };
  let ordered = orderedSnippets(source).filter(passesGroupFilter).filter(snippetMatchesLocal);
  if (state.snippetSort === "rank") {
    ordered = [...ordered].sort((a, b) => (rankScores.get(b.id) || 0) - (rankScores.get(a.id) || 0));
  }
  const canonical = canonicalGroupIds();
  updateLocalSearchCount(ordered.length);
  ordered.forEach((s) => {
    const li = document.createElement("li");
    li.className = "snippet";
    if (expandedIds.has(s.id)) li.classList.add("expanded");
    li.dataset.snippetId = s.id;
    const groups = s.groups || [];
    const ownerPath = s._pdfPath || state.currentPdfPath;

    if (groups.length > 0) {
      const sortedGroups = [...groups].sort(
        (a, b) => (canonical.indexOf(a) + 1 || 9999) - (canonical.indexOf(b) + 1 || 9999),
      );
      const chipRow = document.createElement("div");
      chipRow.className = "group-pill-row";
      for (const gid of sortedGroups) {
        const c = groupColor(gid);
        const pill = document.createElement("span");
        pill.className = "group-pill";
        pill.style.background = lightenColor(c);
        pill.style.borderColor = c;
        pill.style.color = darkenColor(c);
        pill.dataset.groupId = gid;
        const dot = document.createElement("span");
        dot.className = "group-pill-dot";
        dot.style.background = c;
        const name = document.createElement("span");
        name.className = "group-pill-name";
        name.textContent = groupName(gid);
        const x = document.createElement("button");
        x.className = "group-pill-x";
        x.textContent = "×";
        x.title = `Remove from "${groupName(gid)}"`;
        x.addEventListener("click", async (e) => {
          e.stopPropagation();
          await removeGroupFromSnippet(s.id, gid, ownerPath);
        });
        pill.append(dot, name, x);
        chipRow.appendChild(pill);
      }
      li.appendChild(chipRow);
    }
    // Show the cross-doc badge for any snippet not from the active document
    // — workspace scope shows other docs, doc scope shows pasted snippets.
    const isCrossDoc = ownerPath && ownerPath !== state.currentPdfPath;
    const meta = document.createElement("div");
    meta.className = "meta";
    const label = document.createElement("span");
    label.className = "meta-label";
    if (isCrossDoc) {
      const docSpan = document.createElement("span");
      docSpan.className = "meta-doc";
      docSpan.textContent = ownerPath === PASTED_PSEUDO_PATH
        ? "📋 Pasted"
        : (ownerPath.split("/").pop() || ownerPath);
      docSpan.title = ownerPath;
      label.appendChild(docSpan);
    }
    // Page / anchor label moved to a quiet bottom-right footer (see below);
    // skipped from meta row to save a row of vertical space.
    if (linkedIds.has(s.id)) {
      const score = rankScores.get(s.id) || 0;
      const pct = rankPct.get(s.id) || 0;
      const rankBadge = document.createElement("span");
      rankBadge.className = "rank-badge";
      const tier = pct >= 0.85 ? "high" : pct >= 0.6 ? "mid" : "low";
      rankBadge.dataset.tier = tier;
      rankBadge.textContent = "★ " + (score * 100).toFixed(1);
      rankBadge.title = `MarkRank: ${(score * 100).toFixed(2)} · ${Math.round(pct * 100)}th percentile`;
      label.appendChild(rankBadge);
    }
    const copy = document.createElement("button");
    copy.textContent = "copy";
    copy.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        if (s.kind === "image" && s.imagePath) {
          await getStore().copyImageToClipboard(s._imageOwnerPath || ownerPath, s.imagePath);
        } else {
          await navigator.clipboard.writeText(s.text);
        }
        const prev = copy.textContent;
        copy.textContent = "copied";
        setTimeout(() => { copy.textContent = prev; }, 900);
      } catch (err) {
        console.error("clipboard write failed", err);
      }
    });
    const del = document.createElement("button");
    del.textContent = "delete";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      // Pasted snippets live on the workspace, not on a doc's sidecar.
      if (ownerPath === PASTED_PSEUDO_PATH) {
        const arr = state.workspace.pastedSnippets || [];
        const i = arr.findIndex((x) => x.id === s.id);
        if (i < 0) return;
        const [removed] = arr.splice(i, 1);
        undoStack.push({ type: "delete-pasted", snippet: removed, index: i });
        if (removed.kind === "image" && removed.imagePath && removed._imageOwnerPath) {
          try { await getStore().deleteClip(removed._imageOwnerPath, removed.imagePath); } catch {}
          const cacheKey = `${removed._imageOwnerPath}::${removed.imagePath}`;
          const cached = clipUrlCache.get(cacheKey);
          if (cached) { URL.revokeObjectURL(cached); clipUrlCache.delete(cacheKey); }
        }
        saveAllWorkspaces();
        refreshActiveView();
        return;
      }
      const index = state.snippets.findIndex((x) => x.id === s.id);
      if (index < 0) return;
      const [removed] = state.snippets.splice(index, 1);
      undoStack.push({ type: "delete", snippet: removed, index });
      if (removed.kind === "image" && removed.imagePath) {
        try {
          await getStore().deleteClip(state.currentPdfPath, removed.imagePath);
        } catch {}
        const cacheKey = `${state.currentPdfPath}::${removed.imagePath}`;
        const cached = clipUrlCache.get(cacheKey);
        if (cached) { URL.revokeObjectURL(cached); clipUrlCache.delete(cacheKey); }
      }
      await persist();
      refreshActiveView();
      applyAllHighlights();
    });
    const share = document.createElement("button");
    share.textContent = "share";
    share.title = "Copy Marklee Permalink to clipboard (⇧ for privacy-min form)";
    share.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        const includeText = !e.shiftKey;
        const url = buildPermalink(s, state.source, { includeText });
        await navigator.clipboard.writeText(url);
        const prev = share.textContent;
        share.textContent = "copied";
        setTimeout(() => { share.textContent = prev; }, 1100);
      } catch (err) {
        console.error("permalink copy failed", err);
      }
    });
    const actions = document.createElement("span");
    actions.className = "actions";
    // Cross-doc snippets normally hide delete (you'd need the source doc
    // open to remove from its sidecar). Pasted snippets are an exception —
    // they live in the workspace, deletable from anywhere.
    if (isCrossDoc && ownerPath !== PASTED_PSEUDO_PATH) actions.append(share, copy);
    else actions.append(share, copy, del);
    meta.append(label, actions);

    let text;
    if (s.kind === "image") {
      text = document.createElement("div");
      text.className = "image";
      if (s.name) {
        const title = document.createElement("div");
        title.className = "clip-title";
        title.textContent = s.name;
        text.appendChild(title);
      }
      const img = document.createElement("img");
      img.alt = s.name || s.text || `clip p.${s.page}`;
      img.loading = "lazy";
      // Pasted image clips live at _imageOwnerPath, not the pseudo source.
      const clipOwnerPath = s._imageOwnerPath || ownerPath;
      loadClipUrl(s.imagePath, clipOwnerPath).then((url) => {
        if (url) img.src = url;
        else {
          text.classList.add("missing");
          text.replaceChildren(Object.assign(document.createElement("span"), {
            textContent: "(clip missing)",
            className: "missing-label",
          }));
        }
      });
      text.appendChild(img);
    } else {
      text = document.createElement("div");
      text.className = "text";
      if (s.name) {
        const title = document.createElement("div");
        title.className = "clip-title";
        title.textContent = s.name;
        text.appendChild(title);
        const quote = document.createElement("span");
        quote.className = "clip-quote";
        quote.textContent = s.text;
        text.appendChild(quote);
      } else {
        text.textContent = s.text;
      }
      text.title = "Click to jump to page · ⌥-click to expand/collapse";
      text.addEventListener("click", (e) => {
        if (e.altKey) {
          e.stopPropagation();
          if (expandedIds.has(s.id)) {
            expandedIds.delete(s.id);
            li.classList.remove("expanded");
          } else {
            expandedIds.add(s.id);
            li.classList.add("expanded");
          }
        }
      });
    }

    const ta = document.createElement("textarea");
    ta.placeholder = "type a comment…";
    ta.rows = 1;
    ta.value = s.comment || "";
    const autoresize = () => {
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
    };
    // Pasted snippets persist via saveAllWorkspaces (workspace-level
    // localStorage), everything else goes through persist (per-doc
    // sidecar). Pick the right writer for this snippet.
    const isPasted = ownerPath === PASTED_PSEUDO_PATH;
    const persistComment = () => {
      if (isPasted) {
        // s came from a spread copy in render; mutate the live workspace entry
        const live = (state.workspace.pastedSnippets || []).find((x) => x.id === s.id);
        if (live) live.comment = s.comment;
        saveAllWorkspaces();
      } else {
        persist();
      }
    };
    let saveTimer;
    ta.addEventListener("input", () => {
      s.comment = ta.value;
      autoresize();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persistComment, 300);
    });
    ta.addEventListener("focus", autoresize);
    setTimeout(autoresize, 0);

    const addBtn = document.createElement("button");
    addBtn.className = "add-comment-btn";
    addBtn.textContent = "+ comment";
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      addBtn.replaceWith(ta);
      ta.focus();
    });
    ta.addEventListener("blur", () => {
      if (!ta.value.trim()) {
        s.comment = "";
        ta.replaceWith(addBtn);
        clearTimeout(saveTimer);
        persistComment();
      }
    });

    const pageFooter = document.createElement("span");
    pageFooter.className = "snippet-page-footer";
    pageFooter.textContent = s.anchor ? `§ ${s.anchor}` : `p.${s.page}`;
    if (s.anchor) pageFooter.title = s.anchor;

    // Pasted snippets are nominally cross-doc but live on the workspace
    // and stay editable. Real cross-doc snippets (snippets from another
    // open file) keep the readonly comment treatment.
    if (isCrossDoc && ownerPath !== PASTED_PSEUDO_PATH) {
      const tail = s.comment
        ? Object.assign(document.createElement("div"), {
            className: "snippet-comment-readonly",
            textContent: s.comment,
          })
        : null;
      if (tail) li.append(meta, text, tail, pageFooter);
      else li.append(meta, text, pageFooter);
    } else {
      li.append(meta, text, s.comment ? ta : addBtn, pageFooter);
    }
    li.addEventListener("click", async (e) => {
      if (e.target === ta || e.target === del) return;
      // Pasted snippets aren't backed by a real file — clicking shouldn't
      // try to "open" the pseudo-source.
      if (ownerPath === PASTED_PSEUDO_PATH) return;
      if (isCrossDoc) {
        await loadPdf(ownerPath);
        setTimeout(() => previewSnippetInPdf(s), 60);
        return;
      }
      previewSnippetInPdf(s);
    });

    li.addEventListener("mouseenter", () => {
      hoverSnippetId = s.id;
      updateHoverClasses();
    });
    li.addEventListener("mouseleave", () => {
      hoverSnippetId = null;
      updateHoverClasses();
    });

    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      handleSnippetRightClick(s, e);
    });

    attachCardPressGesture(li, s);

    snippetsListEl.appendChild(li);
  });
  // Restore scroll position after the list rebuild. Clamp to the new
  // scrollable height in case the list shrank (e.g. delete + nothing
  // below to scroll to).
  const max = snippetsListEl.scrollHeight - snippetsListEl.clientHeight;
  snippetsListEl.scrollTop = Math.min(savedScrollTop, Math.max(0, max));
}

function attachCardPressGesture(li, snippet) {
  li.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("textarea, input, button, .group-pill, .group-pill-x")) return;
    beginPressGesture(snippet, e, li);
  });
}

function orderedSnippets(input) {
  const list = input || state.snippets;
  const posKey = (s) => {
    if (typeof s.flowPos === "number") {
      return [s._pdfPath || "", 0, s.flowPos, 0, 0];
    }
    return [s._pdfPath || "", 1, s.page, s.rects?.[0]?.top ?? 0, s.rects?.[0]?.left ?? 0];
  };
  return [...list].sort((a, b) => {
    const ka = posKey(a), kb = posKey(b);
    if (ka[0] !== kb[0]) return ka[0] < kb[0] ? -1 : 1;
    return ka[1] - kb[1] || ka[2] - kb[2] || ka[3] - kb[3] || ka[4] - kb[4];
  });
}

async function handleSnippetRightClick(s, e) {
  const result = await openSnippetGroupOverlay(s, e, false);
  await applyGroupOverlayResult(s, result);
}

function startSnippetDragOverlay(s, e) {
  openSnippetGroupOverlay(s, e, true).then((result) => {
    return applyGroupOverlayResult(s, result);
  });
}

function openSnippetGroupOverlay(s, e, dragMode) {
  const overlay = document.getElementById("group-overlay");
  const paneRect = { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
  return openGroupOverlay({
    snippet: s,
    allSnippets: state.snippets,
    allGroups: state.groupsMeta || [],
    container: overlay,
    anchor: { x: e.clientX, y: e.clientY },
    groupColor,
    groupName,
    paneRect,
    dragMode,
  });
}

async function applyGroupOverlayResult(s, result) {
  if (!result) return;
  const ownerPath = s._pdfPath || state.currentPdfPath;
  const isRemote = ownerPath && ownerPath !== state.currentPdfPath;
  let createdGroupId = null;
  let targetGroupId = null;
  if (result.kind === "new") {
    targetGroupId = crypto.randomUUID();
    ensureGroupMeta(targetGroupId, "");
    createdGroupId = targetGroupId;
  } else if (result.kind === "existing") {
    targetGroupId = result.groupId;
  }
  if (!targetGroupId) return;
  if (isRemote) {
    await addSnippetToGroupRemote(ownerPath, s.id, targetGroupId);
  } else {
    s.groups = s.groups || [];
    if (!s.groups.includes(targetGroupId)) s.groups.push(targetGroupId);
    await persist();
    refreshActiveView();
    applyAllHighlights();
  }
  if (createdGroupId) {
    promptGroupName(createdGroupId);
  }
}

function promptGroupName(groupId) {
  // The Groups panel is always visible at the bottom of #snippets-pane,
  // so we don't switch view — just focus the new group's name input.
  setTimeout(() => {
    const input = document.querySelector(`#groups-list [data-group-id="${groupId}"] input`);
    if (!input) return;
    input.focus();
    input.select();
    input.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, 60);
}

async function linkSnippets(srcId, dstId) {
  const src = state.snippets.find((x) => x.id === srcId);
  const dst = state.snippets.find((x) => x.id === dstId);
  if (!src || !dst) return;
  src.groups = src.groups || [];
  dst.groups = dst.groups || [];
  const shared = dst.groups.find((g) => src.groups.includes(g));
  let groupId;
  if (shared) {
    groupId = shared;
  } else if (dst.groups.length > 0) {
    groupId = dst.groups[0];
  } else if (src.groups.length > 0) {
    groupId = src.groups[0];
  } else {
    groupId = crypto.randomUUID();
  }
  if (!src.groups.includes(groupId)) src.groups.push(groupId);
  if (!dst.groups.includes(groupId)) dst.groups.push(groupId);
  await persist();
  refreshActiveView();
  applyAllHighlights();
}

async function loadClipUrl(path, pdfPath) {
  const owner = pdfPath || state.currentPdfPath;
  if (!path || !owner) return null;
  const cacheKey = `${owner}::${path}`;
  if (clipUrlCache.has(cacheKey)) return clipUrlCache.get(cacheKey);
  try {
    const bytes = await getStore().readClip(owner, path);
    const blob = new Blob([bytes], { type: "image/png" });
    const url = URL.createObjectURL(blob);
    clipUrlCache.set(cacheKey, url);
    return url;
  } catch (err) {
    console.warn("clip not found:", path);
    return null;
  }
}

function readPaletteColor(slot) {
  const styles = getComputedStyle(document.body);
  const v = styles.getPropertyValue(`--group-palette-${slot + 1}`).trim();
  return v || "#888888";
}
function nextPaletteIndex() {
  // Pick the slot least-used by existing groups (round-robin avoiding
  // collisions with already-assigned colors when possible).
  const used = new Map();
  for (let i = 0; i < GROUP_PALETTE_SLOTS; i++) used.set(i, 0);
  for (const g of state.groupsMeta || []) {
    if (typeof g.paletteSlot === "number" && used.has(g.paletteSlot)) {
      used.set(g.paletteSlot, used.get(g.paletteSlot) + 1);
    }
  }
  let best = 0;
  let bestCount = Infinity;
  for (let i = 0; i < GROUP_PALETTE_SLOTS; i++) {
    if (used.get(i) < bestCount) { best = i; bestCount = used.get(i); }
  }
  return best;
}
function defaultGroupColor(id) {
  // Look up the group's assigned palette slot; fall back to deterministic
  // hash-based slot if it has no slot recorded yet.
  const meta = (state.groupsMeta || []).find((g) => g.id === id);
  if (meta && typeof meta.paletteSlot === "number") {
    return readPaletteColor(meta.paletteSlot);
  }
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return readPaletteColor(h % GROUP_PALETTE_SLOTS);
}

function hslToHex(hsl) {
  const m = /hsl\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)%[\s,]+(\d+(?:\.\d+)?)%\s*\)/.exec(hsl);
  if (!m) return "#888888";
  const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function groupColor(id) {
  const meta = (state.groupsMeta || []).find((g) => g.id === id);
  if (meta?.color) return meta.color;
  return defaultGroupColor(id);
}

function groupColorHex(id) {
  const c = groupColor(id);
  return c.startsWith("#") ? c : hslToHex(c);
}

async function setGroupColor(id, color) {
  ensureGroupMeta(id, "");
  const meta = state.groupsMeta.find((g) => g.id === id);
  if (meta) meta.color = color;
  await persist();
  refreshActiveView();
  applyAllHighlights();
  if (mapInitialized) {
    const data = await getMapData();
    MapView.renderMap(data.snippets, data.edges, state.layout, loadClipUrl);
  }
}

async function setGroupPaletteSlot(id, slot) {
  ensureGroupMeta(id, "");
  const meta = state.groupsMeta.find((g) => g.id === id);
  if (!meta) return;
  meta.paletteSlot = slot;
  delete meta.color; // palette slot wins; clear any custom color override
  await persist();
  refreshActiveView();
  applyAllHighlights();
  if (mapInitialized) {
    const data = await getMapData();
    MapView.renderMap(data.snippets, data.edges, state.layout, loadClipUrl);
  }
  try { LineageView.applyTheme(); } catch {}
}

async function setGroupHidden(id, hidden) {
  ensureGroupMeta(id, "");
  const meta = state.groupsMeta.find((g) => g.id === id);
  if (meta) meta.hidden = hidden;
  await persist();
  renderGroups();
  refreshActiveView();
  applyAllHighlights();
}

function lightenColor(c) {
  let m = /hsl\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)%[\s,]+(\d+(?:\.\d+)?)%\s*\)/.exec(c);
  if (m) {
    const h = +m[1];
    const s = Math.min(70, +m[2]);
    return `hsl(${h}, ${s}%, 90%)`;
  }
  m = /^#([0-9a-fA-F]{3,6})$/.exec(c);
  if (m) {
    let hex = m[1];
    if (hex.length === 3) hex = hex.split("").map((x) => x + x).join("");
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h, s;
    if (max === min) { h = 0; s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return `hsl(${Math.round(h)}, ${Math.min(70, Math.round(s * 100))}%, 90%)`;
  }
  return c;
}

function darkenColor(c) {
  let m = /hsl\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)%[\s,]+(\d+(?:\.\d+)?)%\s*\)/.exec(c);
  if (m) {
    const h = +m[1];
    const s = +m[2];
    return `hsl(${h}, ${Math.min(80, s + 5)}%, 32%)`;
  }
  return c;
}

function previewSnippetInPdf(s) {
  if (state.source.kind === "markdown" || state.source.kind === "docx" || state.source.kind === "text") {
    FlowView.previewFlowSnippet(viewerContainer, s);
    return;
  }
  const wrap = viewerContainer.querySelector(`.page-wrap[data-page="${s.page}"]`);
  if (!wrap) return;
  ensurePageRendered?.(s.page);
  // Center on the highlight rect rather than the whole page-wrap, so a
  // snippet at the top of a long page doesn't get pushed out of view by
  // scrollIntoView({ block: "center" })'s page-centering behavior.
  // Use ~25% from the top as the parking position so the highlight has
  // both UI-clearance above and reading context below.
  const rect = (s.rects || [])[0];
  if (rect) {
    const scrollRect = viewerScroll.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const wrapTopInScroll = wrapRect.top - scrollRect.top + viewerScroll.scrollTop;
    const highlightY = wrapTopInScroll + rect.top * wrap.offsetHeight;
    const target = Math.max(0, highlightY - scrollRect.height * 0.25);
    viewerScroll.scrollTo({ top: target, behavior: "smooth" });
  } else {
    wrap.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  pulseSnippet(s.id);
}

function applyAllHighlights() {
  // Filter out snippets whose groups are all hidden so highlights match
  // what's visible in the snippets list.
  const hidden = new Set((state.groupsMeta || []).filter((g) => g.hidden).map((g) => g.id));
  const visible = state.snippets.filter((s) => {
    const gs = s.groups || [];
    if (gs.length === 0) return true;
    return gs.some((gid) => !hidden.has(gid));
  });
  if (state.source.kind === "pdf") {
    applyHighlights(viewerContainer, visible);
  } else if (state.source.kind === "markdown" || state.source.kind === "docx" || state.source.kind === "text") {
    FlowView.applyFlowHighlights(viewerContainer, visible);
  }
}

// `persist()` is debounced — multiple rapid edits coalesce into one
// sidecar write 200ms after the last call. Awaiting it returns a promise
// that resolves after the next flush completes (or rejects on error).
// Use `flushPersist()` to bypass the debounce, e.g. before close.
// Persistence pipeline (persist, flushPersist, persistImmediate,
// pruneOrphanGroups, beforeunload flush, mtime-conflict handler) moved
// to src/persistence.js in Wave 3. Imports at the top of this file.

function groupName(id) {
  const meta = (state.groupsMeta || []).find((g) => g.id === id);
  if (meta && meta.name) return meta.name;
  const idx = (state.groupsMeta || []).findIndex((g) => g.id === id);
  return idx >= 0 ? `Group ${idx + 1}` : "Group";
}

function ensureGroupMeta(id, name = "") {
  state.groupsMeta = state.groupsMeta || [];
  if (!state.groupsMeta.find((g) => g.id === id)) {
    const paletteSlot = nextPaletteIndex();
    state.groupsMeta.push({ id, name, paletteSlot });
  }
}

async function renameGroup(id, name) {
  ensureGroupMeta(id, name);
  const meta = state.groupsMeta.find((g) => g.id === id);
  if (meta) meta.name = name;
  await persist();
}

async function deleteGroup(id) {
  state.snippets.forEach((s) => {
    s.groups = (s.groups || []).filter((g) => g !== id);
  });
  state.groupsMeta = (state.groupsMeta || []).filter((g) => g.id !== id);
  await persist();
  refreshActiveView();
  applyAllHighlights();
}

function switchView(view) {
  if (view !== "list" && view !== "map" && view !== "lineage") view = "list";
  state.view = view;
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
  });
  const isMap = view === "map";
  const isList = view === "list";
  const isLineage = view === "lineage";
  document.getElementById("snippets-list").hidden = !isList;
  document.getElementById("map-view").hidden = !isMap;
  document.getElementById("lineage-view").hidden = !isLineage;
  document.getElementById("map-scope").hidden = false;
  // Keep the collapsible section title in sync with the active view so
  // the heading row reads naturally as the user tabs between modes.
  const titleEl = document.getElementById("snippets-section-title");
  if (titleEl) {
    titleEl.textContent = isMap ? "Map" : isLineage ? "Lineage" : "Snippets";
  }
  if (isMap) {
    requestAnimationFrame(async () => {
      if (!mapInitialized) {
        MapView.initMap(document.getElementById("cy"), {
          onChange: persist,
          onSelectEdge: handleEdgeSelection,
          groupName,
        });
        mapInitialized = true;
      }
      MapView.resize();
      const data = await getMapData();
      MapView.renderMap(data.snippets, data.edges, state.layout, loadClipUrl);
    });
  } else if (isLineage) {
    requestAnimationFrame(async () => {
      if (!lineageInitialized) {
        LineageView.initLineage(document.getElementById("lineage-cy"), {
          onSnippetClick: async (snippetId, pdfPath) => {
            if (pdfPath && pdfPath !== state.currentPdfPath) {
              await loadPdf(pdfPath);
            }
            const s = state.snippets.find((x) => x.id === snippetId);
            if (s) previewSnippetInPdf(s);
          },
          onDocClick: async (pdfPath) => {
            if (pdfPath && pdfPath !== state.currentPdfPath) await loadPdf(pdfPath);
          },
          groupName,
          groupColor,
        });
        lineageInitialized = true;
      }
      LineageView.resize();
      const data = await getLineageData();
      await LineageView.renderLineage(data.snippets, state.groupsMeta || [], loadClipUrl);
      applyLineageFilter();
    });
  } else {
    renderSnippets();
  }
}

async function refreshActiveView() {
  if (state.view === "map" && mapInitialized) {
    const data = await getMapData();
    MapView.renderMap(data.snippets, data.edges, state.layout, loadClipUrl);
  } else if (state.view === "lineage" && lineageInitialized) {
    const data = await getLineageData();
    await LineageView.renderLineage(data.snippets, state.groupsMeta || [], loadClipUrl);
    applyLineageFilter();
  } else {
    await renderSnippets();
  }
  renderGroups();
  renderClipped();
}

function applyLineageFilter() {
  const input = document.getElementById("lineage-search-input");
  const counter = document.getElementById("lineage-search-count");
  if (!input || !lineageInitialized) return;
  const { matchCount, error } = LineageView.applyFilter(input.value);
  input.classList.toggle("invalid", !!error);
  if (error) {
    counter.textContent = "bad regex";
  } else if (!input.value.trim()) {
    counter.textContent = "";
  } else {
    counter.textContent = `${matchCount} match${matchCount === 1 ? "" : "es"}`;
  }
}

(() => {
  const input = document.getElementById("lineage-search-input");
  const clearBtn = document.getElementById("lineage-search-clear");
  if (!input) return;
  let debounce = null;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(applyLineageFilter, 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      applyLineageFilter();
      input.blur();
    }
  });
  clearBtn?.addEventListener("click", () => {
    input.value = "";
    applyLineageFilter();
    input.focus();
  });
})();

async function getLineageData() {
  if (state.mapScope === "workspace") return await loadWorkspaceMapData();
  const taggedSnippets = state.snippets.map((s) => ({
    ...s,
    _pdfPath: s._pdfPath || state.currentPdfPath || "(untitled)",
  }));
  return { snippets: taggedSnippets, edges: state.edges };
}

async function getMapData() {
  if (state.mapScope === "workspace") return await loadWorkspaceMapData();
  return { snippets: state.snippets, edges: state.edges };
}

async function loadWorkspaceMapData() {
  // Parallelize folder listings — sequential listings dominate workspace
  // load time when the user has many folders.
  await Promise.all((state.workspace.folders || []).map(async (folder) => {
    try {
      const docs = await getStore().listDocuments(folder.path);
      folder.pdfs = docs.map((d) => d.path);
    } catch {}
  }));
  const folderPdfs = (state.workspace.folders || []).flatMap((f) => f.pdfs || []);
  const allPaths = [...new Set([...(state.workspace.files || []), ...folderPdfs])];
  // Workspace-level collections live on the active workspace (per SPEC §3.9).
  // Read once up-front so every return shape includes the same key.
  const collections = (state.workspace?.collections || []).map((c) => ({ ...c }));
  if (allPaths.length === 0) {
    return state.currentPdfPath
      ? {
          snippets: state.snippets.map((s) => ({ ...s, _pdfPath: state.currentPdfPath })),
          edges: state.edges,
          groups: (state.groupsMeta || []).map((g) => ({ ...g })),
          collections,
        }
      : { snippets: [], edges: [], groups: [], collections };
  }
  const results = await Promise.all(
    allPaths.map((p) => getStore().readAnnot(p).catch(() => null)),
  );
  const snippets = [];
  const edges = [];
  // Union groups across every member sidecar, deduping by id. Later
  // sidecars don't overwrite earlier metadata — first writer wins for a
  // given group id (matches the in-memory copy a user sees when that
  // doc is the one currently open).
  const groupsById = new Map();
  for (let i = 0; i < allPaths.length; i++) {
    const r = results[i];
    if (!r) continue;
    for (const s of r.snippets || []) {
      snippets.push({ ...s, _pdfPath: allPaths[i] });
    }
    for (const e of r.edges || []) edges.push(e);
    for (const g of r.groups || []) {
      if (g.id && !groupsById.has(g.id)) groupsById.set(g.id, { ...g });
    }
  }
  if (state.currentPdfPath && !allPaths.includes(state.currentPdfPath)) {
    for (const s of state.snippets) snippets.push({ ...s, _pdfPath: state.currentPdfPath });
    edges.push(...state.edges);
    for (const g of state.groupsMeta || []) {
      if (g.id && !groupsById.has(g.id)) groupsById.set(g.id, { ...g });
    }
  }
  // Workspace-level pasted snippets — virtual source so they appear under
  // their own umbrella in the lineage view + summary + workspace search.
  for (const s of state.workspace?.pastedSnippets || []) {
    snippets.push({ ...s, _pdfPath: PASTED_PSEUDO_PATH });
  }
  return { snippets, edges, groups: [...groupsById.values()], collections };
}

async function openGlobalSearch() {
  const modal = document.getElementById("global-search");
  modal.hidden = false;
  const input = document.getElementById("global-search-input");
  input.value = "";
  document.getElementById("search-results").innerHTML = "";
  document.getElementById("global-search-count").textContent = "";
  renderSearchGroups();
  setTimeout(() => { input.focus(); }, 30);
}

function closeGlobalSearch() {
  document.getElementById("global-search").hidden = true;
}

document.getElementById("global-search-close").addEventListener("click", closeGlobalSearch);
document.querySelector("#global-search .modal-backdrop").addEventListener("click", closeGlobalSearch);

let globalSearchTimer = null;
document.getElementById("global-search-input").addEventListener("input", (e) => {
  const q = e.target.value;
  clearTimeout(globalSearchTimer);
  globalSearchTimer = setTimeout(() => runGlobalSearch(q), 120);
});

async function runGlobalSearch(query) {
  const list = document.getElementById("search-results");
  const counter = document.getElementById("global-search-count");
  if (!query || query.trim().length < 1) {
    list.innerHTML = "";
    counter.textContent = "";
    return;
  }
  const data = await loadWorkspaceMapData();
  const ql = query.toLowerCase();
  const matches = (data.snippets || []).filter((s) => {
    return (s.text || "").toLowerCase().includes(ql) ||
           (s.comment || "").toLowerCase().includes(ql);
  });
  counter.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
  renderSearchResults(matches, query);
}

function renderSearchResults(matches, query) {
  const list = document.getElementById("search-results");
  list.innerHTML = "";
  if (matches.length === 0) {
    const empty = document.createElement("li");
    empty.className = "search-empty";
    empty.textContent = "No matches.";
    list.appendChild(empty);
    return;
  }
  for (const s of matches.slice(0, 200)) {
    const li = document.createElement("li");
    li.className = "search-result";
    li.draggable = true;
    li.dataset.snippetId = s.id;
    li.dataset.pdfPath = s._pdfPath || state.currentPdfPath || "";
    const filename = (li.dataset.pdfPath || "").split("/").pop() || "?";

    const meta = document.createElement("div");
    meta.className = "search-result-meta";
    const fileSpan = document.createElement("span");
    fileSpan.className = "search-result-file";
    fileSpan.textContent = filename;
    const pageSpan = document.createElement("span");
    pageSpan.className = "search-result-page";
    pageSpan.textContent = s.anchor ? `§ ${s.anchor}` : `p.${s.page}`;
    meta.append(fileSpan, pageSpan);

    const text = document.createElement("div");
    text.className = "search-result-text";
    text.innerHTML = highlightExcerpt(s.text || "", query, 140);

    li.append(meta, text);
    if (s.comment) {
      const c = document.createElement("div");
      c.className = "search-result-comment";
      c.innerHTML = highlightExcerpt(s.comment, query, 100);
      li.appendChild(c);
    }

    li.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(
        "application/x-snippet",
        JSON.stringify({ snippetId: s.id, pdfPath: li.dataset.pdfPath }),
      );
      e.dataTransfer.effectAllowed = "link";
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => li.classList.remove("dragging"));

    list.appendChild(li);
  }
}

function highlightExcerpt(text, query, maxLen) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return escapeHtmlString(text.slice(0, maxLen));
  const before = Math.max(0, idx - 30);
  const after = Math.min(text.length, idx + query.length + (maxLen - 30 - query.length));
  const prefix = before > 0 ? "…" : "";
  const suffix = after < text.length ? "…" : "";
  return prefix +
    escapeHtmlString(text.slice(before, idx)) +
    "<mark>" + escapeHtmlString(text.slice(idx, idx + query.length)) + "</mark>" +
    escapeHtmlString(text.slice(idx + query.length, after)) +
    suffix;
}

function escapeHtmlString(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function renderSearchGroups() {
  const list = document.getElementById("search-groups-list");
  list.innerHTML = "";
  const groups = state.groupsMeta || [];
  if (groups.length === 0) {
    const empty = document.createElement("li");
    empty.className = "search-groups-empty";
    empty.textContent = "no groups yet";
    list.appendChild(empty);
    return;
  }
  for (const g of groups) {
    const li = document.createElement("li");
    li.className = "search-group";
    li.dataset.groupId = g.id;
    const dot = document.createElement("span");
    dot.className = "search-group-dot";
    dot.style.background = groupColor(g.id);
    const name = document.createElement("span");
    name.className = "search-group-name";
    name.textContent = groupName(g.id);
    li.append(dot, name);
    li.addEventListener("dragover", (e) => {
      if (e.dataTransfer.types.includes("application/x-snippet")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "link";
        li.classList.add("drop-target");
      }
    });
    li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
    li.addEventListener("drop", async (e) => {
      e.preventDefault();
      li.classList.remove("drop-target");
      const raw = e.dataTransfer.getData("application/x-snippet");
      if (!raw) return;
      const data = JSON.parse(raw);
      await addSnippetToGroupRemote(data.pdfPath, data.snippetId, g.id);
      flashElement(li);
    });
    list.appendChild(li);
  }
}

async function addSnippetToGroupRemote(pdfPath, snippetId, groupId) {
  if (!pdfPath) return;
  try {
    const af = await getStore().readAnnot(pdfPath);
    const snippet = (af.snippets || []).find((s) => s.id === snippetId);
    if (!snippet) return;
    snippet.groups = snippet.groups || [];
    if (!snippet.groups.includes(groupId)) snippet.groups.push(groupId);
    await getStore().writeAnnot(pdfPath, af);
    if (pdfPath === state.currentPdfPath) {
      const local = state.snippets.find((s) => s.id === snippetId);
      if (local) {
        local.groups = local.groups || [];
        if (!local.groups.includes(groupId)) local.groups.push(groupId);
      }
      refreshActiveView();
      applyAllHighlights();
    }
  } catch (err) {
    console.error("addSnippetToGroupRemote failed", err);
  }
}

function flashElement(el) {
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 400);
}

async function setMapScope(scope) {
  if (scope === state.mapScope) return;
  state.mapScope = scope;
  document.querySelectorAll("#map-scope .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.scope === scope);
  });
  await refreshActiveView();
  // Footer panel mirrors the scope toggle — "Groups" in doc mode,
  // "Workspace" (groups union + collections) in workspace mode.
  renderGroups();
}

function renderGroups() {
  const list = document.getElementById("groups-list");
  list.innerHTML = "";
  const titleEl = document.getElementById("groups-panel-title");
  if (state.mapScope === "workspace") {
    if (titleEl) titleEl.textContent = "Workspace";
    renderWorkspaceGroupsPanel(list);
    return;
  }
  if (titleEl) titleEl.textContent = "Groups";
  renderDocGroupRows(list, state.groupsMeta || [], state.snippets || [], { editable: true });
}

// Doc-scope (and workspace-scope groups subsection) row builder. Pulled
// out so the workspace view can reuse the same row chrome with editing
// disabled (workspace mode shows groups as a read-only union — edits
// would have to fan out to many sidecars, which is out of scope here).
function renderDocGroupRows(list, groupsMeta, snippets, opts = {}) {
  const editable = opts.editable !== false;
  const counts = new Map();
  for (const s of snippets) for (const g of s.groups || []) counts.set(g, (counts.get(g) || 0) + 1);
  const ids = groupsMeta.map((g) => g.id);
  for (const cid of counts.keys()) if (!ids.includes(cid)) ids.push(cid);
  if (ids.length === 0) {
    const empty = document.createElement("li");
    empty.className = "groups-empty";
    empty.textContent = editable
      ? "No groups yet — right-click a snippet to start grouping."
      : "No groups in this workspace yet.";
    list.appendChild(empty);
    return;
  }
  for (const id of ids) {
    const meta = groupsMeta.find((g) => g.id === id) || { id, name: "" };
    const li = document.createElement("li");
    li.className = "group-row";
    li.dataset.groupId = id;
    const memberCount = counts.get(id) || 0;
    if (memberCount === 0) li.classList.add("empty");
    if (meta.hidden) li.classList.add("bubble-hidden");

    if (editable) {
      li.addEventListener("dragover", (e) => {
        if (!e.dataTransfer.types.includes("text/plain")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "link";
        li.classList.add("drop-target");
      });
      li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
      li.addEventListener("drop", async (e) => {
        e.preventDefault();
        li.classList.remove("drop-target");
        const snippetId = e.dataTransfer.getData("text/plain");
        if (!snippetId) return;
        const snippet = state.snippets.find((x) => x.id === snippetId);
        if (!snippet) return;
        snippet.groups = snippet.groups || [];
        if (!snippet.groups.includes(id)) snippet.groups.push(id);
        await persist();
        refreshActiveView();
        applyAllHighlights();
      });
    }

    const sticker = document.createElement("button");
    sticker.type = "button";
    sticker.className = "group-row-sticker";
    sticker.title = editable
      ? "Click to recolor · drag onto a snippet to tag it"
      : "Workspace-scope view — switch to this doc to edit";
    // In doc mode groupColorHex reads state.groupsMeta; in workspace mode
    // the row meta came from a different sidecar, so prefer its own color
    // field. Falls back to the hashed default when neither is set.
    const colorRaw = meta.color
      || (state.groupsMeta?.find((g) => g.id === id)?.color)
      || defaultGroupColor(id);
    const colorHex = colorRaw.startsWith("#") ? colorRaw : hslToHex(colorRaw);
    sticker.style.setProperty("--g", colorHex);
    if (editable) {
      sticker.addEventListener("pointerdown", (e) => {
        maybeBeginStickerDrag(e, id, meta, () => openColorPopover(sticker, id));
      });
    }

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = `Group ${ids.indexOf(id) + 1}`;
    input.value = meta.name || "";
    if (!editable) input.readOnly = true;
    let saveTimer;
    if (editable) {
      input.addEventListener("input", () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => renameGroup(id, input.value), 250);
      });
      input.addEventListener("blur", () => renameGroup(id, input.value));
    }

    const count = document.createElement("span");
    count.className = "group-row-count";
    const n = counts.get(id) || 0;
    if (n === 0) {
      count.textContent = editable ? "not in this doc" : "—";
      count.dataset.short = "—";
    } else {
      count.textContent = editable ? `${n} here` : `${n}`;
      count.dataset.short = `${n}`;
    }

    const eye = document.createElement("input");
    eye.type = "checkbox";
    eye.className = "group-row-eye";
    eye.checked = !meta.hidden;
    eye.title = meta.hidden ? "Group hidden — click to show" : "Group visible — click to hide";
    if (editable) {
      eye.addEventListener("change", (e) => {
        e.stopPropagation();
        setGroupHidden(id, !eye.checked);
      });
      eye.addEventListener("click", (e) => e.stopPropagation());
    } else {
      eye.disabled = true;
    }

    if (editable) {
      const del = document.createElement("button");
      del.className = "group-row-delete";
      del.textContent = "delete";
      del.title = "Delete group (snippets are preserved)";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete this group? Snippets stay, just no longer grouped.`)) return;
        await deleteGroup(id);
      });
      li.append(sticker, input, count, eye, del);
    } else {
      li.append(sticker, input, count, eye);
    }
    list.appendChild(li);
  }
}

// Workspace-scope footer. Two stacked subsections inside the same scroll
// region: groups (read-only union across member sidecars) then
// collections (from the active workspace sidecar — per SPEC §3.9).
async function renderWorkspaceGroupsPanel(list) {
  const placeholder = document.createElement("li");
  placeholder.className = "groups-empty";
  placeholder.textContent = "Loading workspace…";
  list.appendChild(placeholder);
  let data;
  try {
    data = await loadWorkspaceMapData();
  } catch (err) {
    console.warn("[groups-panel] workspace load failed", err);
    placeholder.textContent = "Could not load workspace groups.";
    return;
  }
  // If a scope toggle happened mid-load, bail — the doc-mode render
  // will already have rebuilt the list.
  if (state.mapScope !== "workspace") return;
  list.innerHTML = "";

  // Subsection header helper — keeps the same uppercase-tracking look
  // as the panel header without re-styling each insertion.
  const subhead = (label) => {
    const li = document.createElement("li");
    li.className = "groups-subhead";
    li.textContent = label;
    return li;
  };

  const groups = data.groups || [];
  const collections = data.collections || [];
  list.appendChild(subhead(`Groups · ${groups.length}`));
  if (groups.length === 0) {
    const empty = document.createElement("li");
    empty.className = "groups-empty";
    empty.textContent = "No groups in this workspace yet.";
    list.appendChild(empty);
  } else {
    renderDocGroupRows(list, groups, data.snippets || [], { editable: false });
  }

  list.appendChild(subhead(`Collections · ${collections.length}`));
  if (collections.length === 0) {
    const empty = document.createElement("li");
    empty.className = "groups-empty";
    empty.textContent = "No collections — define via workspace sidecar.";
    list.appendChild(empty);
    return;
  }
  for (const c of collections) {
    const li = document.createElement("li");
    li.className = "group-row collection-row";
    li.dataset.collectionId = c.id;
    const sticker = document.createElement("span");
    sticker.className = "group-row-sticker collection-sticker";
    if (c.color) sticker.style.setProperty("--g", c.color);
    sticker.title = c.kind ? `Collection · ${c.kind}` : "Collection";
    const name = document.createElement("span");
    name.className = "collection-name";
    name.textContent = c.name || "(unnamed collection)";
    const count = document.createElement("span");
    count.className = "group-row-count";
    // Member count derives from any member sidecar that lists this
    // collection id; computed once over the workspace's members.
    const memberCount = (state.workspace?.members || []).filter(
      (m) => (m.collections || []).includes(c.id),
    ).length;
    count.textContent = `${memberCount}`;
    count.dataset.short = `${memberCount}`;
    li.append(sticker, name, count);
    list.appendChild(li);
  }
}

function maybeBeginStickerDrag(downEvent, groupId, meta, onPlainClick) {
  if (downEvent.button !== 0) return;
  // Prevent the button's default mousedown→click chain so it doesn't fire
  // a stray click after the drag releases.
  downEvent.preventDefault();
  downEvent.stopPropagation();
  const startX = downEvent.clientX;
  const startY = downEvent.clientY;
  const stickerEl = downEvent.currentTarget;
  let dragStarted = false;
  let didCancel = false;
  const onMove = (ev) => {
    if (dragStarted || didCancel) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.hypot(dx, dy) > 4) {
      dragStarted = true;
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      stickerEl.classList.add("peeled");
      setTimeout(() => stickerEl.classList.remove("peeled"), 220);
      beginStickerDrag(ev, groupId, meta);
    }
  };
  const onUp = () => {
    didCancel = true;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    if (!dragStarted) {
      try { onPlainClick?.(); } catch {}
    }
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
}

// Custom palette popover — replaces the native <input type="color">
// because WkWebView anchors the OS picker to the document corner when
// the input is invisibly small. Eight palette slots from the active
// theme; click a swatch to assign it to the group.
let _activeColorPopover = null;
function openColorPopover(anchorEl, groupId) {
  closeColorPopover();
  const pop = document.createElement("div");
  pop.className = "color-popover";
  for (let slot = 0; slot < GROUP_PALETTE_SLOTS; slot++) {
    const sw = document.createElement("button");
    sw.className = "color-popover-swatch";
    sw.style.background = readPaletteColor(slot);
    sw.title = `Palette slot ${slot + 1}`;
    sw.addEventListener("click", async (e) => {
      e.stopPropagation();
      await setGroupPaletteSlot(groupId, slot);
      closeColorPopover();
    });
    pop.appendChild(sw);
  }
  document.body.appendChild(pop);
  // Position near the sticker, kept inside the viewport.
  const r = anchorEl.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let left = r.left;
  let top = r.bottom + 6;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (left < 8) left = 8;
  if (top + ph > window.innerHeight - 8) top = r.top - ph - 6;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  _activeColorPopover = pop;
  setTimeout(() => {
    document.addEventListener("click", _onColorPopoverOutside, true);
    document.addEventListener("keydown", _onColorPopoverEsc, true);
  }, 0);
}
function closeColorPopover() {
  if (_activeColorPopover) {
    _activeColorPopover.remove();
    _activeColorPopover = null;
  }
  document.removeEventListener("click", _onColorPopoverOutside, true);
  document.removeEventListener("keydown", _onColorPopoverEsc, true);
}
function _onColorPopoverOutside(e) {
  if (!_activeColorPopover) return;
  if (_activeColorPopover.contains(e.target)) return;
  closeColorPopover();
}
function _onColorPopoverEsc(e) {
  if (e.key === "Escape") closeColorPopover();
}

function beginStickerDrag(downEvent, groupId, meta) {
  // Caller (maybeBeginStickerDrag) has already validated the button and
  // prevented default; just guard preventDefault on this event too.
  try { downEvent.preventDefault?.(); } catch {}
  try { downEvent.stopPropagation?.(); } catch {}

  const color = groupColorHex(groupId);
  const ghost = document.createElement("div");
  ghost.className = "sticker-ghost";
  ghost.style.setProperty("--g", color);
  ghost.textContent = (meta?.name) || `Group ${(state.groupsMeta || []).findIndex((g) => g.id === groupId) + 1}`;
  document.body.appendChild(ghost);
  document.body.classList.add("dragging-sticker");

  // Drop target may be either:
  //  - DOM .snippet card in the snippets list, OR
  //  - cytoscape snippet node in the lineage canvas.
  // Track them in a unified lastTarget shape: { kind, ref, snippetId }.
  let lastTarget = null;
  const setTarget = (next) => {
    if (lastTarget === next) return;
    if (lastTarget?.kind === "card") lastTarget.ref.classList.remove("sticker-drop-target");
    if (lastTarget?.kind === "lineage") LineageView.setStickerTarget(null);
    if (next?.kind === "card") next.ref.classList.add("sticker-drop-target");
    if (next?.kind === "lineage") LineageView.setStickerTarget(next.snippetId);
    lastTarget = next;
  };
  const move = (ev) => {
    ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY - 6}px)`;
    // Card-list hit first.
    const stack = document.elementsFromPoint(ev.clientX, ev.clientY);
    const card = stack.find((el) => el.classList?.contains("snippet"));
    if (card) {
      setTarget({ kind: "card", ref: card, snippetId: card.dataset.snippetId });
      return;
    }
    // Lineage canvas hit second.
    const lineageHit = LineageView.snippetAtScreenPoint(ev.clientX, ev.clientY);
    if (lineageHit) {
      setTarget({ kind: "lineage", ref: lineageHit.node, snippetId: lineageHit.snippetId });
      return;
    }
    setTarget(null);
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cleanup);
    document.body.classList.remove("dragging-sticker");
    setTarget(null);
    ghost.remove();
  };
  const up = async () => {
    const target = lastTarget;
    cleanup();
    if (!target?.snippetId) return;
    const snippet = state.snippets.find((s) => s.id === target.snippetId);
    if (!snippet) return;
    snippet.groups = snippet.groups || [];
    if (!snippet.groups.includes(groupId)) {
      snippet.groups.push(groupId);
      await persist();
      refreshActiveView();
      applyAllHighlights();
    }
  };

  move(downEvent);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cleanup);
}

function handleEdgeSelection(edge) {
  if (edge && edge.data("isMembership")) return;
  selectedEdge = edge;
  const editor = document.getElementById("edge-editor");
  if (!edge) {
    editor.hidden = true;
    return;
  }
  editor.hidden = false;
  const input = document.getElementById("edge-label-input");
  input.value = edge.data("label") || "";
  input.focus();
}

function saveEdgeLabel() {
  if (!selectedEdge) return;
  const input = document.getElementById("edge-label-input");
  MapView.setEdgeLabel(selectedEdge, input.value.trim());
  document.getElementById("edge-editor").hidden = true;
  selectedEdge = null;
}

updateZoomLabel();
setupPanelResize();
setupAppMenu();
setupPermalinkBootstrap();

// Marklee Permalink bootstrap — see SPEC.md §6.
// V0.1: parse the query string on load. If the permalink references a snippet
// already in the current workspace (matched by id, or by hash + text within
// any open doc), scroll to it. Cross-origin PDF fetch + storage hookup is
// stubbed — see resolveOrFetchPermalink() — and lands in a follow-up that
// teaches the storage layer to accept synthetic blob paths.
let pendingPermalink = null;

function setupPermalinkBootstrap() {
  const qs = window.location.search;
  if (!qs || qs.length < 2) return;
  const parsed = parsePermalink(qs);
  if (!parsed) return;
  pendingPermalink = parsed;
  console.log("[marklee] permalink detected", parsed);
  // Try to resolve immediately against any already-loaded doc.
  const ok = resolvePendingPermalink();
  if (ok) return;
  // Stash for later resolution after the user opens a matching doc.
  // TODO: when src is provided and we're in web mode, fetch + load the PDF
  // bytes here. Requires the storage layer to accept a synthetic ("marklee://")
  // path or a Blob handle path. Tracked as part of the FSA URL bootstrap work.
  if (!IS_TAURI && parsed.src) {
    console.warn("[marklee] web fetch of src=" + parsed.src + " not yet implemented; open the doc manually for now");
  }
}

function resolvePendingPermalink() {
  if (!pendingPermalink) return false;
  const want = pendingPermalink.snippet;
  // Match by id first — works for any kind.
  if (want.id) {
    const found = state.snippets.find((s) => s.id === want.id);
    if (found) { pendingPermalink = null; previewSnippetInPdf(found); return true; }
  }
  // Image snippets: match by page + rect proximity (within 0.5%).
  if (want.kind === "image" && want.page != null && want.rects?.[0]) {
    const wr = want.rects[0];
    const close = (a, b) => Math.abs(a - b) < 0.005;
    const found = state.snippets.find((s) =>
      s.kind === "image" && s.page === want.page && s.rects?.[0] &&
      close(s.rects[0].left, wr.left) && close(s.rects[0].top, wr.top) &&
      close(s.rects[0].width, wr.width) && close(s.rects[0].height, wr.height)
    );
    if (found) { pendingPermalink = null; previewSnippetInPdf(found); return true; }
    // No matching saved snippet — at least scroll the page into view.
    const wraps = viewerContainer.querySelectorAll(`.page-wrap[data-page="${want.page}"]`);
    if (wraps[0]) {
      pendingPermalink = null;
      wraps[0].scrollIntoView({ behavior: "smooth", block: "start" });
      flashRectOverlay(wraps[0], wr);
      return true;
    }
  }
  // Text snippets: match by normalized text + page.
  if (want.kind !== "image" && want.text) {
    const found = state.snippets.find((s) =>
      (s.textNormalized || s.text) === want.text &&
      (want.page == null || s.page === want.page)
    );
    if (found) { pendingPermalink = null; previewSnippetInPdf(found); return true; }
  }
  return false;
}

function flashRectOverlay(wrap, rect) {
  const el = document.createElement("div");
  el.className = "permalink-flash-rect";
  el.style.position = "absolute";
  el.style.left = `${rect.left * 100}%`;
  el.style.top = `${rect.top * 100}%`;
  el.style.width = `${rect.width * 100}%`;
  el.style.height = `${rect.height * 100}%`;
  el.style.pointerEvents = "none";
  el.style.border = "2px solid var(--accent)";
  el.style.background = "color-mix(in srgb, var(--accent) 14%, transparent)";
  el.style.borderRadius = "3px";
  el.style.transition = "opacity 1500ms ease-out";
  el.style.zIndex = "20";
  wrap.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = "0"; });
  setTimeout(() => el.remove(), 1700);
}

function setupAppMenu() {
  if (!IS_TAURI) return;
  import("@tauri-apps/api/event").then(({ listen }) => {
    listen("app-menu", ({ payload }) => handleAppMenu(String(payload)));
  });
}

function handleAppMenu(id) {
  const click = (sel) => document.querySelector(sel)?.click();
  switch (id) {
    case "file_open":              click("#open-file"); break;
    case "file_open_folder":       click("#open-folder"); break;
    case "file_summary":           openSummary(); break;
    case "file_export_summary":    openSummary(); setTimeout(exportSummaryHtml, 80); break;
    case "edit_undo":              undo(); break;
    case "edit_find":              openLocalSearch(); break;
    case "edit_find_workspace":    openGlobalSearch(); break;
    case "view_zoom_in":           zoomIn(); break;
    case "view_zoom_out":          zoomOut(); break;
    case "view_zoom_fit":          zoomFit(); break;
    case "view_toggle_sidebar":    toggleSidebar(); break;
    case "view_maximize":          toggleMaximizePane(); break;
    case "view_help":              click("#help-btn"); break;
    // Workspace menu
    case "ws_new":                 newWorkspace(); break;
    case "ws_rename":              renameActiveWorkspace(); break;
    case "ws_close":               closeWorkspace(state.workspaces.active); break;
    case "ws_next":                cycleWorkspace(+1); break;
    case "ws_prev":                cycleWorkspace(-1); break;
    case "ws_clear":               click("#clear-workspace"); break;
    case "ws_cycle_theme":         click("#theme-btn"); break;
    // Groups menu
    case "groups_template":        openTemplatesModal(); break;
    case "groups_from_workspace":  click("#groups-import-ws"); break;
    case "groups_import_file":     click("#groups-import"); break;
    case "groups_export":          click("#groups-export"); break;
    case "groups_toggle_panel":    click("#groups-collapse"); break;
  }
}

function renameActiveWorkspace() {
  const tab = document.querySelector(`.ws-tab[data-ws-id="${state.workspaces.active}"]`);
  const input = tab?.querySelector(".ws-tab-name");
  if (!input) return;
  input.readOnly = false;
  input.focus();
  input.select();
}

function cycleWorkspace(dir) {
  const order = state.workspaces.order;
  if (!order.length) return;
  const i = order.indexOf(state.workspaces.active);
  const next = order[(i + dir + order.length) % order.length];
  if (next && next !== state.workspaces.active) switchWorkspace(next);
}

function setupPanelResize() {
  for (const side of ["sidebar", "snippets"]) {
    let saved = null;
    try { saved = localStorage.getItem(`pdf-annotator-${side}-w`); } catch {}
    if (saved) document.documentElement.style.setProperty(`--${side}-w`, saved);
  }
  attachResize(document.getElementById("resize-left"), "sidebar", +1);
  attachResize(document.getElementById("resize-right"), "snippets", -1);
  setupAiDrawerResize();
}

// Vertical drag handle between the AI suggestions pane and the snippets
// list. Persists height as a percentage of #snippets-pane so it stays
// proportional across window resizes. Collapse button stows the body of
// the AI drawer leaving just the header visible.
function setupAiDrawerResize() {
  const drawer = document.getElementById("ai-drawer");
  const handle = document.getElementById("ai-drawer-resize");
  const pane = document.getElementById("snippets-pane");
  const collapseBtn = document.getElementById("ai-drawer-collapse");
  if (!drawer || !handle || !pane) return;

  const HEIGHT_KEY = "marklee-ai-drawer-h";
  const COLLAPSED_KEY = "marklee-ai-drawer-collapsed";

  // Restore saved height.
  try {
    const saved = localStorage.getItem(HEIGHT_KEY);
    if (saved) drawer.style.setProperty("height", saved);
    if (localStorage.getItem(COLLAPSED_KEY) === "1") drawer.classList.add("collapsed");
  } catch {}

  handle.addEventListener("mousedown", (e) => {
    if (drawer.classList.contains("collapsed")) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = drawer.getBoundingClientRect().height;
    const paneH = pane.getBoundingClientRect().height;
    document.body.classList.add("resizing-v");
    handle.classList.add("active");
    function onMove(ev) {
      const delta = ev.clientY - startY;
      const next = Math.max(64, Math.min(paneH - 120, startH + delta));
      drawer.style.height = `${next}px`;
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing-v");
      handle.classList.remove("active");
      try { localStorage.setItem(HEIGHT_KEY, drawer.style.height); } catch {}
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  if (collapseBtn) {
    collapseBtn.addEventListener("click", () => {
      drawer.classList.toggle("collapsed");
      try {
        localStorage.setItem(
          COLLAPSED_KEY,
          drawer.classList.contains("collapsed") ? "1" : "0",
        );
      } catch {}
    });
  }
}

function attachResize(handle, side, sign) {
  if (!handle) return;
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const cssVar = `--${side}-w`;
    const startW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar)) || 240;
    document.body.classList.add("resizing");
    handle.classList.add("active");

    function onMove(ev) {
      const delta = (ev.clientX - startX) * sign;
      const next = Math.max(160, Math.min(640, startW + delta));
      document.documentElement.style.setProperty(cssVar, `${next}px`);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
      handle.classList.remove("active");
      try {
        localStorage.setItem(`pdf-annotator-${side}-w`, document.documentElement.style.getPropertyValue(cssVar) || `${startW}px`);
      } catch {}
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

async function getSummaryData() {
  if (state.summaryScope === "workspace") {
    const data = await loadWorkspaceMapData();
    const sources = new Set();
    for (const s of data.snippets) {
      sources.add(s._pdfPath || state.currentPdfPath || "");
    }
    return { snippets: data.snippets, sources: [...sources].filter(Boolean) };
  }
  // Doc scope — include workspace-level pasted snippets too so summaries
  // and exports surface them alongside the active doc's content.
  const docSnippets = state.snippets.map((s) => ({ ...s, _pdfPath: state.currentPdfPath }));
  const pastedSnippets = (state.workspace?.pastedSnippets || [])
    .map((s) => ({ ...s, _pdfPath: PASTED_PSEUDO_PATH }));
  const sources = [];
  if (state.currentPdfPath) sources.push(state.currentPdfPath);
  if (pastedSnippets.length) sources.push(PASTED_PSEUDO_PATH);
  return {
    snippets: [...docSnippets, ...pastedSnippets],
    sources,
  };
}

function setSummaryScope(scope) {
  if (scope === state.summaryScope) return;
  state.summaryScope = scope;
  document.querySelectorAll("#summary-scope .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.scope === scope);
  });
  openSummary();
}

function setSummaryFormat(fmt) {
  if (fmt === state.summaryFormat) return;
  state.summaryFormat = fmt;
  document.querySelectorAll("#summary-format .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.format === fmt);
  });
}

function setSummaryImageSize(size) {
  if (size !== "compact" && size !== "full") return;
  state.summaryImageSize = size;
  try { localStorage.setItem("marklee-summary-img-size", size); } catch {}
  document.querySelectorAll("#summary-image-size .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.imgSize === size);
  });
  document.getElementById("summary-modal").dataset.imgSize = size;
}

async function openSummary() {
  const modal = document.getElementById("summary-modal");
  modal.dataset.imgSize = state.summaryImageSize || "compact";
  document.querySelectorAll("#summary-image-size .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.imgSize === modal.dataset.imgSize);
  });
  const titleEl = document.getElementById("summary-title");
  const metaEl = document.getElementById("summary-meta");
  const contentEl = document.getElementById("summary-content");

  const { snippets, sources } = await getSummaryData();
  const isWorkspace = state.summaryScope === "workspace";

  titleEl.textContent = isWorkspace
    ? `Workspace summary`
    : (state.source.title || "Summary");
  metaEl.textContent = [
    isWorkspace ? `${sources.length} sources` : state.source.author,
    `${snippets.length} snippet${snippets.length === 1 ? "" : "s"}`,
  ].filter(Boolean).join(" · ");

  contentEl.innerHTML = "";
  const ordered = [...snippets].sort((a, b) => {
    const ka = [a._pdfPath || "", a.page, a.rects?.[0]?.top ?? 0];
    const kb = [b._pdfPath || "", b.page, b.rects?.[0]?.top ?? 0];
    if (ka[0] !== kb[0]) return ka[0] < kb[0] ? -1 : 1;
    return ka[1] - kb[1] || ka[2] - kb[2];
  });

  const sections = new Map();
  const ungrouped = [];
  for (const s of ordered) {
    const groups = s.groups || [];
    if (groups.length === 0) {
      ungrouped.push(s);
    } else {
      for (const gid of groups) {
        if (!sections.has(gid)) sections.set(gid, []);
        sections.get(gid).push(s);
      }
    }
  }

  const renderItem = (s, gid) => {
    const item = document.createElement("div");
    item.className = "summary-item";
    if (gid) {
      item.style.setProperty("--group-color", groupColor(gid));
      item.classList.add("grouped");
    }
    const itemMeta = document.createElement("div");
    itemMeta.className = "summary-item-meta";
    const path = s._pdfPath || "";
    const fname = path === PASTED_PSEUDO_PATH ? "📋 Pasted" : (path.split("/").pop() || "");
    const loc = s.anchor ? `§ ${s.anchor}` : `p.${s.page}`;
    itemMeta.textContent = (isWorkspace || path === PASTED_PSEUDO_PATH) && fname
      ? `${fname} · ${loc}`
      : loc;
    let body;
    if (s.kind === "image" && s.imagePath) {
      body = document.createElement("div");
      body.className = "summary-item-image";
      const img = document.createElement("img");
      img.alt = s.text || "image clip";
      img.loading = "lazy";
      // Pasted image clips live at _imageOwnerPath; everything else uses
      // the snippet's _pdfPath as the clip owner.
      const owner = s._imageOwnerPath || s._pdfPath || state.currentPdfPath;
      loadClipUrl(s.imagePath, owner).then((url) => {
        if (url) img.src = url;
        else body.classList.add("missing");
      });
      body.appendChild(img);
    } else {
      body = document.createElement("blockquote");
      body.textContent = s.text;
    }
    item.append(itemMeta, body);
    if (s.comment) {
      const c = document.createElement("div");
      c.className = "summary-comment";
      c.textContent = s.comment;
      item.appendChild(c);
    }
    return item;
  };

  // Iterate groups in groupsMeta order so reordering the left-panel
  // list (which mutates groupsMeta) re-orders the summary sections.
  const groupsMeta = state.groupsMeta || [];
  const orderedGids = groupsMeta
    .map((g) => g.id)
    .filter((gid) => sections.has(gid));

  for (const gid of orderedGids) {
    const members = sections.get(gid);
    const groupHeader = document.createElement("div");
    groupHeader.className = "summary-group-header";
    groupHeader.style.color = groupColor(gid);
    groupHeader.textContent = `● ${groupName(gid)} (${members.length})`;
    groupHeader.dataset.gid = gid;
    contentEl.appendChild(groupHeader);
    for (const s of members) contentEl.appendChild(renderItem(s, gid));
  }
  if (ungrouped.length > 0) {
    if (orderedGids.length > 0) {
      const h = document.createElement("div");
      h.className = "summary-group-header";
      h.style.color = "#6e6e6e";
      h.textContent = `unfiled (${ungrouped.length})`;
      contentEl.appendChild(h);
    }
    for (const s of ungrouped) contentEl.appendChild(renderItem(s, null));
  }

  renderSummaryGroupsPanel(orderedGids, sections, ungrouped.length);

  modal.hidden = false;
}

// Left side panel of the summary modal: lists each group that has
// snippets, in groupsMeta order, with a drag handle so the user can
// reorder. Dropping a group reorders groupsMeta in place, then we
// re-open the summary so the content area follows the new order.
function renderSummaryGroupsPanel(orderedGids, sections, ungroupedCount) {
  const oldList = document.getElementById("summary-groups-list");
  if (!oldList) return;
  // Replace the <ul> entirely so any stale event listeners (e.g.,
  // from a previous Vite hot-reload of this module) die with the old
  // element. wireSummaryGroupDrag then attaches a fresh set to the
  // new <ul>.
  const list = document.createElement("ul");
  list.id = "summary-groups-list";
  oldList.replaceWith(list);
  const moveGroup = (gid, delta) => {
    const meta = state.groupsMeta || [];
    const i = meta.findIndex((g) => g.id === gid);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= meta.length) return;
    const [moved] = meta.splice(i, 1);
    meta.splice(j, 0, moved);
    saveWorkspace();
    openSummary();
  };

  for (let idx = 0; idx < orderedGids.length; idx++) {
    const gid = orderedGids[idx];
    const li = document.createElement("li");
    li.className = "summary-group-pill";
    // Not using HTML5 drag (draggable=true) — pointer events handle
    // reorder. Leaving draggable=true would let WebKit start a system
    // drag that we then have to cancel.
    li.dataset.gid = gid;
    li.style.setProperty("--g-color", groupColor(gid));
    const dot = document.createElement("span");
    dot.className = "summary-group-pill-dot";
    const name = document.createElement("span");
    name.className = "summary-group-pill-name";
    name.textContent = groupName(gid);
    const count = document.createElement("span");
    count.className = "summary-group-pill-count";
    count.textContent = sections.get(gid).length;
    // Up/down arrows — guaranteed-working reorder fallback that
    // doesn't depend on HTML5 drag-and-drop semantics. Hidden until
    // the pill is hovered (handled in CSS).
    const arrows = document.createElement("span");
    arrows.className = "summary-group-pill-arrows";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "summary-group-pill-arrow";
    up.title = "Move up";
    up.textContent = "▲";
    up.disabled = idx === 0;
    up.addEventListener("click", (e) => { e.stopPropagation(); moveGroup(gid, -1); });
    const dn = document.createElement("button");
    dn.type = "button";
    dn.className = "summary-group-pill-arrow";
    dn.title = "Move down";
    dn.textContent = "▼";
    dn.disabled = idx === orderedGids.length - 1;
    dn.addEventListener("click", (e) => { e.stopPropagation(); moveGroup(gid, 1); });
    arrows.append(up, dn);
    li.append(dot, name, count, arrows);
    li.addEventListener("click", () => {
      const header = document.querySelector(`#summary-content .summary-group-header[data-gid="${gid}"]`);
      header?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    list.appendChild(li);
  }
  if (ungroupedCount > 0) {
    const li = document.createElement("li");
    li.className = "summary-group-pill summary-group-pill-unfiled";
    const name = document.createElement("span");
    name.className = "summary-group-pill-name";
    name.textContent = "unfiled";
    const count = document.createElement("span");
    count.className = "summary-group-pill-count";
    count.textContent = ungroupedCount;
    li.append(name, count);
    list.appendChild(li);
  }
  wireSummaryGroupDrag(list);
}

// Reorder via pointer events rather than HTML5 drag-and-drop. The
// browser drag API kept losing to other listeners in the app
// (snippet→group drop targets, Tauri drag-region intercept on the
// title strip, modal click handlers). Pointer events have none of
// that ceremony — pointerdown on a pill captures the gid, pointermove
// tracks the cursor and highlights the pill underneath, pointerup
// performs the reorder. Small click-vs-drag threshold so a quick
// click still scrolls to the section.
function wireSummaryGroupDrag(list) {
  let downGid = null;
  let startY = 0;
  let dragging = false;
  const DRAG_THRESHOLD = 4;

  const findPillAt = (clientX, clientY) => {
    for (const li of list.querySelectorAll(".summary-group-pill")) {
      if (!li.dataset.gid) continue;
      const r = li.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        return li;
      }
    }
    return null;
  };

  list.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // Ignore clicks on the inline ▲/▼ arrows so they keep working
    // as plain buttons.
    if (e.target.closest(".summary-group-pill-arrow")) return;
    const li = e.target.closest(".summary-group-pill");
    if (!li || !li.dataset.gid) return;
    downGid = li.dataset.gid;
    startY = e.clientY;
    dragging = false;
    // Capture the pointer to <ul> so pointermove/up keep flowing even
    // when the cursor crosses out of any specific pill or out of the
    // list entirely. Without this, WebKit drops move events the
    // moment the cursor leaves the element where pointerdown fired.
    try { list.setPointerCapture(e.pointerId); } catch {}
    // Visible immediate feedback so the user can tell pointerdown
    // registered — otherwise the threshold delay can feel like
    // nothing's happening.
    li.classList.add("press");
  });

  list.addEventListener("pointermove", (e) => {
    if (!downGid) return;
    if (!dragging && Math.abs(e.clientY - startY) < DRAG_THRESHOLD) return;
    if (!dragging) {
      dragging = true;
      const src = list.querySelector(`.summary-group-pill[data-gid="${downGid}"]`);
      src?.classList.add("dragging");
      document.body.classList.add("summary-reorder-active");
    }
    const over = findPillAt(e.clientX, e.clientY);
    list.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
    if (over && over.dataset.gid && over.dataset.gid !== downGid) {
      over.classList.add("drag-over");
    }
  });

  const finish = (e) => {
    if (!downGid) return;
    const wasDragging = dragging;
    const sourceGid = downGid;
    downGid = null;
    dragging = false;
    try { list.releasePointerCapture(e.pointerId); } catch {}
    document.body.classList.remove("summary-reorder-active");
    list.querySelectorAll(".press, .dragging, .drag-over").forEach((el) =>
      el.classList.remove("press", "dragging", "drag-over"));
    if (!wasDragging) return; // pure click — pill's own click handler runs separately
    const over = findPillAt(e.clientX, e.clientY);
    if (!over || !over.dataset.gid || over.dataset.gid === sourceGid) return;
    const meta = state.groupsMeta || [];
    const fromIdx = meta.findIndex((g) => g.id === sourceGid);
    const toIdx = meta.findIndex((g) => g.id === over.dataset.gid);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = meta.splice(fromIdx, 1);
    meta.splice(toIdx, 0, moved);
    saveWorkspace();
    openSummary();
  };

  list.addEventListener("pointerup", finish);
  list.addEventListener("pointercancel", finish);
}

function closeSummary() {
  document.getElementById("summary-modal").hidden = true;
}

async function copySummary() {
  const lines = [];
  const { snippets, sources } = await getSummaryData();
  const isWorkspace = state.summaryScope === "workspace";
  if (!isWorkspace) {
    if (state.source.title) lines.push(state.source.title);
    if (state.source.author) lines.push(state.source.author);
  } else {
    lines.push(`Workspace summary (${sources.length} sources, ${snippets.length} snippets)`);
  }
  if (lines.length) lines.push("");

  const sections = new Map();
  const ungrouped = [];
  for (const s of snippets) {
    const groups = s.groups || [];
    if (groups.length === 0) {
      ungrouped.push(s);
    } else {
      for (const gid of groups) {
        if (!sections.has(gid)) sections.set(gid, []);
        sections.get(gid).push(s);
      }
    }
  }
  const writeSnippet = (s) => {
    const path = s._pdfPath || "";
    const fname = path === PASTED_PSEUDO_PATH ? "📋 Pasted" : (path.split("/").pop() || "");
    const loc = s.anchor ? `§ ${s.anchor}` : `p.${s.page}`;
    const ref = (isWorkspace || path === PASTED_PSEUDO_PATH) && fname ? `${fname} ${loc}` : loc;
    lines.push(`[${ref}] "${s.text}"`);
    if (s.comment) lines.push(`  → ${s.comment}`);
    lines.push("");
  };
  for (const [gid, members] of sections) {
    lines.push(`— ${groupName(gid)} —`);
    members.forEach(writeSnippet);
  }
  if (ungrouped.length > 0) {
    if (sections.size > 0) lines.push("— unfiled —");
    ungrouped.forEach(writeSnippet);
  }
  try {
    await navigator.clipboard.writeText(lines.join("\n").trim());
    const btn = document.getElementById("summary-copy");
    const prev = btn.textContent;
    btn.textContent = "copied";
    setTimeout(() => { btn.textContent = prev; }, 900);
  } catch (err) {
    console.error("clipboard write failed", err);
  }
}

async function exportSummaryHtml() {
  const exportBtn = document.getElementById("summary-export");
  const prev = exportBtn.textContent;
  exportBtn.textContent = "preparing…";
  try {
    const { snippets, sources } = await getSummaryData();
    const isWorkspace = state.summaryScope === "workspace";

    const imageMap = new Map();
    const imageSnippets = snippets.filter((s) => s.kind === "image" && s.imagePath);
    await Promise.all(imageSnippets.map(async (s) => {
      // Pasted image clips live under the placeholder clipboard doc, not
      // their nominal _pdfPath. Honor _imageOwnerPath when present.
      const owner = s._imageOwnerPath || s._pdfPath || state.currentPdfPath;
      try {
        const u8 = await getStore().readClip(owner, s.imagePath);
        let binary = "";
        for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
        imageMap.set(s.id, `data:image/png;base64,${btoa(binary)}`);
      } catch (err) {
        console.warn("clip read failed for export:", s.imagePath);
      }
    }));

    const sections = new Map();
    const ungrouped = [];
    for (const s of snippets) {
      const gs = s.groups || [];
      if (gs.length === 0) ungrouped.push(s);
      else for (const gid of gs) {
        if (!sections.has(gid)) sections.set(gid, []);
        sections.get(gid).push(s);
      }
    }

    const title = isWorkspace
      ? "Workspace summary"
      : (state.source.title || "Snippet compilation");

    const html = state.summaryFormat === "plain"
      ? renderHtmlExportPlain({ title, sources, snippets, sections, ungrouped, imageMap, isWorkspace })
      : renderHtmlExport({ title, sources, snippets, sections, ungrouped, imageMap, isWorkspace });

    const filename = sanitizeFilename(`${title}.html`);
    const saved = await saveFile({
      suggestedName: filename,
      mimeType: "text/html",
      content: html,
    });
    exportBtn.textContent = saved ? "exported" : "cancelled";
    setTimeout(() => { exportBtn.textContent = prev; }, 1100);
  } catch (err) {
    console.error("HTML export failed", err);
    exportBtn.textContent = "failed";
    setTimeout(() => { exportBtn.textContent = prev; }, 1100);
  }
}

function sanitizeFilename(s) {
  return s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "summary.html";
}

function renderHtmlExportPlain({ title, sources, snippets, sections, ungrouped, imageMap, isWorkspace }) {
  const esc = (s) => {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  };
  const renderSnippet = (s) => {
    const path = s._pdfPath || "";
    const isPasted = path === PASTED_PSEUDO_PATH;
    const filename = isPasted ? "📋 Pasted" : (path.split("/").pop() || "?");
    const href = (path && !isPasted) ? `file://${encodeURI(path)}#page=${s.page}` : "";
    const loc = s.anchor ? `§ ${s.anchor}` : `p.${s.page}`;
    const cite = href
      ? `<a href="${esc(href)}">${esc(filename)} ${esc(loc)}</a>`
      : `${esc(filename)} ${esc(loc)}`;
    let body;
    if (s.kind === "image" && imageMap.get(s.id)) {
      body = `<p><img src="${imageMap.get(s.id)}" alt="${esc(s.text || "")}"></p>`;
    } else if (s.kind === "image") {
      body = `<p><em>[image clip missing]</em></p>`;
    } else {
      body = `<blockquote>${esc(s.text || "")}</blockquote>`;
    }
    const comment = s.comment ? `<p>→ ${esc(s.comment)}</p>` : "";
    return `<p><small>[${cite}]</small></p>\n${body}\n${comment}`;
  };
  const sortByDocAndPage = (a, b) => {
    if ((a._pdfPath || "") !== (b._pdfPath || "")) {
      return (a._pdfPath || "") < (b._pdfPath || "") ? -1 : 1;
    }
    return a.page - b.page;
  };
  const out = [];
  out.push(`<h1>${esc(title)}</h1>`);
  out.push(`<p>${snippets.length} snippets · ${sections.size} groups${isWorkspace ? ` · ${sources.length} sources` : ""}</p>`);
  if (sources.length > 0) {
    out.push(`<p><small>${sources.map((p) => esc(p === PASTED_PSEUDO_PATH ? "📋 Pasted" : (p.split("/").pop() || p))).join(" · ")}</small></p>`);
  }
  out.push(`<hr>`);
  for (const [gid, members] of sections) {
    members.sort(sortByDocAndPage);
    out.push(`<h2>${esc(groupName(gid))} (${members.length})</h2>`);
    for (const s of members) out.push(renderSnippet(s));
  }
  if (ungrouped.length > 0) {
    ungrouped.sort(sortByDocAndPage);
    out.push(`<h2>Unfiled (${ungrouped.length})</h2>`);
    for (const s of ungrouped) out.push(renderSnippet(s));
  }
  out.push(`<hr><p><small>Exported ${esc(new Date().toLocaleString())}</small></p>`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
</head>
<body>
${out.join("\n")}
</body>
</html>`;
}

function renderHtmlExport({ title, sources, snippets, sections, ungrouped, imageMap, isWorkspace }) {
  const esc = (s) => {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  };

  const renderSnippet = (s, color) => {
    const path = s._pdfPath || "";
    const filename = path.split("/").pop() || "?";
    const href = path ? `file://${encodeURI(path)}#page=${s.page}` : "";
    const cite = href
      ? `<a href="${esc(href)}">${esc(filename)} · p.${s.page}</a>`
      : `${esc(filename)} · p.${s.page}`;
    let body;
    if (s.kind === "image" && imageMap.get(s.id)) {
      body = `<div class="snippet-image"><img src="${imageMap.get(s.id)}" alt="${esc(s.text || "")}"></div>`;
    } else if (s.kind === "image") {
      body = `<div class="snippet-text muted">[image clip missing]</div>`;
    } else {
      body = `<div class="snippet-text">${esc(s.text || "")}</div>`;
    }
    const comment = s.comment
      ? `<div class="snippet-comment">${esc(s.comment)}</div>`
      : "";
    return `<div class="snippet" style="border-left-color:${color};">
      <div class="snippet-meta">${cite}</div>
      ${body}
      ${comment}
    </div>`;
  };

  const sortByDocAndPage = (a, b) => {
    if ((a._pdfPath || "") !== (b._pdfPath || "")) {
      return (a._pdfPath || "") < (b._pdfPath || "") ? -1 : 1;
    }
    return a.page - b.page;
  };

  const sectionHtml = [];
  for (const [gid, members] of sections) {
    const color = groupColor(gid);
    const light = lightenColor(color);
    const dark = darkenColor(color);
    members.sort(sortByDocAndPage);
    sectionHtml.push(`<section class="group-section">
      <h2 class="group-heading" style="background:${light};color:${dark};border-color:${color};">
        <span class="group-dot" style="background:${color};"></span>${esc(groupName(gid))}
        <span class="group-count">${members.length}</span>
      </h2>
      ${members.map((s) => renderSnippet(s, color)).join("\n")}
    </section>`);
  }
  if (ungrouped.length > 0) {
    ungrouped.sort(sortByDocAndPage);
    sectionHtml.push(`<section class="group-section">
      <h2 class="group-heading unfiled">Unfiled <span class="group-count">${ungrouped.length}</span></h2>
      ${ungrouped.map((s) => renderSnippet(s, "#bbb")).join("\n")}
    </section>`);
  }

  const sourceList = sources.map((p) => esc(p === PASTED_PSEUDO_PATH ? "📋 Pasted" : (p.split("/").pop() || p))).join(" · ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  :root { --fg: #1f1f1f; --dim: #666; --paper: #f6f4ee; --line: #e2dfd6; }
  body { font-family: ui-sans-serif, -apple-system, "SF Pro Text", system-ui, sans-serif; max-width: 820px; margin: 56px auto; padding: 0 28px; color: var(--fg); line-height: 1.55; background: var(--paper); }
  h1 { font-family: ui-serif, "Iowan Old Style", Charter, Georgia, serif; font-size: 28px; margin: 0 0 6px; }
  .doc-meta { color: var(--dim); font-size: 13px; }
  .sources { color: var(--dim); font-size: 11px; font-family: ui-monospace, "SF Mono", monospace; margin: 6px 0 40px; padding-bottom: 16px; border-bottom: 1px solid var(--line); letter-spacing: 0.2px; }
  .group-section { margin: 32px 0; }
  .group-heading { display: inline-flex; align-items: center; gap: 8px; font-family: ui-serif, "Iowan Old Style", Charter, Georgia, serif; font-style: italic; font-size: 15px; font-weight: 600; padding: 6px 14px; border-radius: 14px; border: 1px solid; margin-bottom: 14px; }
  .group-heading.unfiled { background: #ececec; color: #666; border-color: #d4d2c8; font-style: normal; }
  .group-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .group-count { font-family: ui-monospace, "SF Mono", monospace; font-size: 11px; opacity: 0.7; font-weight: 400; }
  .snippet { margin: 14px 0 22px; padding: 4px 0 4px 14px; border-left: 3px solid; }
  .snippet-meta { font-family: ui-monospace, "SF Mono", monospace; font-size: 11px; color: var(--dim); margin-bottom: 5px; letter-spacing: 0.2px; }
  .snippet-meta a { color: #0a6; text-decoration: none; }
  .snippet-meta a:hover { text-decoration: underline; }
  .snippet-text { font-family: ui-serif, "Iowan Old Style", Charter, Georgia, serif; font-size: 14.5px; line-height: 1.55; color: #1f1f1f; }
  .snippet-text.muted { color: #999; font-style: italic; }
  .snippet-image img { max-width: 100%; border: 1px solid var(--line); border-radius: 3px; display: block; }
  .snippet-comment { margin-top: 8px; padding: 8px 12px; background: #ece9df; border-radius: 4px; font-size: 12.5px; color: #2a2a2a; line-height: 1.5; }
  footer { color: var(--dim); font-size: 11px; margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); font-family: ui-monospace, "SF Mono", monospace; }
  @media print { body { background: white; } .group-heading { background: white !important; border-color: #000 !important; } }
</style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <div class="doc-meta">${snippets.length} snippets · ${sections.size} groups${isWorkspace ? ` · ${sources.length} sources` : ""}</div>
  <div class="sources">${sourceList}</div>
  ${sectionHtml.join("\n")}
  <footer>Exported ${esc(new Date().toLocaleString())}</footer>
</body>
</html>`;
}
