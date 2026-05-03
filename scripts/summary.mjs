#!/usr/bin/env bun
import { readFile, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HELP = `Usage:
  bun run summary <file-or-dir> [options]

Supported formats: PDF, Markdown (.md, .markdown), Word (.docx).

Options:
  --plain        Plain HTML (matches modal "plain" mode)
  --md           Markdown output
  --json         Raw JSON: { title, sources, sections, ungrouped, groups }
  --workspace    Force directory mode (auto-detected if path is a dir)
  --no-images    Skip embedding image clips as data URIs
  -o <file>      Write to file instead of stdout
  -h, --help     Show this help

Reads .annot.json sidecars next to documents and ~/.pdf-annotator/groups.json.
Output goes to stdout unless -o is given.
`;

function parseArgs(argv) {
  const args = {
    positional: [],
    plain: false,
    md: false,
    json: false,
    workspace: false,
    noImages: false,
    out: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plain") args.plain = true;
    else if (a === "--md" || a === "--markdown") args.md = true;
    else if (a === "--json") args.json = true;
    else if (a === "--workspace") args.workspace = true;
    else if (a === "--no-images") args.noImages = true;
    else if (a === "-o") args.out = argv[++i];
    else if (a === "-h" || a === "--help") args.help = true;
    else args.positional.push(a);
  }
  return args;
}

function escHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadGlobalGroups() {
  const home = process.env.HOME || os.homedir();
  const p = path.join(home, ".pdf-annotator", "groups.json");
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return [];
  }
}

async function loadAnnot(pdfPath) {
  const sidecar = pdfPath + ".annot.json";
  if (!existsSync(sidecar)) return null;
  try {
    return JSON.parse(await readFile(sidecar, "utf8"));
  } catch {
    return null;
  }
}

