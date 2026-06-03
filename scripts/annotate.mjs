#!/usr/bin/env bun
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  sidecarPath,
  resolveSidecar,
  ensureStoreDir,
  groupsPath,
} from "./marklee-paths.mjs";

const HELP = `Usage:
  bun run annotate <command> [options]

Supported file types: PDF, Markdown (.md, .markdown), Word (.docx — GUI-only for capture).

Read commands (JSON to stdout):
  list-snippets <file>                         All snippets for this document
  list-groups                                  All known groups (global meta)
  get-snippet <file> <snippet-id>              One snippet
  find-text <pdf> --page N --query "text"      [PDF only] Locate text on a page
  find-text-flow <md> --query "text"           [MD] Locate text in source; returns context windows
  highlight <pdf> --page N --query "text" ...  [PDF] one-shot find-text + add-text
  highlight-flow <md> --query "text" [...]     [MD] one-shot find-text-flow + add-text-flow
  export-for-llm <file>                        Markdown view of the sidecar
                                               (snippets + lineage + ranks)
                                               optimized for LLM consumption

Write commands (JSON ack to stdout):
  add-text <pdf> --page N --rect L,T,W,H... --text "..." [...]
  add-text-flow <md> --text "..." --context-before "..." --context-after "..."
                  [--anchor "..."] [--comment "..."] [--group ID|NAME]...
  update-snippet <file> <snippet-id> [...]
  delete-snippet <file> <snippet-id>

  create-group --name "..." [--color "#hex"] [--id UUID]
  rename-group <id> --name "..."
  set-group-color <id> --color "#hex"
  hide-group <id>
  unhide-group <id>
  delete-group <id>

HTTP API:
  serve [--port 1421] [--host 127.0.0.1] [--key SECRET] [--cors ORIGIN]
                  Starts a JSON HTTP server. Each subcommand is exposed at
                  POST /annotate/<command> with body matching CLI flags
                  (positional args become named keys: file, id).
                  Defaults: binds to loopback only, no CORS, no auth required.
                  Non-loopback hosts (0.0.0.0) require --key for safety.
                  --cors '*' or --cors http://app.example.com to allow browser
                  callers (sends matching Allow-Origin headers).
                  GET /health and GET /routes for introspection.

Notes:
  PDF rects are fractional L,T,W,H 0..1 relative to a page. Repeat --rect for multi-line.
  In HTTP, send rects as [[L,T,W,H], ...] or [{left, top, width, height}, ...].
  Markdown anchors via {text, contextBefore, contextAfter}; the GUI resolves them at render.
  --group can be id or name (case-insensitive); names auto-create groups.
`;

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

let throwOnDie = false;

function die(msg, code = 1) {
  if (throwOnDie) throw new CliError(msg, code);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const repeatable = new Set(["rect", "group", "add-group", "remove-group"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[++i];
      if (repeatable.has(key)) {
        flags[key] = flags[key] || [];
        flags[key].push(val);
      } else {
        flags[key] = val;
      }
    } else if (a === "-h" || a === "--help") {
      flags.help = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function parseRect(s) {
  const parts = s.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    die(`bad --rect "${s}" (expected L,T,W,H as numbers)`);
  }
  const [left, top, width, height] = parts;
  return { left, top, width, height };
}

function newId() {
  return crypto.randomUUID();
}

async function loadJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch (err) {
    die(`failed to parse ${p}: ${err.message}`);
  }
}

async function writeJsonPretty(p, obj) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(obj, null, 2));
}

async function readAnnot(pdfPath) {
  if (!existsSync(pdfPath)) die(`pdf not found: ${pdfPath}`);
  // Prefer the new .marklee/ sidecar; fall back to a legacy next-to-file one.
  const existing = resolveSidecar(pdfPath);
  const af = await loadJson(existing || sidecarPath(pdfPath), {
    source: { path: pdfPath, filename: path.basename(pdfPath), title: "", author: "" },
    snippets: [],
    edges: [],
    groups: [],
  });
  af.snippets = af.snippets || [];
  af.edges = af.edges || [];
  af.groups = af.groups || [];
  af.source = af.source || { path: pdfPath, filename: path.basename(pdfPath) };
  return af;
}

