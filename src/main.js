import "pdfjs-dist/web/pdf_viewer.css";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  loadDocument,
  renderPages,
  fitWidthScale,
  getSelectionSnippet,
  applyHighlights,
  renderRegionPng,
} from "./pdf-viewer.js";
import * as MapView from "./map-view.js";
import { openGroupOverlay } from "./group-overlay.js";

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
  scale: 1.5,
  snippets: [],
  edges: [],
  groupsMeta: [],
  source: { path: "", filename: "", title: "", author: "" },
  view: "list",
  layout: "page",
};
let selectedEdge = null;
let mapInitialized = false;
let rectDraw = null;
const clipUrlCache = new Map();
state.tool = "select";

const docTitleEl = document.getElementById("doc-title");

const undoStack = [];
const expandedIds = new Set();

const WORKSPACE_KEY = "pdf-annotator-workspace";
state.workspace = loadWorkspace();
const collapsedFolders = new Set();

function loadWorkspace() {
  try {
    const json = localStorage.getItem(WORKSPACE_KEY);
    if (json) {
      const parsed = JSON.parse(json);
      return { folders: parsed.folders || [], files: parsed.files || [] };
    }
  } catch {}
  return { folders: [], files: [] };
}

function saveWorkspace() {
  try { localStorage.setItem(WORKSPACE_KEY, JSON.stringify(state.workspace)); } catch {}
}

document.getElementById("open-file").addEventListener("click", async () => {
  const path = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
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
  const dir = await open({ multiple: false, directory: true });
  if (!dir) return;
  let folder = state.workspace.folders.find((f) => f.path === dir);
  const pdfs = await invoke("list_pdfs", { dir });
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
  renderWorkspace();
});

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
      state.workspace.folders = state.workspace.folders.filter((f) => f.path !== folder.path);
      saveWorkspace();
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
      li.textContent = p.split("/").pop();
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
      li.textContent = p.split("/").pop();
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
        saveWorkspace();
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

document.getElementById("zoom-in").addEventListener("click", () => setScale(state.scale * SCALE_STEP));
document.getElementById("zoom-out").addEventListener("click", () => setScale(state.scale / SCALE_STEP));
document.getElementById("zoom-fit").addEventListener("click", () => fitWidth());
document.getElementById("summary-btn").addEventListener("click", openSummary);
document.getElementById("summary-close").addEventListener("click", closeSummary);
document.getElementById("summary-copy").addEventListener("click", copySummary);
document.querySelector("#summary-modal .modal-backdrop").addEventListener("click", closeSummary);

document.querySelectorAll(".tool-btn").forEach((b) => {
  b.addEventListener("click", () => setTool(b.dataset.tool));
});

document.querySelectorAll(".tab-btn").forEach((b) => {
  b.addEventListener("click", () => switchView(b.dataset.view));
});
document.querySelectorAll("#layout-toggle .seg-btn").forEach((b) => {
  b.addEventListener("click", () => switchLayout(b.dataset.layout));
});

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
    if (e.key === "=" || e.key === "+") { e.preventDefault(); setScale(state.scale * SCALE_STEP); }
    else if (e.key === "-") { e.preventDefault(); setScale(state.scale / SCALE_STEP); }
    else if (e.key === "0") { e.preventDefault(); fitWidth(); }
    else if (e.key === "z" || e.key === "Z") {
      const tag = e.target.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      e.preventDefault();
      undo();
    }
    return;
  }
  const tag = e.target.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return;
  if (e.key === "t" || e.key === "T") setTool("select");
  else if (e.key === "r" || e.key === "R") setTool("rect");
});

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll(".tool-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === tool);
  });
  document.body.classList.toggle("tool-rect", tool === "rect");
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
  try { exists = await invoke("check_paths", { paths }); } catch { return; }
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
    name.textContent = filename;
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
renderWorkspace();

(async () => {
  try {
    const g = await invoke("read_global_groups");
    state.groupsMeta = g || [];
  } catch (err) {
    console.warn("global groups load failed", err);
  }
})();

function setActiveFile(path) {
  document.querySelectorAll("#file-list li, #recents-list li").forEach((li) => {
    li.classList.toggle("active", li.dataset.path === path);
  });
}