async function listPdfsInDir(dir) {
  const entries = await readdir(dir);
  return entries
    .filter((f) => /\.(pdf|md|markdown|docx)$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

async function loadClipDataUri(pdfPath, imagePath) {
  const dir = path.dirname(pdfPath);
  const file = path.isAbsolute(imagePath) ? imagePath : path.join(dir, imagePath);
  if (!existsSync(file)) return null;
  const bytes = await readFile(file);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function buildSections(snippets, groupOrder) {
  const counts = new Map();
  for (const s of snippets) {
    for (const g of s.groups || []) counts.set(g, (counts.get(g) || 0) + 1);
  }
  const sections = new Map();
  const ungrouped = [];
  for (const s of snippets) {
    const gs = s.groups || [];
    if (gs.length === 0) {
      ungrouped.push(s);
      continue;
    }
    const sortedGs = [...gs].sort(
      (a, b) => (groupOrder.indexOf(a) + 1 || 9999) - (groupOrder.indexOf(b) + 1 || 9999),
    );
    const gid = sortedGs[0];
    if (!sections.has(gid)) sections.set(gid, []);
    sections.get(gid).push(s);
  }
  const ordered = new Map();
  for (const gid of groupOrder) {
    if (sections.has(gid)) ordered.set(gid, sections.get(gid));
  }
  for (const [gid, members] of sections) {
    if (!ordered.has(gid)) ordered.set(gid, members);
  }
  return { sections: ordered, ungrouped };
}

function sortByDocAndPage(a, b) {
  const pa = a._pdfPath || "";
  const pb = b._pdfPath || "";
  if (pa !== pb) return pa < pb ? -1 : 1;
  if (typeof a.flowPos === "number" && typeof b.flowPos === "number") return a.flowPos - b.flowPos;
  return a.page - b.page;
}

function fileHref(filePath, page) {
  if (!filePath) return "";
  const isPdf = /\.pdf$/i.test(filePath);
  return `file://${encodeURI(filePath)}${isPdf ? `#page=${page}` : ""}`;
}

function locLabel(s) {
  return s.anchor ? `§ ${s.anchor}` : `p.${s.page}`;
}

function defaultGroupColor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 70%, 55%)`;
}

function makeGroupHelpers(groups) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const groupName = (id) => byId.get(id)?.name || `Group ${id.slice(0, 6)}`;
  const groupColor = (id) => byId.get(id)?.color || defaultGroupColor(id);
  return { groupName, groupColor };
}

function renderHtmlRich({ title, sources, snippetCount, sections, ungrouped, imageMap, isWorkspace, groupName, groupColor }) {
  const renderSnippet = (s, color) => {
    const path = s._pdfPath || "";
    const filename = path.split("/").pop() || "?";
    const href = fileHref(path, s.page);
    const loc = locLabel(s);
    const cite = href
      ? `<a href="${escHtml(href)}">${escHtml(filename)} · ${escHtml(loc)}</a>`
      : `${escHtml(filename)} · ${escHtml(loc)}`;
    let body;
    if (s.kind === "image" && imageMap.get(s.id)) {
      body = `<div class="snippet-image"><img src="${imageMap.get(s.id)}" alt="${escHtml(s.text || "")}"></div>`;
    } else if (s.kind === "image") {
      body = `<div class="snippet-text muted">[image clip missing]</div>`;
    } else {
      body = `<div class="snippet-text">${escHtml(s.text || "")}</div>`;
    }
    const comment = s.comment ? `<div class="snippet-comment">${escHtml(s.comment)}</div>` : "";
    return `<div class="snippet" style="border-left-color:${color};">
  <div class="snippet-meta">${cite}</div>
  ${body}
  ${comment}
</div>`;
  };

  const parts = [];
  parts.push(`<h1>${escHtml(title)}</h1>`);
  parts.push(`<p class="summary-meta">${snippetCount} snippets · ${sections.size} groups${isWorkspace ? ` · ${sources.length} sources` : ""}</p>`);
  if (sources.length > 0 && isWorkspace) {
    parts.push(`<p class="summary-sources">${sources.map((p) => escHtml(p.split("/").pop() || p)).join(" · ")}</p>`);
  }
  for (const [gid, members] of sections) {
    members.sort(sortByDocAndPage);
    const color = groupColor(gid);
    parts.push(`<h2 style="border-left-color:${color}">${escHtml(groupName(gid))} <span class="count">(${members.length})</span></h2>`);
    for (const s of members) parts.push(renderSnippet(s, color));
  }
  if (ungrouped.length > 0) {
    ungrouped.sort(sortByDocAndPage);
    parts.push(`<h2>Unfiled <span class="count">(${ungrouped.length})</span></h2>`);
    for (const s of ungrouped) parts.push(renderSnippet(s, "#bbb"));
  }
  parts.push(`<hr><p class="exported">Exported ${new Date().toLocaleString()}</p>`);

  const css = `
body { font-family: ui-sans-serif, -apple-system, system-ui; max-width: 820px; margin: 30px auto; padding: 0 24px; color: #1f1f1f; background: #fbf9f3; }
h1 { font-size: 22px; margin-bottom: 4px; }
h2 { font-size: 16px; margin: 28px 0 10px; padding-left: 10px; border-left: 4px solid #bbb; }
h2 .count { color: #888; font-weight: 400; font-size: 13px; }
.summary-meta { color: #6e6e6e; font-size: 12px; }
.summary-sources { color: #8a8a8a; font-size: 11px; font-family: ui-monospace, "SF Mono", monospace; }
.snippet { margin: 14px 0 22px; padding: 4px 0 4px 14px; border-left: 3px solid; }
.snippet-meta { font-family: ui-monospace, "SF Mono", monospace; font-size: 10px; color: #6e6e6e; margin-bottom: 4px; }
.snippet-meta a { color: #6e6e6e; text-decoration: none; }
.snippet-meta a:hover { color: #2ea58c; }
.snippet-text { font-family: ui-serif, "Iowan Old Style", Charter, Georgia, serif; font-size: 14.5px; line-height: 1.55; color: #1f1f1f; }
.snippet-text.muted { color: #888; font-style: italic; }
.snippet-image img { max-width: 100%; border: 1px solid #ddd; border-radius: 3px; }
.snippet-comment { margin-top: 8px; padding: 8px 12px; background: #ece9df; border-radius: 4px; font-size: 12.5px; color: #2a2a2a; line-height: 1.5; }
hr { border: none; border-top: 1px solid #d4cebc; margin: 36px 0 14px; }
.exported { color: #999; font-size: 11px; }
`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escHtml(title)}</title>
<style>${css}</style>
</head>
<body>
${parts.join("\n")}
</body>
</html>`;
}

function renderHtmlPlain({ title, sources, snippetCount, sections, ungrouped, imageMap, isWorkspace, groupName }) {
  const renderSnippet = (s) => {
    const path = s._pdfPath || "";
    const filename = path.split("/").pop() || "?";
    const href = fileHref(path, s.page);
    const loc = locLabel(s);
    const cite = href
      ? `<a href="${escHtml(href)}">${escHtml(filename)} ${escHtml(loc)}</a>`
      : `${escHtml(filename)} ${escHtml(loc)}`;
    let body;
    if (s.kind === "image" && imageMap.get(s.id)) {
      body = `<p><img src="${imageMap.get(s.id)}" alt="${escHtml(s.text || "")}"></p>`;
    } else if (s.kind === "image") {
      body = `<p><em>[image clip missing]</em></p>`;
    } else {
      body = `<blockquote>${escHtml(s.text || "")}</blockquote>`;
    }
    const comment = s.comment ? `<p>→ ${escHtml(s.comment)}</p>` : "";
    return `<p><small>[${cite}]</small></p>\n${body}\n${comment}`;
  };

  const parts = [];
  parts.push(`<h1>${escHtml(title)}</h1>`);
  parts.push(`<p>${snippetCount} snippets · ${sections.size} groups${isWorkspace ? ` · ${sources.length} sources` : ""}</p>`);
  if (sources.length > 0 && isWorkspace) {
    parts.push(`<p><small>${sources.map((p) => escHtml(p.split("/").pop() || p)).join(" · ")}</small></p>`);
  }
  parts.push(`<hr>`);
  for (const [gid, members] of sections) {
    members.sort(sortByDocAndPage);
    parts.push(`<h2>${escHtml(groupName(gid))} (${members.length})</h2>`);
    for (const s of members) parts.push(renderSnippet(s));
  }
  if (ungrouped.length > 0) {
    ungrouped.sort(sortByDocAndPage);
    parts.push(`<h2>Unfiled (${ungrouped.length})</h2>`);
    for (const s of ungrouped) parts.push(renderSnippet(s));
  }
  parts.push(`<hr><p><small>Exported ${new Date().toLocaleString()}</small></p>`);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escHtml(title)}</title></head>
<body>
${parts.join("\n")}
</body>
</html>`;
}

function renderMarkdown({ title, sources, snippetCount, sections, ungrouped, isWorkspace, groupName }) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push("");
  const summary = [`${snippetCount} snippets`, `${sections.size} groups`];
  if (isWorkspace) summary.push(`${sources.length} sources`);
  lines.push(`_${summary.join(" · ")}_`);
  lines.push("");
  if (sources.length > 0 && isWorkspace) {
    lines.push("**Sources:** " + sources.map((p) => `\`${p.split("/").pop() || p}\``).join(", "));
    lines.push("");
  }
  const renderSnippet = (s) => {
    const filename = (s._pdfPath || "").split("/").pop() || "?";
    const cite = `${filename} · ${locLabel(s)}`;
    const out = [];
    out.push(`### ${cite}`);
    if (s.kind === "image") {
      out.push(`*[image clip — page ${s.page}]*`);
    } else {
      const text = (s.text || "").trim();
      out.push(text ? text.split("\n").map((l) => `> ${l}`).join("\n") : "_(no text)_");
    }
    if (s.comment) {
      out.push("");
      out.push(`**Note:** ${s.comment}`);
    }
    return out.join("\n");
  };
  for (const [gid, members] of sections) {
    members.sort(sortByDocAndPage);
    lines.push(`## ${groupName(gid)} (${members.length})`);
    lines.push("");
    for (const s of members) {
      lines.push(renderSnippet(s));
      lines.push("");
    }
  }
  if (ungrouped.length > 0) {
    ungrouped.sort(sortByDocAndPage);
    lines.push(`## Unfiled (${ungrouped.length})`);
    lines.push("");
    for (const s of ungrouped) {
      lines.push(renderSnippet(s));
      lines.push("");
    }
  }
  lines.push(`---`);
  lines.push(`_Exported ${new Date().toISOString()}_`);
  return lines.join("\n");
}

function renderJson({ title, sources, snippetCount, sections, ungrouped, isWorkspace, groups }) {
  const sectionList = [];
  for (const [gid, members] of sections) {
    members.sort(sortByDocAndPage);
    sectionList.push({ groupId: gid, snippets: members });
  }
  ungrouped.sort(sortByDocAndPage);
  return JSON.stringify(
    {
      title,
      isWorkspace,
      snippetCount,
      sources,
      groups,
      sections: sectionList,
      ungrouped,
      exportedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}

async function gatherPaths(positional, forceWorkspace) {
  if (positional.length === 0) throw new Error("missing path argument");
  const target = positional[0];
  const stat = statSync(target);
  if (stat.isDirectory() || forceWorkspace) {
    const dir = stat.isDirectory() ? target : path.dirname(target);
    const pdfs = await listPdfsInDir(dir);
    return { pdfs, isWorkspace: true, label: dir };
  }
  return { pdfs: [target], isWorkspace: false, label: target };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.positional.length === 0) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 1);
  }

  const { pdfs, isWorkspace, label } = await gatherPaths(args.positional, args.workspace);
  if (pdfs.length === 0) {
    console.error(`no PDFs found at ${label}`);
    process.exit(1);
  }

  const globalGroups = await loadGlobalGroups();
  const groupOrder = globalGroups.map((g) => g.id);
  const sources = [];
  const allSnippets = [];
  for (const pdf of pdfs) {
    const af = await loadAnnot(pdf);
    if (!af) continue;
    sources.push(pdf);
    for (const s of af.snippets || []) {
      allSnippets.push({ ...s, _pdfPath: pdf });
    }
  }
  if (allSnippets.length === 0) {
    console.error(`no annotations found (looked at ${pdfs.length} PDF${pdfs.length === 1 ? "" : "s"})`);
    process.exit(1);
  }

  const imageMap = new Map();
  if (!args.noImages && !args.json) {
    for (const s of allSnippets) {
      if (s.kind === "image" && s.imagePath) {
        const uri = await loadClipDataUri(s._pdfPath, s.imagePath);
        if (uri) imageMap.set(s.id, uri);
      }
    }
  }

  const { sections, ungrouped } = buildSections(allSnippets, groupOrder);
  const { groupName, groupColor } = makeGroupHelpers(globalGroups);

  let title;
  if (isWorkspace) {
    title = `Workspace summary — ${path.basename(label)}`;
  } else {
    const af = await loadAnnot(pdfs[0]);
    title = af?.source?.title || path.basename(pdfs[0]).replace(/\.(pdf|md|markdown|docx)$/i, "");
  }

  const ctx = {
    title,
    sources,
    snippetCount: allSnippets.length,
    sections,
    ungrouped,
    imageMap,
    isWorkspace,
    groupName,
    groupColor,
    groups: globalGroups,
  };

  let output;
  if (args.json) output = renderJson(ctx);
  else if (args.md) output = renderMarkdown(ctx);
  else if (args.plain) output = renderHtmlPlain(ctx);
  else output = renderHtmlRich(ctx);

  if (args.out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(args.out, output);
    console.error(`wrote ${output.length} bytes to ${args.out}`);
  } else {
    process.stdout.write(output);
    if (!output.endsWith("\n")) process.stdout.write("\n");
  }
}

main().catch((err) => {
  console.error("error:", err.message || err);
  process.exit(1);
});