async function writeAnnot(pdfPath, af) {
  await ensureStoreDir(pdfPath);
  await writeJsonPretty(sidecarPath(pdfPath), af);
}

async function readGlobalGroups() {
  return await loadJson(groupsPath(), []);
}

async function writeGlobalGroups(groups) {
  await writeJsonPretty(groupsPath(), groups);
}

function findGroupId(groups, idOrName) {
  if (!idOrName) return null;
  const direct = groups.find((g) => g.id === idOrName);
  if (direct) return direct.id;
  const byName = groups.find(
    (g) => (g.name || "").toLowerCase() === idOrName.toLowerCase(),
  );
  return byName ? byName.id : null;
}

async function resolveOrCreateGroup(groups, idOrName) {
  let id = findGroupId(groups, idOrName);
  if (id) return { id, created: false };
  // Treat as a new group with this name
  const newG = { id: newId(), name: idOrName, color: null };
  groups.push(newG);
  return { id: newG.id, created: true };
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2));
  process.stdout.write("\n");
}

// ---- read commands ----

async function cmdListSnippets({ positional }) {
  const pdf = positional[0];
  if (!pdf) die("missing <pdf>");
  const af = await readAnnot(pdf);
  out({
    pdfPath: pdf,
    source: af.source,
    count: af.snippets.length,
    snippets: af.snippets,
  });
}

async function cmdGetSnippet({ positional }) {
  const [pdf, id] = positional;
  if (!pdf || !id) die("usage: get-snippet <pdf> <snippet-id>");
  const af = await readAnnot(pdf);
  const s = af.snippets.find((x) => x.id === id);
  if (!s) die(`snippet not found: ${id}`);
  out(s);
}

async function cmdListGroups() {
  const groups = await readGlobalGroups();
  out({ count: groups.length, groups });
}

