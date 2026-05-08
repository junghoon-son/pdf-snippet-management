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
import { TauriStore } from "./storage/tauri-store.js";
import { FsaStore } from "./storage/fsa-store.js";
import { computeMarkRank, rankPercentiles } from "./markrank.js";
import { buildPermalink, parsePermalink } from "./marklee-permalink.js";
import { GROUP_TEMPLATES, findTemplate } from "./group-templates.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
const fsaStore = IS_TAURI ? null : new FsaStore();
setStore(IS_TAURI ? new TauriStore() : fsaStore);
document.body.dataset.runtime = IS_TAURI ? "tauri" : "web";

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
        filters: [{ name: "Documents", extensions: ["pdf", "md", "markdown", "docx"] }],
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

const FLOW_EXTS = ["md", "markdown"];
function detectKindFromPath(path) {
  const m = (path || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return "pdf";
  const ext = m[1];
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "docx") return "docx";
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
  source: { path: "", filename: "", title: "", author: "", kind: "pdf" },
  view: "list",
  layout: "group",
  mapScope: "doc",
  summaryScope: "doc",
  summaryFormat: "rich",
  snippetSort: (() => {
    try { return localStorage.getItem("pdf-annotator-snippet-sort") || "order"; }
    catch { return "order"; }
  })(),
};
Object.defineProperty(state, "groupsMeta", {
  configurable: true,
  enumerable: true,
  get() {
    if (!state.workspace) return [];
    if (!Array.isArray(state.workspace.groupsMeta)) state.workspace.groupsMeta = [];
    return state.workspace.groupsMeta;
  },
  set(v) {
    if (state.workspace) state.workspace.groupsMeta = Array.isArray(v) ? v : [];
  },
});
let selectedEdge = null;
let mapInitialized = false;
let lineageInitialized = false;
let rectDraw = null;
let docLoadToken = 0;
const GROUP_PALETTE_SLOTS = 8;
const clipUrlCache = new Map();
state.tool = "select";

const docTitleEl = document.getElementById("doc-title");

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
  if (!ws) return { folders: [], files: [], groupsMeta: [], theme: "cream" };
  if (!Array.isArray(ws.groupsMeta)) ws.groupsMeta = [];
  if (!ws.theme) ws.theme = "cream";
  return {
    folders: ws.folders || [],
    files: ws.files || [],
    groupsMeta: ws.groupsMeta,
    theme: ws.theme,
  };
}

function saveAllWorkspaces() {
  // Snapshot current active workspace before serializing
  const cur = state.workspaces.byId[state.workspaces.active];
  if (cur) {
    cur.files = state.workspace.files;
    cur.folders = state.workspace.folders;
    cur.groupsMeta = state.workspace.groupsMeta;
    cur.theme = state.workspace.theme || cur.theme || "cream";
    cur.currentPdfPath = state.currentPdfPath;
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

const VALID_THEMES = ["cream", "slate", "dark", "sepia", "bubblegum"];
function applyTheme(name) {
  const theme = VALID_THEMES.includes(name) ? name : "cream";
  document.body.dataset.theme = theme;
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
    groupsMeta: [],
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
    filters: [{ name: "Documents", extensions: ["pdf", "md", "markdown", "docx"] }],
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
      for (const p of removedPaths) removeRecent(p);
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
        removeRecent(p);
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

document.getElementById("theme-btn").addEventListener("click", () => {
  const cur = state.workspace.theme || "cream";
  const i = VALID_THEMES.indexOf(cur);
  const next = VALID_THEMES[(i + 1) % VALID_THEMES.length];
  setWorkspaceTheme(next);
  flashButton("theme-btn", next);
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

document.querySelectorAll("#snippet-sort .seg-btn").forEach((b) => {
  b.addEventListener("click", () => setSnippetSort(b.dataset.sort));
  b.classList.toggle("active", b.dataset.sort === state.snippetSort);
});

function setSnippetSort(sort) {
  if (sort !== "order" && sort !== "rank") return;
  state.snippetSort = sort;
  document.querySelectorAll("#snippet-sort .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.sort === sort);
  });
  try { localStorage.setItem("pdf-annotator-snippet-sort", sort); } catch {}
  renderSnippets();
}

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
      openLocalSearch();
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
});

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
  document.getElementById("local-search-clear")?.addEventListener("click", clearLocalSearch);
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
  } else if (action.type === "delete") {
    state.snippets.splice(Math.min(action.index, state.snippets.length), 0, action.snippet);
  }
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
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]"); } catch { return []; }
}