async function loadPdf(path) {
  state.currentPdfPath = path;
  addRecent(path);
  undoStack.length = 0;
  expandedIds.clear();
  setActiveFile(path);
  viewerEmpty.style.display = "none";
  viewerContainer.innerHTML = "";

  const bytes = await invoke("read_pdf", { path });
  const data = new Uint8Array(bytes);
  state.pdfDoc = await loadDocument(data);

  const filename = path.split("/").pop() || "";
  const meta = await state.pdfDoc.getMetadata().catch(() => null);
  const info = meta?.info || {};
  const title = (info.Title || "").trim() || filename.replace(/\.pdf$/i, "");
  const author = (info.Author || "").trim();
  const existing = await invoke("read_annot", { pdfPath: path });
  state.source = {
    path,
    filename,
    title: existing.source?.title || title,
    author: existing.source?.author || author,
  };
  state.snippets = existing.snippets || [];
  state.edges = existing.edges || [];
  // Merge any group meta from this sidecar into the global store.
  for (const g of existing.groups || []) {
    if (!state.groupsMeta.find((x) => x.id === g.id)) {
      state.groupsMeta.push({ id: g.id, name: g.name || "" });
    } else if (g.name) {
      const existingMeta = state.groupsMeta.find((x) => x.id === g.id);
      if (existingMeta && !existingMeta.name) existingMeta.name = g.name;
    }
  }
  await invoke("write_global_groups", { groups: state.groupsMeta });

  docTitleEl.textContent = state.source.title;
  docTitleEl.title = `${state.source.title}${state.source.author ? " — " + state.source.author : ""}\n${path}`;

  const fit = await fitWidthScale(state.pdfDoc, viewerScroll.clientWidth - FIT_PADDING);
  state.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fit));
  await renderPages(state.pdfDoc, viewerContainer, state.scale);
  updateZoomLabel();

  refreshActiveView();
  applyAllHighlights();
  await persist();
}

async function setScale(next) {
  const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
  if (!state.pdfDoc || Math.abs(clamped - state.scale) < 0.001) {
    state.scale = clamped;
    updateZoomLabel();
    return;
  }
  state.scale = clamped;
  updateZoomLabel();
  await renderPages(state.pdfDoc, viewerContainer, state.scale);
  applyAllHighlights();
}

async function fitWidth() {
  if (!state.pdfDoc) return;
  const next = await fitWidthScale(state.pdfDoc, viewerScroll.clientWidth - FIT_PADDING);
  await setScale(next);
}

function updateZoomLabel() {
  zoomLevelEl.textContent = `${Math.round(state.scale * 100)}%`;
}