// ---- LLM-friendly export ----
// Emits Markdown optimized for paste-into-LLM consumption: each snippet as
// a labeled block with quote + comment + groups + rank + page anchor; a
// lineage section listing labeled edges as natural-language statements.
async function cmdExportForLLM({ positional, flags }) {
  const file = positional[0];
  if (!file) die("missing <file>");
  const af = await readAnnot(file);
  const allGroups = await readGlobalGroups();
  const groupNameById = new Map();
  for (const g of (af.groups || [])) groupNameById.set(g.id, g.name || g.id.slice(0, 6));
  for (const g of allGroups) if (!groupNameById.has(g.id)) groupNameById.set(g.id, g.name || g.id.slice(0, 6));

  const snippets = af.snippets || [];
  const edges = af.edges || [];
  const ranks = computeMarkRank(snippets, edges);

  const idToIndex = new Map();
  snippets.forEach((s, i) => idToIndex.set(s.id, i + 1));

  const lines = [];
  const src = af.source || {};
  lines.push(`# Marklee notes — ${src.filename || path.basename(file)}`);
  if (src.title) lines.push(`**Title**: ${src.title}`);
  if (src.author) lines.push(`**Author**: ${src.author}`);
  if (src.contentHash) lines.push(`**Content hash**: \`${src.contentHash}\``);
  lines.push(`**Snippets**: ${snippets.length}  ·  **Edges**: ${edges.length}`);
  lines.push("");

  if (snippets.length === 0) {
    lines.push("_No snippets in this sidecar._");
  } else {
    lines.push("## Snippets");
    lines.push("");
    snippets.forEach((s, i) => {
      const idx = i + 1;
      const anchor = s.anchor ? `§ ${s.anchor}` : `p.${s.page ?? 1}`;
      const groups = (s.groups || []).map((gid) => groupNameById.get(gid) || gid).join(" · ") || "—";
      const rank = ranks.get(s.id) ?? 0;
      lines.push(`### #${idx} · ${anchor}`);
      if (s.kind === "image") {
        lines.push(`*[image clip${s.imagePath ? `: ${s.imagePath}` : ""}]*`);
      } else {
        const text = (s.text || "").trim();
        for (const ln of text.split("\n")) lines.push(`> ${ln || ""}`);
      }
      if (s.contextBefore || s.contextAfter) {
        lines.push("");
        if (s.contextBefore) lines.push(`*Before*: ${truncate(s.contextBefore, 160)}`);
        if (s.contextAfter)  lines.push(`*After*: ${truncate(s.contextAfter, 160)}`);
      }
      if (s.comment && s.comment.trim()) {
        lines.push("");
        lines.push(`**Note**: ${s.comment.trim()}`);
      }
      lines.push(`**Groups**: ${groups}`);
      if (rank > 0) lines.push(`**MarkRank**: ${(rank * 100).toFixed(2)}`);
      lines.push("");
    });
  }

  if (edges.length > 0) {
    lines.push("## Lineage");
    lines.push("");
    for (const e of edges) {
      const a = idToIndex.get(e.source);
      const b = idToIndex.get(e.target);
      if (!a || !b) continue;
      const verb = e.label && e.label.trim() ? e.label.trim() : "→";
      lines.push(`- Snippet #${a} **${verb}** Snippet #${b}`);
    }
    lines.push("");
  }

  process.stdout.write(lines.join("\n"));
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Local PageRank — duplicates src/markrank.js for CLI use without bundler.
function computeMarkRank(snippets, edges) {
  const damping = 0.85;
  const tolerance = 1e-7;
  const maxIter = 100;
  const N = snippets.length;
  if (N === 0) return new Map();
  const idx = new Map();
  for (let i = 0; i < N; i++) idx.set(snippets[i].id, i);
  const out = Array.from({ length: N }, () => []);
  const inAdj = Array.from({ length: N }, () => []);
  for (const e of edges || []) {
    const s = idx.get(e.source), t = idx.get(e.target);
    if (s == null || t == null || s === t) continue;
    out[s].push(t);
    inAdj[t].push(s);
  }
  let rank = new Float64Array(N);
  for (let i = 0; i < N; i++) rank[i] = 1 / N;
  const next = new Float64Array(N);
  const teleport = (1 - damping) / N;
  for (let iter = 0; iter < maxIter; iter++) {
    let dangling = 0;
    for (let i = 0; i < N; i++) if (out[i].length === 0) dangling += rank[i];
    const danglingShare = (damping * dangling) / N;
    let diff = 0;
    for (let i = 0; i < N; i++) {
      let inflow = 0;
      const incoming = inAdj[i];
      for (let k = 0; k < incoming.length; k++) {
        const j = incoming[k];
        inflow += rank[j] / out[j].length;
      }
      next[i] = teleport + danglingShare + damping * inflow;
      diff += Math.abs(next[i] - rank[i]);
    }
    [rank] = [Float64Array.from(next), rank];
    if (diff < tolerance) break;
  }
  const result = new Map();
  for (let i = 0; i < N; i++) result.set(snippets[i].id, rank[i]);
  return result;
}

// ---- write commands ----

async function cmdAddText({ positional, flags }) {
  const pdf = positional[0];
  if (!pdf) die("missing <pdf>");
  const page = parseInt(flags.page, 10);
  if (Number.isNaN(page) || page < 1) die("--page <N> required (1-indexed)");
  const text = flags.text;
  if (!text) die('--text "..." required');
  if (!flags.rect || flags.rect.length === 0) die("at least one --rect L,T,W,H required");
  const rects = flags.rect.map(parseRect);
  const id = flags.id || newId();

  const af = await readAnnot(pdf);
  const groups = await readGlobalGroups();

  let groupIds = [];
  let newGroups = [];
  if (flags.group && flags.group.length > 0) {
    for (const g of flags.group) {
      const r = await resolveOrCreateGroup(groups, g);
      groupIds.push(r.id);
      if (r.created) newGroups.push(g);
    }
  }

  const snippet = {
    id,
    page,
    kind: "text",
    text,
    rects,
    comment: flags.comment || "",
    created: new Date().toISOString(),
    groups: groupIds,
  };
  af.snippets.push(snippet);

  // Mirror group meta into local annot file (match GUI behavior)
  for (const gid of groupIds) {
    if (!af.groups.find((g) => g.id === gid)) {
      const meta = groups.find((g) => g.id === gid);
      if (meta) af.groups.push({ id: meta.id, name: meta.name || "", color: meta.color || null });
    }
  }

  await writeAnnot(pdf, af);
  if (newGroups.length > 0) await writeGlobalGroups(groups);

  out({ ok: true, snippet, createdGroups: newGroups });
}

async function cmdUpdateSnippet({ positional, flags }) {
  const [pdf, id] = positional;
  if (!pdf || !id) die("usage: update-snippet <pdf> <snippet-id> [--comment ...] [--add-group ...] [--remove-group ...] [--text ...]");
  const af = await readAnnot(pdf);
  const s = af.snippets.find((x) => x.id === id);
  if (!s) die(`snippet not found: ${id}`);
  const groups = await readGlobalGroups();

  if (typeof flags.comment === "string") s.comment = flags.comment;
  if (typeof flags.text === "string") s.text = flags.text;

  s.groups = s.groups || [];
  let newGroups = [];
  if (flags["add-group"]) {
    for (const g of flags["add-group"]) {
      const r = await resolveOrCreateGroup(groups, g);
      if (!s.groups.includes(r.id)) s.groups.push(r.id);
      if (r.created) newGroups.push(g);
    }
  }
  if (flags["remove-group"]) {
    for (const g of flags["remove-group"]) {
      const gid = findGroupId(groups, g);
      if (gid) s.groups = s.groups.filter((x) => x !== gid);
    }
  }

  // Mirror group meta as needed
  for (const gid of s.groups) {
    if (!af.groups.find((g) => g.id === gid)) {
      const meta = groups.find((g) => g.id === gid);
      if (meta) af.groups.push({ id: meta.id, name: meta.name || "", color: meta.color || null });
    }
  }

  await writeAnnot(pdf, af);
  if (newGroups.length > 0) await writeGlobalGroups(groups);
  out({ ok: true, snippet: s, createdGroups: newGroups });
}

async function cmdDeleteSnippet({ positional }) {
  const [pdf, id] = positional;
  if (!pdf || !id) die("usage: delete-snippet <pdf> <snippet-id>");
  const af = await readAnnot(pdf);
  const idx = af.snippets.findIndex((x) => x.id === id);
  if (idx < 0) die(`snippet not found: ${id}`);
  const [removed] = af.snippets.splice(idx, 1);
  await writeAnnot(pdf, af);
  out({ ok: true, deleted: removed });
}

// ---- groups ----

async function cmdCreateGroup({ flags }) {
  if (!flags.name) die('--name "..." required');
  const groups = await readGlobalGroups();
  if (groups.find((g) => (g.name || "").toLowerCase() === flags.name.toLowerCase())) {
    die(`group with name "${flags.name}" already exists`);
  }
  const g = { id: flags.id || newId(), name: flags.name };
  if (flags.color) g.color = flags.color;
  groups.push(g);
  await writeGlobalGroups(groups);
  out({ ok: true, group: g });
}

async function cmdRenameGroup({ positional, flags }) {
  const id = positional[0];
  if (!id || !flags.name) die("usage: rename-group <id> --name \"...\"");
  const groups = await readGlobalGroups();
  const real = findGroupId(groups, id);
  if (!real) die(`group not found: ${id}`);
  const g = groups.find((g) => g.id === real);
  g.name = flags.name;
  await writeGlobalGroups(groups);
  out({ ok: true, group: g });
}

async function cmdSetGroupColor({ positional, flags }) {
  const id = positional[0];
  if (!id || !flags.color) die("usage: set-group-color <id> --color \"#hex\"");
  const groups = await readGlobalGroups();
  const real = findGroupId(groups, id);
  if (!real) die(`group not found: ${id}`);
  const g = groups.find((g) => g.id === real);
  g.color = flags.color;
  await writeGlobalGroups(groups);
  out({ ok: true, group: g });
}

async function cmdHideGroup({ positional }, hidden) {
  const id = positional[0];
  if (!id) die(`usage: ${hidden ? "hide-group" : "unhide-group"} <id>`);
  const groups = await readGlobalGroups();
  const real = findGroupId(groups, id);
  if (!real) die(`group not found: ${id}`);
  const g = groups.find((g) => g.id === real);
  g.hidden = hidden;
  await writeGlobalGroups(groups);
  out({ ok: true, group: g });
}

async function cmdDeleteGroup({ positional }) {
  const id = positional[0];
  if (!id) die("usage: delete-group <id>");
  const groups = await readGlobalGroups();
  const real = findGroupId(groups, id);
  if (!real) die(`group not found: ${id}`);
  const removed = groups.find((g) => g.id === real);
  const next = groups.filter((g) => g.id !== real);
  await writeGlobalGroups(next);
  out({ ok: true, deleted: removed, note: "Snippets that referenced this group still reference it; remove them with update-snippet --remove-group." });
}

// ---- text location via pdfjs ----

async function cmdFindText({ positional, flags }) {
  const pdf = positional[0];
  if (!pdf) die("missing <pdf>");
  const page = parseInt(flags.page, 10);
  if (Number.isNaN(page) || page < 1) die("--page <N> required (1-indexed)");
  const query = flags.query;
  if (!query) die('--query "text" required');
  const max = parseInt(flags.max || "20", 10);

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const workerUrl = (await import("pdfjs-dist/legacy/build/pdf.worker.mjs?url")).default
    || new URL("../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const data = new Uint8Array(await readFile(pdf));
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    disableWorker: true,
  }).promise;
  if (page > doc.numPages) die(`page ${page} out of range (PDF has ${doc.numPages})`);
  const p = await doc.getPage(page);
  const viewport = p.getViewport({ scale: 1 });
  const W = viewport.width, H = viewport.height;
  const tc = await p.getTextContent();

  const items = (tc.items || []).filter((it) => "str" in it && (it.str || "").length > 0);
  const concat = items.map((it) => it.str).join(" ");
  const ql = query.toLowerCase();

  const matches = [];
  // Naive substring search on the concatenated text — index back to items
  let cursor = 0;
  let occurrences = 0;
  while (occurrences < max) {
    const i = concat.toLowerCase().indexOf(ql, cursor);
    if (i < 0) break;
    occurrences += 1;
    cursor = i + ql.length;
    // Find which items span [i, i + ql.length) using running offset
    let off = 0;
    const startEnd = [];
    for (let j = 0; j < items.length; j++) {
      const len = items[j].str.length;
      const itemStart = off;
      const itemEnd = off + len;
      const interStart = Math.max(itemStart, i);
      const interEnd = Math.min(itemEnd, i + ql.length);
      if (interEnd > interStart) startEnd.push({ index: j, item: items[j] });
      off = itemEnd + 1; // +1 for the joiner space
      if (off > i + ql.length) break;
    }
    if (startEnd.length === 0) continue;

    // Compute rects from item transforms. pdfjs uses transform [a,b,c,d,e,f] (CSS-like).
    // height is ~items[].height; width is items[].width.
    const rects = startEnd.map(({ item }) => {
      const tx = item.transform;
      const x = tx[4];
      const y = tx[5];
      const w = item.width || 0;
      const h = item.height || tx[3] || 0;
      // Convert PDF coords (origin bottom-left) → fractional viewport (origin top-left)
      const left = x / W;
      const top = (H - y - h) / H;
      const width = w / W;
      const height = h / H;
      return { left, top, width, height };
    });

    matches.push({
      page,
      text: concat.slice(i, i + ql.length),
      rects,
    });
  }

  out({
    pdfPath: pdf,
    page,
    query,
    pageWidth: W,
    pageHeight: H,
    matchCount: matches.length,
    matches,
  });
}

