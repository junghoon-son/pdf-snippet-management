# pdf-snippet-management

Desktop PDF reader for capturing and organizing snippets across many documents. Built with Tauri 2 (Rust) + vanilla JS + PDF.js + cytoscape.

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

Output lands in `src-tauri/target/release/bundle/`.

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
