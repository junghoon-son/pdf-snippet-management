#!/usr/bin/env bun
// Build the static landing/ directory ready for Cloudflare Pages deploy.
//
//   1. Renders SPEC.md → landing/spec/index.html (with shared stylesheet)
//   2. Copies SPEC.md raw → landing/spec.md (for direct download)
//   3. Copies schema/marklee-v0.1.json → landing/schema/marklee-v0.1.json
//   4. Copies latest universal .dmg from src-tauri/target/.../bundle/dmg/
//      into landing/download/ if present
//
// Run: bun run scripts/build-landing.mjs
// Deploy: bunx wrangler pages deploy landing --project-name=marklee

import { readFile, writeFile, mkdir, copyFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const landing = path.join(root, "landing");

async function step(label, fn) {
  process.stdout.write(`  · ${label}… `);
  try {
    const result = await fn();
    process.stdout.write(`ok${result ? ` (${result})` : ""}\n`);
  } catch (err) {
    process.stdout.write(`FAIL\n    ${err.message || err}\n`);
    process.exitCode = 1;
  }
}

console.log("Building landing/...");

await step("render SPEC.md → landing/spec/index.html", async () => {
  const md = await readFile(path.join(root, "SPEC.md"), "utf8");
  const html = marked.parse(md, { headerIds: true, mangle: false });
  const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Marklee Spec</title>
  <meta name="description" content="Marklee Annotation Format — JSON sidecar schema, edit-tolerant anchor algorithm, permalink URL grammar, and the MarkRank centrality algorithm." />
  <link rel="stylesheet" href="../styles.css" />
  <link rel="stylesheet" href="./spec.css" />
</head>
<body class="spec-body">
  <header class="spec-header">
    <div class="container spec-header-inner">
      <a class="brand" href="/">
        <span class="brand-dot"></span>
        <span class="brand-name">Marklee</span>
      </a>
      <nav class="nav">
        <a href="/">Home</a>
        <a href="/spec.md">SPEC.md (raw)</a>
        <a href="/schema/marklee-v0.1.json">JSON Schema</a>
      </nav>
    </div>
  </header>
  <main class="container spec-main">
    <article class="spec-article">
      ${html}
    </article>
  </main>
</body>
</html>`;
  await mkdir(path.join(landing, "spec"), { recursive: true });
  await writeFile(path.join(landing, "spec", "index.html"), page);
  return `${html.length.toLocaleString()} chars rendered`;
});

await step("copy SPEC.md → landing/spec.md", async () => {
  await copyFile(path.join(root, "SPEC.md"), path.join(landing, "spec.md"));
});

await step("copy schema → landing/schema/", async () => {
  await mkdir(path.join(landing, "schema"), { recursive: true });
  await copyFile(
    path.join(root, "schema", "marklee-v0.1.json"),
    path.join(landing, "schema", "marklee-v0.1.json"),
  );
});

await step("write spec.css", async () => {
  const css = `/* Spec page stylesheet — shared theme variables come from styles.css */
.spec-body {
  background: var(--bg);
  font-family: ui-serif, Georgia, "Iowan Old Style", Palatino, serif;
  font-size: 16px;
  line-height: 1.65;
  color: var(--fg);
}
.spec-header {
  background: var(--bg-alt);
  border-bottom: 1px solid var(--border);
  padding: 20px 0;
  margin-bottom: 36px;
}
.spec-header-inner { display: flex; align-items: center; justify-content: space-between; }
.spec-main { max-width: 760px; padding-bottom: 80px; }
.spec-article h1 {
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.015em;
  margin: 0 0 14px;
}
.spec-article h2 {
  font-size: 24px;
  font-weight: 700;
  margin-top: 56px;
  margin-bottom: 12px;
  letter-spacing: -0.01em;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
}
.spec-article h3 {
  font-size: 18px;
  margin-top: 32px;
  margin-bottom: 8px;
  color: var(--accent-deep);
}
.spec-article h4 { font-size: 15px; margin-top: 24px; margin-bottom: 6px; }
.spec-article p { margin: 12px 0; }
.spec-article ul, .spec-article ol { padding-left: 26px; margin: 12px 0; }
.spec-article li { margin: 4px 0; }
.spec-article code {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 13px;
  background: var(--code-bg);
  padding: 1px 6px;
  border-radius: 3px;
}
.spec-article pre {
  background: var(--card-bg);
  border: 1px solid var(--border);
  padding: 14px 16px;
  overflow-x: auto;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.5;
}
.spec-article pre code { background: none; padding: 0; }
.spec-article blockquote {
  border-left: 3px solid var(--accent);
  padding: 6px 16px;
  margin: 16px 0;
  color: var(--fg-dim);
  background: var(--bg-alt);
}
.spec-article table {
  width: 100%;
  border-collapse: collapse;
  margin: 18px 0;
  font-size: 14px;
  font-family: -apple-system, system-ui, "Segoe UI", sans-serif;
}
.spec-article th, .spec-article td {
  text-align: left;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
}
.spec-article thead th {
  background: var(--bg-alt);
  font-weight: 600;
}
.spec-article a {
  color: var(--accent-deep);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--accent-deep) 30%, transparent);
}
.spec-article a:hover { color: var(--accent); }
.spec-article hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 36px 0;
}
@media (max-width: 640px) {
  .spec-article h1 { font-size: 26px; }
  .spec-article h2 { font-size: 20px; }
  .spec-main { padding-bottom: 50px; }
}
`;
  await writeFile(path.join(landing, "spec", "spec.css"), css);
});

await step("copy latest .dmg → landing/download/", async () => {
  const dmgDir = path.join(root, "src-tauri", "target", "universal-apple-darwin", "release", "bundle", "dmg");
  if (!existsSync(dmgDir)) return "no dmg built — skipped";
  const files = (await readdir(dmgDir)).filter((f) => f.endsWith(".dmg"));
  if (files.length === 0) return "no .dmg found — skipped";
  await mkdir(path.join(landing, "download"), { recursive: true });
  for (const f of files) {
    await copyFile(path.join(dmgDir, f), path.join(landing, "download", f));
  }
  return `${files.length} file(s) copied`;
});

await step("write _headers + _redirects", async () => {
  await writeFile(path.join(landing, "_headers"), `/schema/*
  Content-Type: application/json
  Cache-Control: public, max-age=300
  Access-Control-Allow-Origin: *

/spec.md
  Content-Type: text/markdown; charset=utf-8

/download/*
  Cache-Control: public, max-age=86400
`);
  // /v?... permalinks should bootstrap the FSA build once it's deployed.
  // For now redirect to the home page so the URL doesn't 404.
  await writeFile(path.join(landing, "_redirects"), `/v  /  302
`);
});

console.log("\nDone. Deploy:");
console.log("  bunx wrangler pages deploy landing --project-name=marklee");
