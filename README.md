# Marklee

Portable, format-agnostic document annotation. Captures snippets from PDF, Markdown, and DOCX into JSON sidecars next to the source — no server, no account. Includes edit-tolerant text anchors, a directed lineage graph between snippets, and the **MarkRank** centrality algorithm for surfacing the most-referenced ideas in a corpus.

See [`SPEC.md`](SPEC.md) for the format specification.

Built with Tauri 2 (Rust) + vanilla JS + PDF.js + cytoscape.

## What it does

- Open any text-extractable PDF, select text → snippet with comment textarea
- Drag a rectangle for image clips (rendered at 4× and saved as PNG sidecar)
- Three views per doc: **list** (column-aligned group spines), **map** (force-directed snippet graph), **groups** (rename, delete, count)
- Right-click any snippet → physics-bubble overlay to drop it into a group
- Groups are global across all opened docs (`~/.pdf-annotator/groups.json`)
- Workspace concept: multiple files/folders persist across sessions
- Snippets, comments, edges, and group refs persist next to each PDF as `<file>.pdf.annot.json`
- Image clips persist next to each PDF as `<dir>/.<file>.pdf.clips/<id>.png`

## Prerequisites

- **macOS / Linux / Windows** (developed on macOS, Tauri is cross-platform)
- **[Bun](https://bun.sh/)** for the JS toolchain (`brew install oven-sh/bun/bun` or see bun.sh)
- **[Rust](https://rustup.rs/)** stable, with `cargo` on PATH
- On macOS, Xcode Command Line Tools (`xcode-select --install`)

## Run in dev

```bash
bun install
bun tauri dev
```

The first run compiles Tauri (~1 min) and opens a native window. Subsequent runs are fast — Vite HMR for the frontend, Cargo incremental for the Rust side.

## Build a release binary

```bash
bun tauri build
```

Output lands in `src-tauri/target/release/bundle/`. Per-platform artifacts:

- **macOS** — `*.app` bundle in `bundle/macos/` and a `.dmg` installer in `bundle/dmg/`. Code-signing requires a Developer ID; without it the app needs `xattr -dr com.apple.quarantine PDF\ Annotator.app` to launch on another machine. To build a universal binary set `tauri.bundle.macOS.minimumSystemVersion` and add `--target universal-apple-darwin`.
- **Windows** — `.msi` installer (default) and/or NSIS `.exe`. Cross-build from macOS requires the Windows toolchain; usually easier to build on Windows directly or via CI.
- **Linux** — `.deb`, `.rpm`, `.AppImage` per host distro. Cross-build between distros uses Docker images (`tauri/build-linux`).

First release build takes ~5–10 min (compiles all Rust deps from scratch). Subsequent builds are ~1 min thanks to Cargo incremental.

## Run in a regular browser (FSA storage path)

The same frontend runs in a Chromium-family browser (Chrome / Edge / Brave / Arc) without Tauri:

```bash
bun run dev          # starts Vite at http://localhost:1420
```

Open `http://localhost:1420` directly in Chrome (not via the Tauri window). The app detects the missing Tauri runtime and switches to the **File System Access API** storage backend. Click `+ folder` in the sidebar to grant the browser access to a folder; sidecars and image clips are written next to source files just like the desktop build. Safari and Firefox fall back to the OPFS stub (currently a placeholder).

For a built static site:

```bash
bun run build        # outputs dist/
npx serve dist       # or any static server
```

## CLI tools

```bash
bun run summary <file-or-dir> [--md|--plain|--json]
bun run annotate <command> [...]
bun run annotate serve --port 1421 --key SECRET
```

`serve` exposes every CLI command at `POST /annotate/<command>` with JSON in/out. See `bun run annotate --help`.

## Project layout

```
src/                    # frontend (vanilla JS, no framework)
  main.js               # state, event wiring, view switching
  pdf-viewer.js         # PDF.js render + selection capture + region clip
  map-view.js           # cytoscape graph view
  group-overlay.js      # d3-force bubble grouping overlay
  styles.css

src-tauri/
  src/lib.rs            # Tauri commands: list_pdfs, read_pdf, read_annot,
                        # write_annot, write_clip, read_clip, delete_clip,
                        # check_paths, read/write_global_groups
  tauri.conf.json
  capabilities/default.json

index.html
package.json
vite.config.js
```

## Sidecar JSON schema

Each PDF gets a `<filename>.pdf.annot.json` next to it:

```json
{
  "source": { "path": "...", "filename": "...", "title": "...", "author": "..." },
  "snippets": [
    {
      "id": "uuid",
      "kind": "text",                  // or "image"
      "page": 5,
      "text": "...",
      "rects": [{ "left": 0.1, "top": 0.2, "width": 0.3, "height": 0.04 }],
      "comment": "...",
      "groups": ["group-uuid", ...],
      "imagePath": ".paper.pdf.clips/abc.png"  // image kind only, relative to PDF dir
    }
  ],
  "edges":  [{ "id": "...", "source": "...", "target": "...", "label": "..." }],
  "groups": [{ "id": "...", "name": "..." }]   // groups referenced in this doc
}
```

Global group index lives at `~/.pdf-annotator/groups.json`.

## Keyboard shortcuts

- `T` / `R` — text-select / rectangle-clip tool
- `⌘=` / `⌘-` / `⌘0` — zoom in / out / fit width
- `⌘Z` — undo last add or delete (anywhere outside a textarea)
- Right-click a snippet — open the bubble grouping overlay
- `Esc` — cancel the bubble overlay or close the summary modal

## Known limits

- Scanned (image-only) PDFs have no extractable text; selection won't work. Use the rect tool to clip regions.
- Selection on multi-column / equation-heavy layouts can flicker (fundamental to PDF.js text-layer rendering — we mitigate with CSS but don't fully fix it).
- No mobile build configured yet (icons are generated for iOS/Android but the app config targets desktop).
