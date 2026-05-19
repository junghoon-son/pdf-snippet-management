#!/usr/bin/env bun
// Marklee headless AI batch — run the Reader against one PDF or a folder
// of PDFs, write verified highlights into each sidecar, and emit a
// self-contained per-doc HTML report.
//
// Anthropic-only for v1 (uses the Messages API's native PDF input —
// no canvas / vision rendering needed in CLI). API key from env:
//   ANTHROPIC_API_KEY=sk-ant-... bun run scripts/ai-batch.mjs "..." papers/
//
// SPEC §4 anchoring (DOM-free path) is reused via src/ai/resolver.js
// `findInFlat` to verify every returned quote against the PDF's text
// content. Unverified text quotes drop to "orphan" — image-kind
// suggestions are accepted as-is using the model's rect.

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { findInFlat, computeLineRects } from "../src/ai/resolver.js";
import { READER_SYSTEM, READER_TOOL } from "../src/ai/reader-prompt.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = 16384;
const CONTEXT_LEN = 40;

const HELP = `Usage:
  bun run scripts/ai-batch.mjs "<query>" <pdf-or-folder> [options]

Runs the AI Reader against one or many PDFs. Verified highlights are
appended to each PDF's .annot.json sidecar and a per-doc HTML report
is written next to it. For folders, a single ai-batch-index.html
links to every per-doc report.

Options:
  --json          Emit each doc's highlights as JSON to stdout (in addition
                  to writing sidecars + HTML reports)
  --dry-run       Skip sidecar writes (still writes HTML reports)
  --no-html       Skip HTML reports
  --model <id>    Anthropic model (default: ${DEFAULT_MODEL})
  --group <name>  Tag every accepted snippet with this group (created if new)
  --filter <ext>  Folder mode: limit to this extension (default: pdf)
  -h, --help      Show this help

Requires ANTHROPIC_API_KEY in env.
`;

// READER_SYSTEM + READER_TOOL imported from src/ai/reader-prompt.js
// (shared with the Tauri app's reader.js — single source of truth).

function parseArgs(argv) {
  const a = {
    query: null,
    target: null,
    json: false,
    dryRun: false,
    html: true,
    model: DEFAULT_MODEL,
    group: null,
    filter: "pdf",
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") a.json = true;
    else if (arg === "--dry-run") a.dryRun = true;
    else if (arg === "--no-html") a.html = false;
    else if (arg === "--model") a.model = argv[++i];
    else if (arg === "--group") a.group = argv[++i];
    else if (arg === "--filter") a.filter = argv[++i];
    else if (arg === "-h" || arg === "--help") return null;
    else rest.push(arg);
  }
  [a.query, a.target] = rest;
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args || !args.query || !args.target) {
    process.stderr.write(HELP);
    process.exit(args ? 1 : 0);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write("error: ANTHROPIC_API_KEY not set\n");
    process.exit(1);
  }

  const pdfs = await resolveTargets(args.target, args.filter);
  if (!pdfs.length) {
    process.stderr.write(`error: no .${args.filter} files at ${args.target}\n`);
    process.exit(1);
  }
  process.stderr.write(`[ai] processing ${pdfs.length} doc(s) from ${args.target}\n`);

  const results = [];
  for (const pdfPath of pdfs) {
    const baseName = path.basename(pdfPath);
    process.stderr.write(`[ai] ${baseName} ...\n`);
    try {
      const r = await processDoc(pdfPath, args, apiKey);
      results.push({ pdfPath, ...r });
      process.stderr.write(`[ai] ${baseName}: ${r.accepted} accepted, ${r.orphan} orphan\n`);
      if (args.json) process.stdout.write(JSON.stringify({ pdfPath, ...r }, null, 2) + "\n");
      if (args.html) await writeDocReport(pdfPath, r, args);
    } catch (err) {
      process.stderr.write(`[ai] ${baseName} FAILED: ${err.message}\n`);
      results.push({ pdfPath, error: err.message });
    }
  }

  if (args.html && pdfs.length > 1) {
    const isFolder = (await stat(args.target)).isDirectory();
    if (isFolder) await writeFolderIndex(args.target, results);
  }
  process.stderr.write(`[ai] done.\n`);
}

async function resolveTargets(target, ext) {
  const st = await stat(target).catch(() => null);
  if (!st) return [];
  const lower = `.${ext.toLowerCase()}`;
  if (st.isFile()) {
    return target.toLowerCase().endsWith(lower) ? [path.resolve(target)] : [];
  }
  const entries = await readdir(target);
  return entries
    .filter((n) => n.toLowerCase().endsWith(lower))
    .map((n) => path.resolve(target, n));
}