// ---- dispatcher ----

const COMMANDS = {
  "list-snippets": cmdListSnippets,
  "get-snippet": cmdGetSnippet,
  "list-groups": cmdListGroups,
  "add-text": cmdAddText,
  "add-text-flow": cmdAddTextFlow,
  "update-snippet": cmdUpdateSnippet,
  "delete-snippet": cmdDeleteSnippet,
  "create-group": cmdCreateGroup,
  "rename-group": cmdRenameGroup,
  "set-group-color": cmdSetGroupColor,
  "hide-group": (a) => cmdHideGroup(a, true),
  "unhide-group": (a) => cmdHideGroup(a, false),
  "delete-group": cmdDeleteGroup,
  "find-text": cmdFindText,
  "find-text-flow": cmdFindTextFlow,
  "highlight": cmdHighlight,
  "highlight-flow": cmdHighlightFlow,
  "export-for-llm": cmdExportForLLM,
  "serve": cmdServe,
};

const ROUTES = {
  "list-snippets": { fn: cmdListSnippets, positional: ["file"] },
  "get-snippet": { fn: cmdGetSnippet, positional: ["file", "id"] },
  "list-groups": { fn: cmdListGroups, positional: [] },
  "add-text": { fn: cmdAddText, positional: ["file"] },
  "add-text-flow": { fn: cmdAddTextFlow, positional: ["file"] },
  "update-snippet": { fn: cmdUpdateSnippet, positional: ["file", "id"] },
  "delete-snippet": { fn: cmdDeleteSnippet, positional: ["file", "id"] },
  "create-group": { fn: cmdCreateGroup, positional: [] },
  "rename-group": { fn: cmdRenameGroup, positional: ["id"] },
  "set-group-color": { fn: cmdSetGroupColor, positional: ["id"] },
  "hide-group": { fn: (a) => cmdHideGroup(a, true), positional: ["id"] },
  "unhide-group": { fn: (a) => cmdHideGroup(a, false), positional: ["id"] },
  "delete-group": { fn: cmdDeleteGroup, positional: ["id"] },
  "find-text": { fn: cmdFindText, positional: ["file"] },
  "find-text-flow": { fn: cmdFindTextFlow, positional: ["file"] },
  "highlight": { fn: cmdHighlight, positional: ["file"] },
  "highlight-flow": { fn: cmdHighlightFlow, positional: ["file"] },
  "export-for-llm": { fn: cmdExportForLLM, positional: ["file"] },
};