function addRecent(path) {
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

document.getElementById("clear-recents").addEventListener("click", () => {
  try { localStorage.removeItem(RECENTS_KEY); } catch {}
  renderRecents();
});

renderRecents();
renderWorkspaceTabs();
renderWorkspace();
renderGroups();

document.getElementById("groups-collapse").addEventListener("click", () => {
  document.getElementById("groups-panel").classList.toggle("collapsed");
});

document.getElementById("groups-export").addEventListener("click", exportGroups);
document.getElementById("groups-import").addEventListener("click", importGroups);
document.getElementById("groups-import-ws").addEventListener("click", importGroupsFromWorkspace);
document.getElementById("groups-template").addEventListener("click", openTemplatesModal);
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
  body.innerHTML = "";
  for (const tpl of GROUP_TEMPLATES) {
    const item = document.createElement("div");
    item.className = "tpl-item";
    const title = document.createElement("div");
    title.className = "tpl-title";
    title.textContent = tpl.name;
    const desc = document.createElement("div");
    desc.className = "tpl-desc";
    desc.textContent = tpl.description;
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
    const apply = document.createElement("button");
    apply.className = "tpl-apply";
    apply.textContent = "Apply";
    apply.addEventListener("click", () => {
      applyGroupTemplate(tpl.id);
      closeTemplatesModal();
    });
    item.append(title, desc, preview, apply);
    body.appendChild(item);
  }
  modal.hidden = false;
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
  const prev = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = prev; }, 1100);
}

const DEFAULT_GROUP = { id: "__notes__", name: "Notes" };
const DEFAULT_GROUP_SEEDED_KEY = "pdf-annotator-default-group-seeded";

const LEGACY_MIGRATED_KEY = "pdf-annotator-groups-migrated-to-ws";

(async () => {
  try {
    // One-time migration: pull legacy global groups into the active
    // workspace if it doesn't have any of its own yet.
    const alreadyMigrated = (() => {
      try { return localStorage.getItem(LEGACY_MIGRATED_KEY) === "1"; } catch { return false; }
    })();
    if (!alreadyMigrated && state.groupsMeta.length === 0) {
      let legacy = [];
      try { legacy = (await getStore().readGlobalGroups()) || []; } catch {}
      if (legacy.length > 0) {
        state.groupsMeta = legacy.map((g) => ({ ...g }));
      }
      try { localStorage.setItem(LEGACY_MIGRATED_KEY, "1"); } catch {}
    }
    const alreadySeeded = (() => {
      try { return localStorage.getItem(DEFAULT_GROUP_SEEDED_KEY) === "1"; } catch { return false; }
    })();
    if (state.groupsMeta.length === 0 && !alreadySeeded) {
      state.groupsMeta.push({ ...DEFAULT_GROUP });
      try { localStorage.setItem(DEFAULT_GROUP_SEEDED_KEY, "1"); } catch {}
    }
    saveAllWorkspaces();
    renderGroups();
  } catch (err) {
    console.warn("groups bootstrap failed", err);
  }
})();

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

  let title = filename.replace(/\.(pdf|md|markdown|docx)$/i, "");
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
  for (const g of existing.groups || []) {
    if (!state.groupsMeta.find((x) => x.id === g.id)) {
      state.groupsMeta.push({ id: g.id, name: g.name || "" });
    } else if (g.name) {
      const existingMeta = state.groupsMeta.find((x) => x.id === g.id);
      if (existingMeta && !existingMeta.name) existingMeta.name = g.name;
    }
  }
  saveAllWorkspaces();
  if (myToken !== docLoadToken) return;

  docTitleEl.textContent = state.source.title;
  docTitleEl.title = `${state.source.title}${state.source.author ? " — " + state.source.author : ""}\n${path}`;

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
  } else if (kind === "markdown") {
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
  syncHorizontalOverflow();
}