async function processDoc(pdfPath, args, apiKey) {
  const bytes = await readFile(pdfPath);
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    isEvalSupported: false,
  }).promise;

  const pageContents = await extractPageContents(pdf);
  const docTitle = path.basename(pdfPath).replace(/\.pdf$/i, "");
  const highlights = await callReader({
    query: args.query,
    pdfBytes: bytes,
    apiKey,
    model: args.model,
    docTitle,
  });

  const records = [];
  let accepted = 0, orphan = 0;
  for (const h of highlights) {
    const rec = { raw: h };
    if (h.kind === "text") {
      const resolved = resolveTextHighlight(h, pageContents);
      if (resolved) {
        rec.snippet = buildTextSnippet(h, resolved);
        rec.status = "accepted";
        accepted++;
      } else {
        rec.status = "orphan";
        rec.reason = "quote not found in document";
        orphan++;
      }
    } else if (h.kind === "image" && h.rect && h.page) {
      rec.snippet = buildImageSnippet(h);
      rec.status = "accepted";
      accepted++;
    } else {
      rec.status = "orphan";
      rec.reason = "image highlight missing rect or page";
      orphan++;
    }
    records.push(rec);
  }

  const snippetsToWrite = records.filter((r) => r.snippet).map((r) => r.snippet);
  if (!args.dryRun) {
    await applySidecar(pdfPath, snippetsToWrite, args.group);
  }

  return {
    query: args.query,
    docTitle,
    records,
    snippetCount: snippetsToWrite.length,
    accepted,
    orphan,
  };
}

async function extractPageContents(pdf) {
  const map = new Map();
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const vp = page.getViewport({ scale: 1 });
    let flat = "";
    const ranges = [];
    for (const item of tc.items) {
      const s = item.str || "";
      if (!s) continue;
      ranges.push({ start: flat.length, end: flat.length + s.length, item });
      flat += s;
      flat += item.hasEOL ? "\n" : " ";
    }
    map.set(i, { flat, ranges, width: vp.width, height: vp.height });
    page.cleanup?.();
  }
  return map;
}

function resolveTextHighlight(h, pageContents) {
  if (!h.quote) return null;
  const order = [];
  if (h.page && pageContents.has(h.page)) order.push(h.page);
  for (const p of pageContents.keys()) if (p !== h.page) order.push(p);
  for (const pageNum of order) {
    const pc = pageContents.get(pageNum);
    if (!pc) continue;
    const span = findInFlat(pc.flat, h.quote);
    if (!span) continue;
    const [startOff, endOff] = span;
    const inRange = pc.ranges.filter((r) => r.start < endOff && r.end > startOff);
    if (!inRange.length) continue;
    const rects = computeLineRects(inRange, pc.width, pc.height);
    if (!rects.length) continue;
    const text = pc.flat.slice(startOff, endOff);
    return {
      page: pageNum,
      text,
      rects,
      contextBefore: pc.flat.slice(Math.max(0, startOff - CONTEXT_LEN), startOff),
      contextAfter: pc.flat.slice(endOff, endOff + CONTEXT_LEN),
      textNormalized: text.replace(/\s+/g, " ").trim(),
    };
  }
  return null;
}

// computeLineRects imported from src/ai/resolver.js (shared with the
// Tauri app — same math, same constants).

function buildTextSnippet(h, resolved) {
  return {
    id: crypto.randomUUID(),
    kind: "text",
    page: resolved.page,
    text: resolved.text,
    textNormalized: resolved.textNormalized,
    rects: resolved.rects,
    contextBefore: resolved.contextBefore,
    contextAfter: resolved.contextAfter,
    comment: h.reason || "",
    groups: [],
    meta: { source: "ai-cli", confidence: h.confidence || null },
    created: new Date().toISOString(),
  };
}

function buildImageSnippet(h) {
  return {
    id: crypto.randomUUID(),
    kind: "image",
    page: h.page,
    text: h.label || `Region p.${h.page}`,
    rects: [h.rect],
    comment: h.reason || "",
    groups: [],
    meta: { source: "ai-cli", confidence: h.confidence || null },
    created: new Date().toISOString(),
  };
}