function bodyToArgs(body, route) {
  body = body || {};
  const positional = [];
  for (const key of route.positional || []) {
    if (body[key] != null) positional.push(String(body[key]));
  }
  const flags = {};
  for (const [k, v] of Object.entries(body)) {
    if ((route.positional || []).includes(k)) continue;
    if (k === "rects" && Array.isArray(v)) {
      flags.rect = v.map((r) => {
        if (Array.isArray(r)) return r.join(",");
        if (r && typeof r === "object") {
          return [r.left, r.top, r.width, r.height].join(",");
        }
        return String(r);
      });
      continue;
    }
    flags[k] = v;
  }
  return { positional, flags };
}

async function callRouteCaptured(routeName, body) {
  const route = ROUTES[routeName];
  if (!route) throw new CliError(`unknown command: ${routeName}`, 404);
  const args = bodyToArgs(body, route);
  let buf = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { buf += String(chunk); return true; };
  const prevThrow = throwOnDie;
  throwOnDie = true;
  try {
    await route.fn(args);
  } finally {
    process.stdout.write = origWrite;
    throwOnDie = prevThrow;
  }
  if (!buf) return null;
  try { return JSON.parse(buf); } catch { return { raw: buf }; }
}

async function cmdServe({ flags }) {
  const port = parseInt(flags.port || "1421", 10);
  const host = flags.host || "127.0.0.1";
  const apiKey = flags.key || process.env.ANNOTATE_API_KEY || "";
  const corsOrigin = flags.cors || "";
  if (typeof Bun === "undefined") {
    throw new CliError("`serve` requires Bun runtime");
  }
  if ((host === "0.0.0.0" || host === "::") && !apiKey) {
    throw new CliError("refusing to bind a non-loopback host without --key (would expose write API)");
  }

  const corsFor = (req) => {
    if (!corsOrigin) return {};
    const reqOrigin = req.headers.get("origin") || "";
    const allow = corsOrigin === "*" ? "*" : (reqOrigin === corsOrigin ? reqOrigin : "");
    if (!allow) return {};
    return {
      "Access-Control-Allow-Origin": allow,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
      "Vary": "Origin",
    };
  };

  Bun.serve({
    port,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsFor(req) });
      }
      if (apiKey && req.headers.get("x-api-key") !== apiKey) {
        return jsonResponse({ ok: false, error: { code: "unauthorized", message: "missing or wrong x-api-key" } }, 401, corsFor(req));
      }

      if (url.pathname === "/health") return jsonResponse({ ok: true }, 200, corsFor(req));
      if (url.pathname === "/routes") return jsonResponse({ routes: Object.keys(ROUTES) }, 200, corsFor(req));

      const m = url.pathname.match(/^\/annotate\/([a-z][a-z0-9-]*)\/?$/);
      if (!m) return jsonResponse({ ok: false, error: { code: "not_found", message: "unknown path" } }, 404, corsFor(req));
      const routeName = m[1];
      if (!ROUTES[routeName]) {
        return jsonResponse({ ok: false, error: { code: "not_found", message: `unknown command: ${routeName}` } }, 404, corsFor(req));
      }

      let body = {};
      if (req.method !== "GET") {
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ ok: false, error: { code: "bad_request", message: "expected JSON body" } }, 400, corsFor(req));
        }
      } else {
        body = Object.fromEntries(url.searchParams.entries());
      }

      try {
        const result = await callRouteCaptured(routeName, body);
        return jsonResponse(result ?? { ok: true }, 200, corsFor(req));
      } catch (err) {
        if (err instanceof CliError) {
          return jsonResponse({ ok: false, error: { code: "cli_error", message: err.message } }, 400, corsFor(req));
        }
        console.error("server error:", err);
        return jsonResponse({ ok: false, error: { code: "internal", message: String(err?.message || err) } }, 500, corsFor(req));
      }
    },
  });
  process.stderr.write(`annotate API listening on http://${host}:${port}\n`);
  process.stderr.write(`  routes: ${Object.keys(ROUTES).join(", ")}\n`);
  process.stderr.write(`  auth: ${apiKey ? "x-api-key required" : "none (loopback only)"}\n`);
  process.stderr.write(`  cors: ${corsOrigin || "off (same-process clients only)"}\n`);
  await new Promise(() => {});
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