viewerContainer.addEventListener("mousedown", (e) => {
  if (e.detail >= 2) e.preventDefault();
  if (state.tool !== "rect") return;
  const wrap = e.target.closest?.(".page-wrap");
  if (!wrap) return;
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
    pngBytes = await renderRegionPng(state.pdfDoc, page, fracRect, 4);
  } catch (err) {
    console.error("clip render failed", err);
    return;
  }
  let imagePath;
  try {
    imagePath = await invoke("write_clip", {
      pdfPath: state.currentPdfPath,
      clipId: id,
      bytes: Array.from(pngBytes),
    });
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

viewerContainer.addEventListener("mousemove", (e) => {
  const hit = hitTestHighlight(e);
  const id = hit ? hit.id : null;
  if (id !== hoverSnippetId) {
    hoverSnippetId = id;
    updateHoverClasses();
  }
  viewerContainer.style.cursor = id ? "pointer" : "";
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
  const hit = hitTestHighlight(e);
  if (!hit) return;
  const li = snippetsListEl.querySelector(`[data-snippet-id="${hit.id}"]`);
  if (!li) return;
  li.scrollIntoView({ behavior: "smooth", block: "center" });
  const ta = li.querySelector("textarea");
  if (ta) setTimeout(() => ta.focus(), 250);
});

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
  viewerContainer.querySelectorAll(".hl").forEach((el) => {
    el.classList.toggle("hover", el.dataset.snippetId === hoverSnippetId);
  });
  snippetsListEl.querySelectorAll(".snippet").forEach((li) => {
    li.classList.toggle("hover", li.dataset.snippetId === hoverSnippetId);
  });
}

viewerContainer.addEventListener("mouseup", async () => {
  const snip = getSelectionSnippet();
  if (!snip) return;
  snip.text = normalizeText(snip.text);
  if (!snip.text) return;
  if (state.snippets.some((s) => s.page === snip.page && s.text === snip.text)) {
    window.getSelection().removeAllRanges();
    return;
  }
  snip.id = crypto.randomUUID();
  snip.comment = "";
  snip.created = new Date().toISOString();
  state.snippets.push(snip);
  undoStack.push({ type: "add", id: snip.id });
  await persist();
  refreshActiveView();
  applyAllHighlights();
  window.getSelection().removeAllRanges();
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

function renderSnippets() {
  snippetsListEl.innerHTML = "";
  const ordered = orderedSnippets();
  const canonical = canonicalGroupIds();
  ordered.forEach((s) => {
    const li = document.createElement("li");
    li.className = "snippet";
    if (expandedIds.has(s.id)) li.classList.add("expanded");
    li.dataset.snippetId = s.id;
    li.setAttribute("draggable", "true");
    const groups = s.groups || [];
    if (groups.length > 0) li.classList.add("has-groups");

    if (groups.length > 0) {
      const memberSet = new Set(groups);
      const spine = document.createElement("div");
      spine.className = "group-spine";
      for (const gid of canonical) {
        if (memberSet.has(gid)) {
          const band = document.createElement("div");
          band.className = "spine-band";
          band.dataset.groupId = gid;
          band.style.background = groupColor(gid);
          band.title = groupName(gid);
          const lbl = document.createElement("span");
          lbl.className = "spine-label";
          lbl.textContent = groupName(gid);
          band.appendChild(lbl);
          const x = document.createElement("button");
          x.className = "spine-x";
          x.textContent = "×";
          x.title = `Remove from “${groupName(gid)}”`;
          x.addEventListener("click", async (e) => {
            e.stopPropagation();
            s.groups = (s.groups || []).filter((g) => g !== gid);
            await persist();
            refreshActiveView();
          });
          band.appendChild(x);
          spine.appendChild(band);
        } else {
          const spacer = document.createElement("div");
          spacer.className = "spine-band spine-band-empty";
          spine.appendChild(spacer);
        }
      }
      li.appendChild(spine);
      li.style.setProperty("--spine-cols", String(canonical.length));
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const label = document.createElement("span");
    label.className = "meta-label";
    const pageSpan = document.createElement("span");
    pageSpan.textContent = `p.${s.page}`;
    label.appendChild(pageSpan);
    const copy = document.createElement("button");
    copy.textContent = "copy";
    copy.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        if (s.kind === "image" && s.imagePath) {
          const url = await loadClipUrl(s.imagePath);
          if (url) {
            const blob = await fetch(url).then((r) => r.blob());
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          }
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
          await invoke("delete_clip", {
            pdfPath: state.currentPdfPath,
            imagePath: removed.imagePath,
          });
        } catch {}
        const cacheKey = `${state.currentPdfPath}::${removed.imagePath}`;
        const cached = clipUrlCache.get(cacheKey);
        if (cached) { URL.revokeObjectURL(cached); clipUrlCache.delete(cacheKey); }
      }
      await persist();
      refreshActiveView();
      applyAllHighlights();
    });
    const actions = document.createElement("span");
    actions.className = "actions";
    actions.append(copy, del);
    meta.append(label, actions);

    let text;
    if (s.kind === "image") {
      text = document.createElement("div");
      text.className = "image";
      const img = document.createElement("img");
      img.alt = s.text || `clip p.${s.page}`;
      img.loading = "lazy";
      loadClipUrl(s.imagePath).then((url) => {
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
      text.title = "Click to expand/collapse";
      text.addEventListener("click", (e) => {
        e.stopPropagation();
        if (expandedIds.has(s.id)) {
          expandedIds.delete(s.id);
          li.classList.remove("expanded");
        } else {
          expandedIds.add(s.id);
          li.classList.add("expanded");
        }
      });
    }

    const ta = document.createElement("textarea");
    ta.placeholder = "Add a comment…";
    ta.value = s.comment || "";
    let saveTimer;
    ta.addEventListener("input", () => {
      s.comment = ta.value;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 300);
    });

    li.append(meta, text, ta);
    li.addEventListener("click", (e) => {
      if (e.target === ta || e.target === del) return;
      scrollToSnippet(s);
    });

    let hoverPreviewTimer;
    li.addEventListener("mouseenter", () => {
      clearTimeout(hoverPreviewTimer);
      hoverPreviewTimer = setTimeout(() => previewSnippetInPdf(s), 220);
      hoverSnippetId = s.id;
      updateHoverClasses();
    });
    li.addEventListener("mouseleave", () => {
      clearTimeout(hoverPreviewTimer);
      hoverSnippetId = null;
      updateHoverClasses();
    });

    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      handleSnippetRightClick(s, e);
    });

    li.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", s.id);
      e.dataTransfer.effectAllowed = "link";
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => li.classList.remove("dragging"));
    li.addEventListener("dragover", (e) => {
      const srcId = e.dataTransfer.types.includes("text/plain");
      if (!srcId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "link";
      li.classList.add("drop-target");
    });
    li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
    li.addEventListener("drop", async (e) => {
      e.preventDefault();
      li.classList.remove("drop-target");
      const srcId = e.dataTransfer.getData("text/plain");
      if (!srcId || srcId === s.id) return;
      await linkSnippets(srcId, s.id);
    });

    snippetsListEl.appendChild(li);
  });
}