function syncHorizontalOverflow() {
  // Toggle horizontal scroll on viewer-scroll only when content actually
  // overflows. Avoids the cosmetic scrollbar at fit-width caused by
  // sub-pixel rounding while still allowing pan when zoomed in.
  requestAnimationFrame(() => {
    const overflowsX = viewerContainer.scrollWidth > viewerScroll.clientWidth + 1;
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
  } else if (state.flowDoc && (state.source.kind === "markdown" || state.source.kind === "docx")) {
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

viewerContainer.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
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
  if (state.source.kind === "markdown" || state.source.kind === "docx") {
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
  snippetsListEl.innerHTML = "";
  const isWorkspace = state.mapScope === "workspace";
  let source;
  let edgeSource;
  if (isWorkspace) {
    const data = await loadWorkspaceMapData();
    source = data.snippets;
    edgeSource = data.edges || [];
  } else {
    source = state.snippets;
    edgeSource = state.edges || [];
  }
  const rankScores = computeMarkRank(source, edgeSource);
  const rankPct = rankPercentiles(rankScores);
  const linkedIds = new Set();
  for (const e of edgeSource) { linkedIds.add(e.source); linkedIds.add(e.target); }
  let ordered = orderedSnippets(source).filter(snippetMatchesLocal);
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
          s.groups = (s.groups || []).filter((g) => g !== gid);
          await persist();
          refreshActiveView();
        });
        pill.append(dot, name, x);
        chipRow.appendChild(pill);
      }
      li.appendChild(chipRow);
    }

    const ownerPath = s._pdfPath || state.currentPdfPath;
    const isCrossDoc = isWorkspace && ownerPath && ownerPath !== state.currentPdfPath;
    const meta = document.createElement("div");
    meta.className = "meta";
    const label = document.createElement("span");
    label.className = "meta-label";
    if (isCrossDoc) {
      const docSpan = document.createElement("span");
      docSpan.className = "meta-doc";
      docSpan.textContent = (ownerPath.split("/").pop() || ownerPath);
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
          await getStore().copyImageToClipboard(ownerPath, s.imagePath);
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
    if (isCrossDoc) actions.append(share, copy);
    else actions.append(share, copy, del);
    meta.append(label, actions);

    let text;
    if (s.kind === "image") {
      text = document.createElement("div");
      text.className = "image";
      const img = document.createElement("img");
      img.alt = s.text || `clip p.${s.page}`;
      img.loading = "lazy";
      loadClipUrl(s.imagePath, ownerPath).then((url) => {
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
      text.textContent = s.text;
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
    let saveTimer;
    ta.addEventListener("input", () => {
      s.comment = ta.value;
      autoresize();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 300);
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
        persist();
      }
    });

    const pageFooter = document.createElement("span");
    pageFooter.className = "snippet-page-footer";
    pageFooter.textContent = s.anchor ? `§ ${s.anchor}` : `p.${s.page}`;
    if (s.anchor) pageFooter.title = s.anchor;

    if (isCrossDoc) {
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
  if (state.source.kind === "markdown" || state.source.kind === "docx") {
    FlowView.previewFlowSnippet(viewerContainer, s);
    return;
  }
  const wrap = viewerContainer.querySelector(`.page-wrap[data-page="${s.page}"]`);
  if (!wrap) return;
  ensurePageRendered?.(s.page);
  wrap.scrollIntoView({ behavior: "smooth", block: "center" });
  pulseSnippet(s.id);
}

function applyAllHighlights() {
  if (state.source.kind === "pdf") {
    applyHighlights(viewerContainer, state.snippets);
  } else if (state.source.kind === "markdown" || state.source.kind === "docx") {
    FlowView.applyFlowHighlights(viewerContainer, state.snippets);
  }
}

// `persist()` is debounced — multiple rapid edits coalesce into one
// sidecar write 200ms after the last call. Awaiting it returns a promise
// that resolves after the next flush completes (or rejects on error).
// Use `flushPersist()` to bypass the debounce, e.g. before close.
const PERSIST_DEBOUNCE_MS = 200;
let _persistPending = null;
let _persistResolve = null;
let _persistReject = null;
let _persistTimer = null;

function persist() {
  if (_persistPending) return _persistPending;
  _persistPending = new Promise((resolve, reject) => {
    _persistResolve = resolve;
    _persistReject = reject;
  });
  _persistTimer = setTimeout(runPersistFlush, PERSIST_DEBOUNCE_MS);
  return _persistPending;
}

async function runPersistFlush() {
  _persistTimer = null;
  const resolve = _persistResolve;
  const reject = _persistReject;
  _persistPending = null;
  _persistResolve = null;
  _persistReject = null;
  try {
    await persistImmediate();
    resolve?.();
  } catch (err) {
    reject?.(err);
  }
}

async function flushPersist() {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    await runPersistFlush();
  }
}

window.addEventListener("beforeunload", () => {
  // Best-effort flush — synchronous localStorage writes get through even
  // during unload; the async sidecar write may not, but the workspace
  // metadata save inside persistImmediate covers groupsMeta + recents.
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    runPersistFlush();
  }
});