const CONTEXT_LEN = 40;

function detectKindFromPath(p) {
  const m = (p || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return "pdf";
  const ext = m[1];
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "docx") return "docx";
  return "pdf";
}

function normalizeFlowText(s) {
  return String(s || "")
    .replace(/[­]/g, "")
    .replace(/[ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function cmdFindTextFlow({ positional, flags }) {
  const file = positional[0];
  if (!file) die("missing <markdown-file>");
  const kind = detectKindFromPath(file);
  if (kind === "docx") die("find-text-flow on .docx not supported via CLI (binary source). Use the GUI to capture, or extract text first.");
  if (kind !== "markdown") die(`find-text-flow expects a .md file (got kind=${kind})`);
  const query = flags.query;
  if (!query) die('--query "text" required');
  const max = parseInt(flags.max || "20", 10);
  const text = await readFile(file, "utf8");
  const matches = [];
  let from = 0;
  while (matches.length < max) {
    const idx = text.indexOf(query, from);
    if (idx < 0) break;
    matches.push({
      index: idx,
      contextBefore: text.slice(Math.max(0, idx - CONTEXT_LEN), idx),
      contextAfter: text.slice(idx + query.length, idx + query.length + CONTEXT_LEN),
    });
    from = idx + Math.max(1, query.length);
  }
  out({ filePath: file, query, matchCount: matches.length, matches });
}

async function cmdAddTextFlow({ positional, flags }) {
  const file = positional[0];
  if (!file) die("missing <file>");
  const kind = detectKindFromPath(file);
  if (kind !== "markdown" && kind !== "docx") die(`add-text-flow expects .md or .docx (got kind=${kind})`);
  const text = flags.text;
  if (!text) die('--text "..." required');
  const id = flags.id || newId();

  const af = await readAnnot(file);
  const groups = await readGlobalGroups();

  let groupIds = [];
  let newGroups = [];
  if (flags.group && flags.group.length > 0) {
    for (const g of flags.group) {
      const r = await resolveOrCreateGroup(groups, g);
      groupIds.push(r.id);
      if (r.created) newGroups.push(g);
    }
  }

  let flowPos;
  if (kind === "markdown") {
    try {
      const sourceText = await readFile(file, "utf8");
      flowPos = sourceText.indexOf(text);
      if (flowPos < 0) flowPos = undefined;
    } catch {}
  }

  const snippet = {
    id,
    page: 1,
    kind: "text",
    text,
    rects: [],
    comment: flags.comment || "",
    created: new Date().toISOString(),
    groups: groupIds,
    contextBefore: flags["context-before"] || "",
    contextAfter: flags["context-after"] || "",
    anchor: flags.anchor || null,
    textNormalized: normalizeFlowText(text),
    ...(typeof flowPos === "number" ? { flowPos } : {}),
  };
  af.snippets.push(snippet);
  af.source = af.source || { path: file, filename: path.basename(file) };
  af.source.kind = af.source.kind || kind;

  for (const gid of groupIds) {
    if (!af.groups.find((g) => g.id === gid)) {
      const meta = groups.find((g) => g.id === gid);
      if (meta) af.groups.push({ id: meta.id, name: meta.name || "", color: meta.color || null });
    }
  }

  await writeAnnot(file, af);
  if (newGroups.length > 0) await writeGlobalGroups(groups);

  out({ ok: true, snippet, createdGroups: newGroups });
}

async function cmdHighlightFlow({ positional, flags }) {
  const file = positional[0];
  if (!file) die("missing <file>");
  if (detectKindFromPath(file) !== "markdown") die("highlight-flow expects a .md file");
  const query = flags.query;
  if (!query) die('--query "text" required');
  const occurrence = parseInt(flags.occurrence || "1", 10);

  const findResult = await runCapture(cmdFindTextFlow, {
    positional: [file],
    flags: { query, max: String(Math.max(1, occurrence)) },
  });
  if (!findResult.matches || findResult.matches.length === 0) {
    die(`no match for "${query}" in ${file}`);
  }
  const match = findResult.matches[occurrence - 1] || findResult.matches[0];

  await cmdAddTextFlow({
    positional: [file],
    flags: {
      text: flags.text || query,
      "context-before": match.contextBefore,
      "context-after": match.contextAfter,
      anchor: flags.anchor,
      comment: flags.comment,
      group: flags.group,
      id: flags.id,
    },
  });
}

async function cmdHighlight({ positional, flags }) {
  const pdf = positional[0];
  if (!pdf) die("missing <pdf>");
  const page = parseInt(flags.page, 10);
  if (Number.isNaN(page) || page < 1) die("--page <N> required (1-indexed)");
  const query = flags.query;
  if (!query) die('--query "text" required');
  const occurrence = parseInt(flags.occurrence || "1", 10);

  const findArgs = { positional: [pdf], flags: { page: String(page), query, max: String(Math.max(1, occurrence)) } };
  const findResult = await runCapture(cmdFindText, findArgs);
  if (!findResult.matches || findResult.matches.length === 0) {
    die(`no match for "${query}" on page ${page}`);
  }
  const match = findResult.matches[occurrence - 1] || findResult.matches[0];
  const rectFlags = match.rects.map((r) => `${r.left},${r.top},${r.width},${r.height}`);

  const addArgs = {
    positional: [pdf],
    flags: {
      page: String(page),
      text: flags.text || match.text,
      rect: rectFlags,
      comment: flags.comment,
      group: flags.group,
      id: flags.id,
    },
  };
  await cmdAddText(addArgs);
}

async function runCapture(fn, args) {
  let buf = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { buf += String(chunk); return true; };
  try {
    await fn(args);
  } finally {
    process.stdout.write = origWrite;
  }
  return JSON.parse(buf);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const cmd = argv[0];
  const fn = COMMANDS[cmd];
  if (!fn) die(`unknown command: ${cmd}\n\n${HELP}`);
  const parsed = parseArgs(argv.slice(1));
  if (parsed.flags.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  await fn(parsed);
}

main().catch((err) => {
  process.stderr.write(`error: ${err.message || err}\n`);
  process.exit(1);
});