function orderedSnippets() {
  const posKey = (s) => [s.page, s.rects?.[0]?.top ?? 0, s.rects?.[0]?.left ?? 0];
  return [...state.snippets].sort((a, b) => {
    const ka = posKey(a), kb = posKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

async function handleSnippetRightClick(s, e) {
  const pane = document.getElementById("snippets-pane");
  const overlay = document.getElementById("group-overlay");
  const paneRect = pane.getBoundingClientRect();
  const result = await openGroupOverlay({
    snippet: s,
    allSnippets: state.snippets,
    allGroups: state.groupsMeta || [],
    container: overlay,
    anchor: { x: e.clientX, y: e.clientY },
    groupColor,
    groupName,
    paneRect,
  });
  if (!result) return;
  s.groups = s.groups || [];
  let createdGroupId = null;
  if (result.kind === "new") {
    const id = crypto.randomUUID();
    s.groups.push(id);
    ensureGroupMeta(id, "");
    createdGroupId = id;
  } else if (result.kind === "existing" && !s.groups.includes(result.groupId)) {
    s.groups.push(result.groupId);
  }
  await persist();
  refreshActiveView();
  applyAllHighlights();
  if (createdGroupId) {
    promptGroupName(createdGroupId);
  }
}

function promptGroupName(groupId) {
  const li = document.querySelector(`#snippets-list [data-snippet-id]`);
  const chip = document.querySelector(`#snippets-list .group-chip[data-group-id="${groupId}"]`)
    || document.querySelector(`#groups-list [data-group-id="${groupId}"] input`);
  // Defer to Groups tab: switch view, focus the input.
  switchView("groups");
  setTimeout(() => {
    const input = document.querySelector(`#groups-list [data-group-id="${groupId}"] input`);
    if (input) { input.focus(); input.select(); }
  }, 50);
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

async function loadClipUrl(path) {
  if (!path || !state.currentPdfPath) return null;
  const cacheKey = `${state.currentPdfPath}::${path}`;
  if (clipUrlCache.has(cacheKey)) return clipUrlCache.get(cacheKey);
  try {
    const bytes = await invoke("read_clip", {
      pdfPath: state.currentPdfPath,
      imagePath: path,
    });
    const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
    const url = URL.createObjectURL(blob);
    clipUrlCache.set(cacheKey, url);
    return url;
  } catch (err) {
    console.warn("clip not found:", path);
    return null;
  }
}

function groupColor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 55%)`;
}

function previewSnippetInPdf(s) {
  const wrap = viewerContainer.querySelector(`.page-wrap[data-page="${s.page}"]`);
  if (!wrap) return;
  const hl = wrap.querySelector(`.hl[data-snippet-id="${s.id}"]`);
  const target = hl || wrap;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  pulseHighlights(s.id);
}

function pulseHighlights(snippetId) {
  const els = viewerContainer.querySelectorAll(`.hl[data-snippet-id="${snippetId}"]`);
  els.forEach((el) => {
    el.classList.remove("pulse");
    void el.offsetWidth;
    el.classList.add("pulse");
  });
}

function scrollToSnippet(s) {
  const wrap = viewerContainer.querySelector(`.page-wrap[data-page="${s.page}"]`);
  if (wrap) wrap.scrollIntoView({ behavior: "smooth", block: "center" });
}

function applyAllHighlights() {
  applyHighlights(viewerContainer, state.snippets);
}

async function persist() {
  if (!state.currentPdfPath) return;
  if (state.view === "map") {
    state.edges = MapView.getEdgesData();
    const positions = MapView.getNodePositions();
    state.snippets.forEach((s) => {
      const p = positions.get(s.id);
      if (p) s.pos = { x: p.x, y: p.y };
    });
  }
  // No auto-prune here: a group unused in the current doc may still be in use elsewhere.
  // Write the global groups index (canonical).
  try {
    await invoke("write_global_groups", { groups: state.groupsMeta || [] });
  } catch (err) {
    console.warn("global groups write failed", err);
  }
  // Per-doc sidecar carries only the groups referenced by this doc's snippets,
  // so a sidecar shared standalone still has enough context.
  const usedIds = new Set();
  for (const s of state.snippets) for (const g of s.groups || []) usedIds.add(g);
  const localGroups = (state.groupsMeta || []).filter((g) => usedIds.has(g.id));
  await invoke("write_annot", {
    pdfPath: state.currentPdfPath,
    payload: {
      source: state.source,
      snippets: state.snippets,
      edges: state.edges,
      groups: localGroups,
    },
  });
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
    state.groupsMeta.push({ id, name });
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
  state.view = view;
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
  });
  const isMap = view === "map";
  const isGroups = view === "groups";
  const isList = view === "list";
  document.getElementById("snippets-list").hidden = !isList;
  document.getElementById("groups-list").hidden = !isGroups;
  document.getElementById("map-view").hidden = !isMap;
  document.getElementById("layout-toggle").hidden = !isMap;
  if (isMap) {
    requestAnimationFrame(() => {
      if (!mapInitialized) {
        MapView.initMap(document.getElementById("cy"), {
          onChange: persist,
          onSelectEdge: handleEdgeSelection,
          groupName,
        });
        mapInitialized = true;
      }
      MapView.resize();
      MapView.renderMap(state.snippets, state.edges, state.layout);
    });
  } else if (isGroups) {
    renderGroups();
  } else {
    renderSnippets();
  }
}

function refreshActiveView() {
  if (state.view === "map" && mapInitialized) {
    MapView.renderMap(state.snippets, state.edges, state.layout);
  } else if (state.view === "groups") {
    renderGroups();
  } else {
    renderSnippets();
  }
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

    const dot = document.createElement("span");
    dot.className = "group-row-dot";
    dot.style.background = groupColor(id);

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
    count.textContent = n === 0 ? "not in this doc" : `${n} here`;

    const del = document.createElement("button");
    del.className = "group-row-delete";
    del.textContent = "delete";
    del.title = "Delete group (snippets are preserved)";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete this group? Snippets stay, just no longer grouped.`)) return;
      await deleteGroup(id);
    });

    li.append(dot, input, count, del);
    list.appendChild(li);
  }
}