async function persistImmediate() {
  if (!state.currentPdfPath) return;
  if (state.view === "map") {
    state.edges = MapView.getEdgesData();
    const positions = MapView.getNodePositions();
    state.snippets.forEach((s) => {
      const p = positions.get(s.id);
      if (p) s.pos = { x: p.x, y: p.y };
    });
  }
  flashSaveIndicator("saving");
  // No auto-prune here: a group unused in the current doc may still be in use elsewhere.
  // Persist workspace state (groupsMeta lives there now, not in a global file).
  saveAllWorkspaces();
  // Per-doc sidecar carries only the groups referenced by this doc's snippets,
  // so a sidecar shared standalone still has enough context.
  const usedIds = new Set();
  for (const s of state.snippets) for (const g of s.groups || []) usedIds.add(g);
  const localGroups = (state.groupsMeta || []).filter((g) => usedIds.has(g.id));
  try {
    await getStore().writeAnnot(state.currentPdfPath, {
      markleeVersion: "0.1",
      source: state.source,
      snippets: state.snippets,
      edges: state.edges,
      groups: localGroups,
    });
    flashSaveIndicator("saved");
  } catch (err) {
    console.error("[persist] writeAnnot failed", err);
    flashSaveIndicator("error");
    throw err;
  }
}

function pruneOrphanGroups() {
  const used = new Set();
  for (const s of state.snippets) for (const g of s.groups || []) used.add(g);
  state.groupsMeta = (state.groupsMeta || []).filter(
    (g) => used.has(g.id) || (g.name && g.name.trim().length > 0)
  );
}

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
  if (allPaths.length === 0) {
    return state.currentPdfPath
      ? { snippets: state.snippets.map((s) => ({ ...s, _pdfPath: state.currentPdfPath })), edges: state.edges }
      : { snippets: [], edges: [] };
  }
  const results = await Promise.all(
    allPaths.map((p) => getStore().readAnnot(p).catch(() => null)),
  );
  const snippets = [];
  const edges = [];
  for (let i = 0; i < allPaths.length; i++) {
    const r = results[i];
    if (!r) continue;
    for (const s of r.snippets || []) {
      snippets.push({ ...s, _pdfPath: allPaths[i] });
    }
    for (const e of r.edges || []) edges.push(e);
  }
  if (state.currentPdfPath && !allPaths.includes(state.currentPdfPath)) {
    for (const s of state.snippets) snippets.push({ ...s, _pdfPath: state.currentPdfPath });
    edges.push(...state.edges);
  }
  return { snippets, edges };
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
}