async function callReader({ query, pdfBytes, apiKey, model, docTitle }) {
  const lines = [
    `Question: ${query}`,
    "Mode: TEXT-FIRST — prefer kind=text with verbatim quotes. Use kind=image only for genuine non-text content (figures, charts, diagrams).",
    "",
    docTitle ? `Document title: ${docTitle}` : "",
    "",
    "No existing groups — propose 1-4 short title-case group names total.",
  ].filter(Boolean);
  const content = [
    {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: pdfBytes.toString("base64"),
      },
    },
    { type: "text", text: lines.join("\n") },
  ];
  const body = {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: READER_SYSTEM,
    messages: [{ role: "user", content }],
    tools: [READER_TOOL],
  };
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${detail || res.statusText}`);
  }
  const json = await res.json();
  const toolUse = (json.content || []).find(
    (c) => c.type === "tool_use" && c.name === "record_highlights",
  );
  if (!toolUse) {
    const txt = (json.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    throw new Error(`model did not call record_highlights. Text: ${txt.slice(0, 200)}`);
  }
  return toolUse.input?.highlights || [];
}

async function applySidecar(pdfPath, newSnippets, groupName) {
  const sidecarPath = pdfPath + ".annot.json";
  let existing = {};
  if (existsSync(sidecarPath)) {
    try {
      existing = JSON.parse(await readFile(sidecarPath, "utf-8"));
    } catch {
      existing = {};
    }
  }
  existing.markleeVersion = existing.markleeVersion || "0.1";
  existing.source = existing.source || {
    path: pdfPath,
    filename: path.basename(pdfPath),
    kind: "pdf",
  };
  existing.snippets = existing.snippets || [];
  existing.edges = existing.edges || [];
  existing.groups = existing.groups || [];

  if (groupName && newSnippets.length) {
    let group = existing.groups.find((g) => g.name === groupName);
    if (!group) {
      group = { id: crypto.randomUUID(), name: groupName };
      existing.groups.push(group);
    }
    for (const s of newSnippets) s.groups = [group.id];
  }

  existing.snippets.push(...newSnippets);
  await writeFile(sidecarPath, JSON.stringify(existing, null, 2));
}

// ─── HTML reporting ─────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function writeDocReport(pdfPath, result, args) {
  const reportPath = pdfPath.replace(/\.pdf$/i, ".ai-report.html");
  const filename = path.basename(pdfPath);
  const html = renderDocHtml({ filename, ...result, model: args.model, group: args.group });
  await writeFile(reportPath, html);
  process.stderr.write(`[ai] wrote ${path.basename(reportPath)}\n`);
}

function renderDocHtml({ filename, query, records, snippetCount, accepted, orphan, model, group }) {
  const items = records.map((r, i) => renderRecord(r, i)).join("\n");
  const tag = group ? `<span class="tag">group: ${escapeHtml(group)}</span>` : "";
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(filename)} — AI report</title>
<style>
:root { color-scheme: light; }
body { font: 14px/1.55 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; max-width: 820px; margin: 32px auto; padding: 0 24px; color: #1f1f1f; background: #fbfaf6; }
header { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #e8e3d4; }
h1 { font-size: 18px; margin: 0 0 6px; }
.filename { font-family: ui-monospace, "SF Mono", monospace; color: #7a7460; font-size: 12px; }
.query { background: #fff5d9; padding: 12px 16px; border-left: 3px solid #d4a017; border-radius: 4px; margin: 14px 0; font-size: 13.5px; }
.summary { color: #7a7460; font-size: 11.5px; margin: 8px 0 0; font-family: ui-monospace, "SF Mono", monospace; display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
.summary .tag { background: #eee5cf; padding: 1px 8px; border-radius: 10px; font-size: 10.5px; }
ol { list-style: none; padding: 0; margin: 0; }
.hl { padding: 14px 16px; border: 1px solid #e8e3d4; border-radius: 6px; margin-bottom: 10px; background: #fffefa; }
.hl.image { border-left: 3px solid #2ea58c; }
.hl.text { border-left: 3px solid #d4a017; }
.hl.orphan { border-left: 3px solid #c97a4a; background: #fdf7f3; }
.hl-meta { font-family: ui-monospace, "SF Mono", monospace; font-size: 10.5px; color: #999; margin-bottom: 8px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.kind { text-transform: uppercase; letter-spacing: 0.6px; font-weight: 600; }
.confidence { padding: 1px 6px; border-radius: 8px; background: #eee; }
.confidence.high { background: #d4ead0; color: #3a6a3a; }
.confidence.medium { background: #eee5cf; color: #7a6010; }
.confidence.low { background: #f0e0e0; color: #944; }
blockquote { font-family: ui-serif, "Iowan Old Style", Charter, Georgia, serif; font-size: 14.5px; margin: 0; padding: 0 0 0 12px; border-left: 2px solid #d8d0b8; color: #2a2a2a; }
.label { font-family: ui-sans-serif, sans-serif; font-weight: 600; color: #2ea58c; font-size: 14px; }
.reason { font-size: 12.5px; color: #6a6450; margin-top: 8px; font-style: italic; }
.orphan-detail { color: #c97a4a; font-size: 11.5px; }
footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e8e3d4; color: #aaa3a0; font-size: 11px; font-family: ui-monospace, "SF Mono", monospace; }
</style></head>
<body>
<header>
  <h1>${escapeHtml(filename)}</h1>
  <div class="filename">AI batch report · ${escapeHtml(filename)}</div>
  <div class="query">${escapeHtml(query)}</div>
  <div class="summary">
    <span>${accepted} accepted</span>
    <span>${orphan} orphan</span>
    <span>${snippetCount} written to sidecar</span>
    <span>${escapeHtml(model || "")}</span>
    ${tag}
  </div>
</header>
<ol>${items}</ol>
<footer>Generated ${new Date().toLocaleString()} · marklee ai-batch</footer>
</body></html>`;
}

