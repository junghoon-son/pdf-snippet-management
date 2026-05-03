#!/usr/bin/env bun
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const HELP = `Usage:
  bun run annotate <command> [options]

Read commands (JSON to stdout):
  list-snippets <pdf>                          All snippets in this PDF
  list-groups                                  All known groups (global meta)
  get-snippet <pdf> <snippet-id>               One snippet
  find-text <pdf> --page N --query "text"      Locate text on a page; returns rects
  highlight <pdf> --page N --query "text" [--group ID|NAME]... [--occurrence K] [--comment "..."]
                  One-shot: locate text + create snippet (uses find-text rects)

Write commands (JSON ack to stdout):
  add-text <pdf> --page N --rect L,T,W,H... --text "..."
                  [--comment "..."] [--group ID|NAME]... [--id UUID]
  update-snippet <pdf> <snippet-id>
                  [--comment "..."] [--add-group ID|NAME]... [--remove-group ID|NAME]...
                  [--text "..."]
  delete-snippet <pdf> <snippet-id>

  create-group --name "..." [--color "#hex"] [--id UUID]
  rename-group <id> --name "..."
  set-group-color <id> --color "#hex"
  hide-group <id>
  unhide-group <id>
  delete-group <id>

Notes:
  --rect L,T,W,H is fractional (each value 0..1 relative to the page).
  Multiple --rect flags = multiple rect spans (e.g. multi-line text).
  --group can be passed by id or by name (case-insensitive). Repeat for multi-membership.
  Group references that don't exist are auto-created when used as a name.
`;

function die(msg, code = 1) {
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

function sidecarPath(pdfPath) {
  return pdfPath + ".annot.json";
}

function globalGroupsPath() {
  return path.join(process.env.HOME || os.homedir(), ".pdf-annotator", "groups.json");
}

async function readAnnot(pdfPath) {
  if (!existsSync(pdfPath)) die(`pdf not found: ${pdfPath}`);
  const af = await loadJson(sidecarPath(pdfPath), {
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
  await writeJsonPretty(sidecarPath(pdfPath), af);
}

async function readGlobalGroups() {
  return await loadJson(globalGroupsPath(), []);
}

async function writeGlobalGroups(groups) {
  await writeJsonPretty(globalGroupsPath(), groups);
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
  "update-snippet": cmdUpdateSnippet,
  "delete-snippet": cmdDeleteSnippet,
  "create-group": cmdCreateGroup,
  "rename-group": cmdRenameGroup,
  "set-group-color": cmdSetGroupColor,
  "hide-group": (a) => cmdHideGroup(a, true),
  "unhide-group": (a) => cmdHideGroup(a, false),
  "delete-group": cmdDeleteGroup,
  "find-text": cmdFindText,
  "highlight": cmdHighlight,
};

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