function renderGroups() {
  const list = document.getElementById("groups-list");
  list.innerHTML = "";
  const counts = new Map();
  for (const s of state.snippets) for (const g of s.groups || []) counts.set(g, (counts.get(g) || 0) + 1);
  const ids = (state.groupsMeta || []).map((g) => g.id);
  for (const cid of counts.keys()) if (!ids.includes(cid)) ids.push(cid);
  if (ids.length === 0) {
    const empty = document.createElement("li");
    empty.className = "groups-empty";
    empty.textContent = "No groups yet — right-click a snippet to start grouping.";
    list.appendChild(empty);
    return;
  }
  for (const id of ids) {
    const meta = (state.groupsMeta || []).find((g) => g.id === id) || { id, name: "" };
    const li = document.createElement("li");
    li.className = "group-row";
    li.dataset.groupId = id;
    const memberCount = counts.get(id) || 0;
    if (memberCount === 0) li.classList.add("empty");
    if (meta.hidden) li.classList.add("bubble-hidden");

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

    const sticker = document.createElement("button");
    sticker.type = "button";
    sticker.className = "group-row-sticker";
    sticker.title = "Click to recolor · drag onto a snippet to tag it";
    sticker.style.setProperty("--g", groupColorHex(id));
    // Click → open palette popover anchored to the sticker.
    // Drag → start sticker drag onto a snippet (handled by maybeBeginStickerDrag).
    sticker.addEventListener("pointerdown", (e) => {
      maybeBeginStickerDrag(e, id, meta, () => openColorPopover(sticker, id));
    });

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = `Group ${ids.indexOf(id) + 1}`;
    input.value = meta.name || "";
    let saveTimer;
    input.addEventListener("input", () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => renameGroup(id, input.value), 250);
    });
    input.addEventListener("blur", () => renameGroup(id, input.value));

    const count = document.createElement("span");
    count.className = "group-row-count";
    const n = counts.get(id) || 0;
    if (n === 0) {
      count.textContent = "not in this doc";
      count.dataset.short = "—";
    } else {
      count.textContent = `${n} here`;
      count.dataset.short = `${n}`;
    }

    const eye = document.createElement("button");
    eye.className = "group-row-eye";
    eye.textContent = meta.hidden ? "○" : "●";
    eye.title = meta.hidden ? "Group hidden from bubbles — click to show" : "Click to hide group from drag-bubbles";
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      setGroupHidden(id, !meta.hidden);
    });

    const del = document.createElement("button");
    del.className = "group-row-delete";
    del.textContent = "delete";
    del.title = "Delete group (snippets are preserved)";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete this group? Snippets stay, just no longer grouped.`)) return;
      await deleteGroup(id);
    });

    li.append(sticker, input, count, eye, del);
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

  let lastTarget = null;
  const setTarget = (next) => {
    if (next === lastTarget) return;
    lastTarget?.classList.remove("sticker-drop-target");
    next?.classList.add("sticker-drop-target");
    lastTarget = next;
  };
  const move = (ev) => {
    ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY - 6}px)`;
    const stack = document.elementsFromPoint(ev.clientX, ev.clientY);
    const snip = stack.find((el) => el.classList?.contains("snippet"));
    setTarget(snip || null);
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cleanup);
    document.body.classList.remove("dragging-sticker");
    setTarget(null);
    ghost.remove();
  };
  const up = async (ev) => {
    const target = lastTarget;
    cleanup();
    if (!target) return;
    const snippetId = target.dataset.snippetId;
    if (!snippetId) return;
    const snippet = state.snippets.find((s) => s.id === snippetId);
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
  return {
    snippets: state.snippets.map((s) => ({ ...s, _pdfPath: state.currentPdfPath })),
    sources: state.currentPdfPath ? [state.currentPdfPath] : [],
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

async function openSummary() {
  const modal = document.getElementById("summary-modal");
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
    const fname = (s._pdfPath || "").split("/").pop();
    itemMeta.textContent = isWorkspace && fname ? `${fname} · p.${s.page}` : `p.${s.page}`;
    const itemText = document.createElement("blockquote");
    itemText.textContent = s.text;
    item.append(itemMeta, itemText);
    if (s.comment) {
      const c = document.createElement("div");
      c.className = "summary-comment";
      c.textContent = s.comment;
      item.appendChild(c);
    }
    return item;
  };

  for (const [gid, members] of sections) {
    const groupHeader = document.createElement("div");
    groupHeader.className = "summary-group-header";
    groupHeader.style.color = groupColor(gid);
    groupHeader.textContent = `● ${groupName(gid)} (${members.length})`;
    contentEl.appendChild(groupHeader);
    for (const s of members) contentEl.appendChild(renderItem(s, gid));
  }
  if (ungrouped.length > 0) {
    if (sections.size > 0) {
      const h = document.createElement("div");
      h.className = "summary-group-header";
      h.style.color = "#6e6e6e";
      h.textContent = `unfiled (${ungrouped.length})`;
      contentEl.appendChild(h);
    }
    for (const s of ungrouped) contentEl.appendChild(renderItem(s, null));
  }

  modal.hidden = false;
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
    const fname = (s._pdfPath || "").split("/").pop();
    const ref = isWorkspace && fname ? `${fname} p.${s.page}` : `p.${s.page}`;
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
      try {
        const u8 = await getStore().readClip(s._pdfPath || state.currentPdfPath, s.imagePath);
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
    const filename = path.split("/").pop() || "?";
    const href = path ? `file://${encodeURI(path)}#page=${s.page}` : "";
    const cite = href
      ? `<a href="${esc(href)}">${esc(filename)} p.${s.page}</a>`
      : `${esc(filename)} p.${s.page}`;
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
    out.push(`<p><small>${sources.map((p) => esc(p.split("/").pop() || p)).join(" · ")}</small></p>`);
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

  const sourceList = sources.map((p) => esc(p.split("/").pop() || p)).join(" · ");

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
