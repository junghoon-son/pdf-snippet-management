// Extract the full text of the currently-open document so we can feed
// it to the Reader. PDFs are page-marked; flow docs return their text.

const CONTEXT_LEN = 40;

// Render each PDF page to a base64 PNG at modest resolution so we can
// hand them to a vision-capable model. The model uses these to spot
// figures + return bounding boxes in normalized coords. Resolution is
// kept low (~900px wide) to control token cost.
export async function extractPdfPageImages(pdfDoc, { targetWidth = 1400 } = {}) {
  if (!pdfDoc) return [];
  const out = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const baseVp = page.getViewport({ scale: 1 });
    const scale = targetWidth / baseVp.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    // Anthropic accepts base64 PNG content; strip the data-URL header.
    const dataUrl = canvas.toDataURL("image/png");
    const b64 = dataUrl.split(",")[1] || "";
    out.push({ page: i, base64: b64, width: canvas.width, height: canvas.height });
    page.cleanup?.();
  }
  return out;
}

// Extract positioned text content for each PDF page — the raw items
// with their PDF-space transforms. Used by the caption-anchor resolver
// to find rects on non-visible (lazy-rendered) pages.
export async function extractPdfPageTextContent(pdfDoc) {
  if (!pdfDoc) return new Map();
  const map = new Map();
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const tc = await page.getTextContent();
    const vp = page.getViewport({ scale: 1 });
    // Build a flat string + parallel array of (item, start, end) ranges.
    let flat = "";
    const ranges = [];
    for (const item of tc.items) {
      const s = item.str || "";
      if (!s) continue;
      ranges.push({ start: flat.length, end: flat.length + s.length, item });
      flat += s;
      if (item.hasEOL) flat += "\n"; else flat += " ";
    }
    map.set(i, { flat, ranges, width: vp.width, height: vp.height });
    page.cleanup?.();
  }
  return map;
}

// Given a per-page text content (from extractPdfPageTextContent), find
// a caption-like prefix (e.g., "Figure 2A") and return its normalized
// bounding rect. Returns null if not found.
export function findCaptionRectInPageContent(pageContent, label) {
  if (!pageContent || !label) return null;
  const { flat, ranges, width, height } = pageContent;
  const head = label.split(/[.:]/)[0].trim().slice(0, 60);
  if (head.length < 5) return null;
  const probes = [
    head,
    head.replace(/^Figure\s+/i, "Fig. "),
    head.replace(/^Fig\.?\s+/i, "Figure "),
    head.replace(/^Table\s+/i, "Tbl. "),
  ];
  for (const probe of probes) {
    let i = flat.indexOf(probe);
    if (i === -1) i = flat.toLowerCase().indexOf(probe.toLowerCase());
    if (i === -1) continue;
    const targetStart = i, targetEnd = i + probe.length;
    const inRange = ranges.filter((r) => r.start < targetEnd && r.end > targetStart);
    if (!inRange.length) continue;
    let left = Infinity, right = -Infinity, topY = -Infinity, bottomY = Infinity;
    for (const r of inRange) {
      const tx = r.item.transform;
      const x = tx[4];
      const yBase = tx[5];
      const h = r.item.height || Math.abs(tx[3]) || 12;
      const w = r.item.width || 0;
      if (x < left) left = x;
      if (x + w > right) right = x + w;
      if (yBase > topY) topY = yBase;
      if (yBase - h < bottomY) bottomY = yBase - h;
    }
    return {
      left: Math.max(0, left / width),
      top: Math.max(0, 1 - topY / height),
      width: Math.min(1, (right - left) / width),
      height: Math.min(1, (topY - bottomY) / height),
    };
  }
  return null;
}

// Build a plain-text dump of a PDF for the Reader. Each page is
// preceded by a `[Page N]\n` marker so the model can return page hints.
export async function extractPdfText(pdfDoc) {
  if (!pdfDoc) return "";
  const out = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
    out.push(`[Page ${i}]\n${text}`);
    page.cleanup?.();
  }
  return out.join("\n\n");
}

export function extractFlowText(flowDoc, viewerContainer) {
  // Send the RENDERED article text (what the resolver will search)
  // rather than the raw source. For Markdown, this means stripped of
  // `##` heading prefixes, `*` emphasis markers, link syntax, etc. —
  // so the model's verbatim quotes anchor against the same DOM the
  // resolver walks. Falls back to the raw text when the article hasn't
  // been rendered yet (rare for flow docs since render is synchronous).
  const article = viewerContainer?.querySelector(".flow-doc");
  if (article) return article.textContent || "";
  return flowDoc?.text || "";
}

// Given a flat doc string and a verbatim quote, locate the quote and
// return { found, contextBefore, contextAfter, page }. Page is parsed
// from the nearest `[Page N]` marker preceding the quote (PDF only).
export function locateQuote(docText, quote) {
  if (!docText || !quote) return { found: false };
  // Exact-case first; fall back to case-insensitive.
  let idx = docText.indexOf(quote);
  if (idx === -1) {
    const lower = docText.toLowerCase();
    idx = lower.indexOf(quote.toLowerCase());
  }
  if (idx === -1) return { found: false };
  const before = docText.slice(Math.max(0, idx - CONTEXT_LEN), idx);
  const after = docText.slice(idx + quote.length, idx + quote.length + CONTEXT_LEN);
  // Page marker: find the last `[Page N]` before this index (PDF only).
  let page = null;
  const head = docText.slice(0, idx);
  const m = head.match(/\[Page (\d+)\][^[]*$/);
  if (m) page = parseInt(m[1], 10);
  return { found: true, index: idx, contextBefore: before, contextAfter: after, page };
}
