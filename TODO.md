# TODO

## Export to ISO 32000–compatible PDF (one-way handoff)

Write a copy of the source PDF with `/Annot` entries derived from the sidecar so that Acrobat / Preview / PDF Expert can see the highlights + comments natively.

Mapping:
- text snippet w/ rects + comment → `/Subtype /Highlight` + `/QuadPoints` + `/Contents`
- region clip (rect snippet) → `/Subtype /Square` + `/Rect`
- text snippet w/o rects (orphaned, or flow doc) → cannot export

Caveats:
- loses lineage graph, groups, MarkRank, four-tier anchor metadata
- one-way: exported PDF doesn't sync back to the sidecar
- exported PDF != source PDF byte-for-byte (contentHash diverges)

Implementation:
- `pdf-writer` or `lopdf` crate in `src-tauri`
- Tauri command `export_iso32000(pdf_path, sidecar_path) -> output_path`
- normalized fractional rects (0..1, top-down) → PDF user-space (points, bottom-up)
- "Export annotated PDF…" button next to Summary