function renderRecord(rec, i) {
  const h = rec.raw;
  const conf = h.confidence ? `<span class="confidence ${h.confidence}">${h.confidence}</span>` : "";
  const page = h.page ? `<span>p.${h.page}</span>` : "";
  if (rec.status === "orphan") {
    const body = h.kind === "text"
      ? `<blockquote>${escapeHtml(h.quote || "(no quote)")}</blockquote>`
      : `<div class="label">${escapeHtml(h.label || "(unlabeled image)")}</div>`;
    return `<li class="hl orphan">
      <div class="hl-meta"><span class="kind">${escapeHtml(h.kind || "?")}</span>${page}${conf} <span class="orphan-detail">orphan: ${escapeHtml(rec.reason || "")}</span></div>
      ${body}
      <div class="reason">${escapeHtml(h.reason || "")}</div>
    </li>`;
  }
  const s = rec.snippet;
  const body = s.kind === "text"
    ? `<blockquote>${escapeHtml(s.text)}</blockquote>`
    : `<div class="label">${escapeHtml(s.text)}</div>`;
  return `<li class="hl ${s.kind}">
    <div class="hl-meta"><span class="kind">${s.kind}</span><span>p.${s.page}</span>${conf}</div>
    ${body}
    <div class="reason">${escapeHtml(s.comment || "")}</div>
  </li>`;
}

async function writeFolderIndex(target, results) {
  const indexPath = path.join(target, "ai-batch-index.html");
  const rows = results.map((r) => {
    const filename = path.basename(r.pdfPath);
    const reportLink = filename.replace(/\.pdf$/i, ".ai-report.html");
    if (r.error) {
      return `<li class="err">
        <a href="${escapeHtml(reportLink)}">${escapeHtml(filename)}</a>
        <span class="status err">FAILED</span>
        <div class="error">${escapeHtml(r.error)}</div>
      </li>`;
    }
    return `<li>
      <a href="${escapeHtml(reportLink)}">${escapeHtml(filename)}</a>
      <span class="counts">${r.accepted} accepted · ${r.orphan} orphan</span>
    </li>`;
  }).join("\n");
  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>AI batch — ${escapeHtml(path.basename(target))}</title>
<style>
body { font: 14px/1.55 ui-sans-serif, -apple-system, sans-serif; max-width: 820px; margin: 32px auto; padding: 0 24px; color: #1f1f1f; background: #fbfaf6; }
h1 { font-size: 18px; margin: 0 0 6px; }
.sub { color: #7a7460; font-size: 12px; font-family: ui-monospace, "SF Mono", monospace; margin-bottom: 24px; }
ul { list-style: none; padding: 0; }
li { padding: 11px 14px; border: 1px solid #e8e3d4; border-radius: 6px; margin-bottom: 6px; background: #fffefa; display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; }
li.err { background: #fdf3f1; }
a { color: #2ea58c; text-decoration: none; flex: 1; font-weight: 600; }
a:hover { text-decoration: underline; }
.counts { color: #7a7460; font-size: 11.5px; font-family: ui-monospace, "SF Mono", monospace; }
.status.err { color: #c44a3b; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; }
.error { width: 100%; color: #c44a3b; font-size: 11px; padding-left: 4px; font-family: ui-monospace, monospace; }
footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e8e3d4; color: #aaa3a0; font-size: 11px; font-family: ui-monospace, "SF Mono", monospace; }
</style></head><body>
<h1>AI batch · ${escapeHtml(path.basename(target))}</h1>
<div class="sub">${results.length} doc(s) processed · ${new Date().toLocaleString()}</div>
<ul>${rows}</ul>
<footer>marklee ai-batch · per-doc reports linked above</footer>
</body></html>`;
  await writeFile(indexPath, html);
  process.stderr.write(`[ai] wrote ai-batch-index.html in ${target}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