function switchLayout(layout) {
  state.layout = layout;
  document.querySelectorAll("#layout-toggle .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.layout === layout);
  });
  MapView.renderMap(state.snippets, state.edges, state.layout);
}

function handleEdgeSelection(edge) {
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

function openSummary() {
  const modal = document.getElementById("summary-modal");
  const titleEl = document.getElementById("summary-title");
  const metaEl = document.getElementById("summary-meta");
  const contentEl = document.getElementById("summary-content");

  titleEl.textContent = state.source.title || "Summary";
  metaEl.textContent = [
    state.source.author,
    `${state.snippets.length} snippet${state.snippets.length === 1 ? "" : "s"}`,
  ].filter(Boolean).join(" · ");

  contentEl.innerHTML = "";
  const ordered = orderedSnippets();

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
    itemMeta.textContent = `p.${s.page}`;
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
    groupHeader.textContent = `● group (${members.length})`;
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
  if (state.source.title) lines.push(state.source.title);
  if (state.source.author) lines.push(state.source.author);
  if (lines.length) lines.push("");

  const ordered = orderedSnippets();
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
  const writeSnippet = (s) => {
    lines.push(`[p.${s.page}] "${s.text}"`);
    if (s.comment) lines.push(`  → ${s.comment}`);
    lines.push("");
  };
  let i = 0;
  for (const [, members] of sections) {
    lines.push(`— group ${++i} —`);
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
