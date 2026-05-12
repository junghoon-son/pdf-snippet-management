#!/usr/bin/env python3
"""Run Docling layout detection on a PDF, output figures as JSON.

Usage:
  python3 docling_detect.py <pdf_path>

Output (stdout, JSON):
  {
    "pages": [
      { "page": 1, "width": 612.0, "height": 792.0,
        "figures": [
          { "bbox": {"left": 0.1, "top": 0.2, "width": 0.7, "height": 0.3},
            "label": "picture",
            "caption": "Figure 1: ..." }
        ] }
    ]
  }

Errors are written to stderr as JSON: {"error": "..."} with exit code 1-3.
"""

import json
import sys


def err_out(msg, code=1):
    print(json.dumps({"error": msg}), file=sys.stderr)
    sys.exit(code)


def main():
    if len(sys.argv) < 2:
        err_out("usage: docling_detect.py <pdf_path>", 1)

    pdf_path = sys.argv[1]

    try:
        from docling.document_converter import DocumentConverter
    except ImportError:
        err_out(
            "docling not installed. Install: pip install docling (or uv pip install docling)",
            2,
        )

    try:
        converter = DocumentConverter()
        result = converter.convert(pdf_path)
    except Exception as e:
        err_out(f"docling conversion failed: {e}", 3)

    doc = result.document

    # Build per-page dimensions
    page_dims = {}
    try:
        for page_no, page in doc.pages.items():
            size = getattr(page, "size", None)
            w = getattr(size, "width", None) if size else None
            h = getattr(size, "height", None) if size else None
            page_dims[page_no] = (w or 612.0, h or 792.0)
    except Exception:
        # Fallback if .pages structure differs across docling versions
        pass

    # Iterate items and pull figure/picture/table bboxes
    figures_by_page = {}
    try:
        for item, _level in doc.iterate_items():
            label = getattr(item, "label", None)
            label_str = (str(label) or "").lower()
            is_figure = any(
                k in label_str
                for k in ("picture", "figure", "image")
            )
            if not is_figure:
                continue

            prov_list = getattr(item, "prov", None) or []
            if not prov_list:
                continue
            prov = prov_list[0]
            bbox = getattr(prov, "bbox", None)
            page_no = getattr(prov, "page_no", None)
            if not bbox or page_no is None:
                continue

            w, h = page_dims.get(page_no, (612.0, 792.0))

            # docling bbox fields: l (left), t (top, high y in PDF), r, b
            # In PDF coords y increases upward, so "top" (t) is the higher y
            # and "bottom" (b) is the lower y. Convert to normalized top-down.
            l = float(bbox.l)
            t = float(bbox.t)
            r = float(bbox.r)
            b = float(bbox.b)

            # Normalize to top-left origin, fractions of page size.
            left_norm = l / w
            width_norm = (r - l) / w
            top_norm = 1.0 - (t / h)
            height_norm = (t - b) / h

            # Clamp + sanity check
            if width_norm <= 0 or height_norm <= 0:
                continue
            left_norm = max(0.0, min(1.0, left_norm))
            top_norm = max(0.0, min(1.0, top_norm))
            width_norm = max(0.0, min(1.0 - left_norm, width_norm))
            height_norm = max(0.0, min(1.0 - top_norm, height_norm))

            caption = ""
            cap = getattr(item, "captions", None) or getattr(item, "caption", None)
            if cap:
                try:
                    caption = str(cap) if not isinstance(cap, list) else " ".join(str(c) for c in cap)
                except Exception:
                    caption = ""

            figures_by_page.setdefault(page_no, []).append({
                "bbox": {
                    "left": left_norm,
                    "top": top_norm,
                    "width": width_norm,
                    "height": height_norm,
                },
                "label": label_str,
                "caption": caption,
            })
    except Exception as e:
        err_out(f"docling iteration failed: {e}", 4)

    pages_out = []
    for page_no in sorted(page_dims.keys()):
        w, h = page_dims[page_no]
        pages_out.append({
            "page": page_no,
            "width": w,
            "height": h,
            "figures": figures_by_page.get(page_no, []),
        })

    print(json.dumps({"pages": pages_out}))


if __name__ == "__main__":
    main()
