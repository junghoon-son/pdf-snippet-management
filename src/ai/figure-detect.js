// Deterministic figure-region detection for PDFs.
//
// The principle: a PDF page has two coexisting layers — a text layer
// (positioned text runs) and a canvas layer (rastered visual content).
// Where the text layer is sparse but the canvas has non-white content,
// that's a figure (chart, diagram, photo). Where both are sparse,
// it's whitespace. Where text is dense, it's body text.
//
// This module returns a list of candidate figure rects per page so the
// vision model can pick by index rather than estimate coordinates.

const GRID_COLS = 32;
const GRID_ROWS = 44;

// Build a 0/1 grid of text occupancy from PDF.js textContent items.
// Each item's transform matrix gives bottom-left in PDF user space;
// we convert to normalized top-left coords.
function buildTextGrid(textContent, viewport) {
  const grid = new Uint8Array(GRID_COLS * GRID_ROWS);
  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;
    const tx = item.transform;
    const x = tx[4] / viewport.width;
    // PDF y is bottom-up; textContent uses the same; viewport height
    // accounts for the rotation. tx[5] is the baseline y.
    const yBase = tx[5];
    const itemHeight = item.height || Math.abs(tx[3]) || 12;
    const top = 1 - (yBase + itemHeight) / viewport.height;
    const w = (item.width || 0) / viewport.width;
    const h = itemHeight / viewport.height;
    const c1 = Math.max(0, Math.floor(x * GRID_COLS));
    const c2 = Math.min(GRID_COLS, Math.ceil((x + w) * GRID_COLS));
    const r1 = Math.max(0, Math.floor(top * GRID_ROWS));
    const r2 = Math.min(GRID_ROWS, Math.ceil((top + h) * GRID_ROWS));
    for (let r = r1; r < r2; r++) for (let c = c1; c < c2; c++) {
      grid[r * GRID_COLS + c] = 1;
    }
  }
  return grid;
}

// Build a 0/1 grid of canvas content occupancy. Sample the rendered
// canvas at cell-center points; a cell is "occupied" if the local
// region is meaningfully non-white. This catches figures (drawn
// content) while ignoring page margins / whitespace.
function buildCanvasGrid(canvas) {
  const grid = new Uint8Array(GRID_COLS * GRID_ROWS);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  // Sample at a downscaled resolution: one ImageData per cell, average
  // luminance. Threshold ~245 (out of 255) = "has visible content".
  const cellW = canvas.width / GRID_COLS;
  const cellH = canvas.height / GRID_ROWS;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const x0 = Math.floor(c * cellW);
      const y0 = Math.floor(r * cellH);
      const w = Math.max(1, Math.floor(cellW));
      const h = Math.max(1, Math.floor(cellH));
      try {
        const data = ctx.getImageData(x0, y0, w, h).data;
        // Cheap average luminance; full sample not needed.
        let sum = 0;
        const stride = Math.max(1, Math.floor(data.length / 64));
        let count = 0;
        for (let i = 0; i < data.length; i += stride * 4) {
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          count++;
        }
        const avg = sum / count;
        if (avg < 245) grid[r * GRID_COLS + c] = 1;
      } catch {}
    }
  }
  return grid;
}

// Flood-fill connected components of text-free + canvas-occupied
// cells. Returns an array of bounding-box rects {left, top, width, height}
// in normalized 0..1 coords + cell count for filtering.
function findFigureComponents(textGrid, canvasGrid) {
  const visited = new Uint8Array(GRID_COLS * GRID_ROWS);
  const rects = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const i = r * GRID_COLS + c;
      if (visited[i]) continue;
      if (textGrid[i]) continue;     // skip text cells
      if (!canvasGrid[i]) continue;  // skip whitespace
      // BFS
      const queue = [[r, c]];
      visited[i] = 1;
      let minR = r, maxR = r, minC = c, maxC = c, count = 0;
      while (queue.length) {
        const [rr, cc] = queue.shift();
        count++;
        if (rr < minR) minR = rr;
        if (rr > maxR) maxR = rr;
        if (cc < minC) minC = cc;
        if (cc > maxC) maxC = cc;
        for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nr = rr + dr, nc = cc + dc;
          if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
          const ni = nr * GRID_COLS + nc;
          if (visited[ni]) continue;
          if (textGrid[ni]) continue;
          if (!canvasGrid[ni]) continue;
          visited[ni] = 1;
          queue.push([nr, nc]);
        }
      }
      const left   = minC / GRID_COLS;
      const top    = minR / GRID_ROWS;
      const right  = (maxC + 1) / GRID_COLS;
      const bottom = (maxR + 1) / GRID_ROWS;
      rects.push({
        left, top,
        width:  right - left,
        height: bottom - top,
        cells: count,
      });
    }
  }
  return rects;
}

// Filter out tiny noise + page-spanning false positives. Heuristics:
// - cell count >= 12 (avoid tiny artefacts)
// - area between ~2% and ~75% of page (figures usually aren't full-page)
function filterCandidates(rects) {
  return rects.filter((r) => {
    if (r.cells < 6) return false;
    const area = r.width * r.height;
    if (area < 0.01) return false;
    if (area > 0.85) return false;
    return true;
  });
}

// Dilate a 0/1 grid by 1 cell (4-neighbour). Bridges tiny gaps.
function dilateGrid(grid) {
  const out = new Uint8Array(grid.length);
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const i = r * GRID_COLS + c;
      if (!grid[i]) continue;
      out[i] = 1;
      if (r > 0) out[i - GRID_COLS] = 1;
      if (r < GRID_ROWS - 1) out[i + GRID_COLS] = 1;
      if (c > 0) out[i - 1] = 1;
      if (c < GRID_COLS - 1) out[i + 1] = 1;
    }
  }
  return out;
}

// Erode a 0/1 grid by 1 cell — a cell stays occupied only if at least
// 3 of its 4-neighbours are also occupied. This removes isolated text
// cells (axis labels, single-number ticks, panel letters) while keeping
// dense body-text blocks intact. Used on the text grid so figures with
// embedded labels don't get fragmented during component detection.
function erodeGridText(grid) {
  const out = new Uint8Array(grid.length);
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const i = r * GRID_COLS + c;
      if (!grid[i]) continue;
      let n = 0;
      if (r > 0 && grid[i - GRID_COLS]) n++;
      if (r < GRID_ROWS - 1 && grid[i + GRID_COLS]) n++;
      if (c > 0 && grid[i - 1]) n++;
      if (c < GRID_COLS - 1 && grid[i + 1]) n++;
      if (n >= 3) out[i] = 1;
    }
  }
  return out;
}

// Pad each rect by ~1.5% to capture axis labels/edges that may sit
// just inside text territory. Clamp to 0..1.
function padRects(rects, pad = 0.015) {
  return rects.map((r) => {
    const left = Math.max(0, r.left - pad);
    const top = Math.max(0, r.top - pad);
    const right = Math.min(1, r.left + r.width + pad);
    const bottom = Math.min(1, r.top + r.height + pad);
    return {
      left,
      top,
      width: right - left,
      height: bottom - top,
    };
  });
}

// 2D affine matrix multiplication, PDF column-major convention.
// CTM as [a, b, c, d, e, f] where the matrix is:
//   [ a c e ]
//   [ b d f ]
//   [ 0 0 1 ]
function multiplyMatrix(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

// Walk a page's operator list to find Image XObject paint operations.
// PDFs embed raster figures (photos, screenshots, rendered panels) as
// Image XObjects with explicit bounding boxes baked into the PDF
// stream — these are pixel-perfect, model-free, license-free detections.
//
// Vector charts (matplotlib plots etc.) don't appear as Image XObjects
// — they're drawn as path operations. Those fall back to the existing
// grid detector.
async function detectImageXObjectsForPage(pdfDoc, pageNum, pdfjsLib) {
  const page = await pdfDoc.getPage(pageNum);
  let ops;
  try {
    ops = await page.getOperatorList();
  } catch (err) {
    console.warn(`[layout] op-list failed for page ${pageNum}:`, err);
    page.cleanup?.();
    return [];
  }
  const vp = page.getViewport({ scale: 1 });

  // OPS constants vary slightly across pdfjs versions; resolve them
  // defensively. The codes are stable but the exported object may not
  // always be present in older builds.
  const OPS = pdfjsLib?.OPS || {};
  const OP_SAVE      = OPS.save                   ?? 10;
  const OP_RESTORE   = OPS.restore                ?? 11;
  const OP_TRANSFORM = OPS.transform              ?? 12;
  const OP_IMG       = OPS.paintImageXObject      ?? 85;
  const OP_INLINE    = OPS.paintInlineImageXObject ?? 86;
  const OP_IMG_REPEAT = OPS.paintImageXObjectRepeat ?? 88;

  const ctmStack = [[1, 0, 0, 1, 0, 0]];
  let ctm = [1, 0, 0, 1, 0, 0];
  const rects = [];

  for (let j = 0; j < ops.fnArray.length; j++) {
    const fn = ops.fnArray[j];
    const args = ops.argsArray[j];
    if (fn === OP_SAVE) {
      ctmStack.push([...ctm]);
    } else if (fn === OP_RESTORE) {
      ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0];
    } else if (fn === OP_TRANSFORM) {
      // args = [a, b, c, d, e, f]
      ctm = multiplyMatrix(ctm, args);
    } else if (fn === OP_IMG || fn === OP_INLINE || fn === OP_IMG_REPEAT) {
      // Image is painted with a 1×1 user-space box transformed by ctm.
      // Compute the 4 corners and take the axis-aligned bounding box.
      const [a, b, c, d, e, f] = ctm;
      const xs = [e, a + e, c + e, a + c + e];
      const ys = [f, b + f, d + f, b + d + f];
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      const bottom = Math.min(...ys);
      const top = Math.max(...ys);
      rects.push({ left, right, bottom, top });
    }
  }
  page.cleanup?.();

  // Normalize to top-left origin, 0..1 fractions. Filter out tiny
  // images (logos, decorative icons under 5%) and full-page raster
  // overlays (likely background scans, > 95%).
  const out = [];
  for (const r of rects) {
    const norm = {
      left:   r.left / vp.width,
      top:    1 - (r.top / vp.height),
      width:  (r.right - r.left) / vp.width,
      height: (r.top - r.bottom) / vp.height,
    };
    if (norm.width < 0.05 || norm.height < 0.05) continue;
    if (norm.width > 0.95 && norm.height > 0.95) continue;
    norm.left = Math.max(0, Math.min(1, norm.left));
    norm.top = Math.max(0, Math.min(1, norm.top));
    norm.width = Math.max(0, Math.min(1 - norm.left, norm.width));
    norm.height = Math.max(0, Math.min(1 - norm.top, norm.height));
    out.push(norm);
  }
  return out;
}

// Compute IoU between two normalized rects.
function iouRect(a, b) {
  const ax2 = a.left + a.width, ay2 = a.top + a.height;
  const bx2 = b.left + b.width, by2 = b.top + b.height;
  const iw = Math.max(0, Math.min(ax2, bx2) - Math.max(a.left, b.left));
  const ih = Math.max(0, Math.min(ay2, by2) - Math.max(a.top, b.top));
  const inter = iw * ih;
  const uni = a.width * a.height + b.width * b.height - inter;
  return uni > 0 ? inter / uni : 0;
}

// Merge two candidate lists for the same page. Prefers Image XObject
// rects (pixel-accurate); appends grid candidates only when they don't
// overlap an existing pick (IoU < 0.3).
function mergeCandidates(priority, secondary) {
  const out = priority.slice();
  for (const c of secondary) {
    if (out.some((p) => iouRect(p, c) > 0.3)) continue;
    out.push(c);
  }
  // Re-letter by reading order (top-to-bottom, left-to-right).
  out.sort((a, b) => a.top - b.top || a.left - b.left);
  return out.map((r, i) => ({
    id: String.fromCharCode(65 + i),
    left: r.left, top: r.top, width: r.width, height: r.height,
    source: r.source || "grid",
  }));
}

// Public: detect candidate figure rects on every page of a pdfDoc.
// Renders each page once at a moderate resolution for canvas
// inspection; returns { page, candidates: [{ id, left, top, width, height }] }
// for each page. `id` is a stable letter (A, B, C…) per page so the
// model can refer by ID.
export async function detectFiguresPerPage(pdfDoc, { targetWidth = 800 } = {}) {
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
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    // Fill white so transparent regions count as whitespace.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const textContent = await page.getTextContent();
    const baseViewport = page.getViewport({ scale: 1 });

    const textGridRaw = buildTextGrid(textContent, baseViewport);
    // Erode text grid so isolated text cells (axis labels, panel letters,
    // legend single-words inside a chart) don't disqualify their region
    // from being a figure. Only dense text blocks survive erosion.
    const textGrid = erodeGridText(textGridRaw);
    const canvasGridRaw = buildCanvasGrid(canvas);
    // Dilate canvas content so adjacent visual elements separated by a
    // pixel-thin gap (e.g., chart axes vs plot area) form one component.
    const canvasGrid = dilateGrid(canvasGridRaw);
    const raw = findFigureComponents(textGrid, canvasGrid);
    const filtered = padRects(filterCandidates(raw));

    const candidates = filtered.map((r, idx) => ({
      id: String.fromCharCode(65 + idx),
      ...r,
      source: "grid",
    }));
    out.push({ page: i, candidates });
    page.cleanup?.();
  }
  return out;
}

// Hybrid figure detector — A) Image XObject extraction from the PDF
// operator list (license-free, pixel-perfect for raster figures);
// B) grid + canvas heuristic for vector charts that aren't Image
// XObjects. Merged by IoU so the same figure isn't double-listed.
//
// This is the default detector. Returns the same candidate shape as
// the grid-only version: [{ page, candidates: [{ id, ... }] }].
export async function detectFiguresHybrid(pdfDoc, opts = {}) {
  if (!pdfDoc) return [];
  const pdfjsLib = await import("pdfjs-dist");
  const gridResults = await detectFiguresPerPage(pdfDoc, opts);
  const merged = [];
  for (const pg of gridResults) {
    const xobj = await detectImageXObjectsForPage(pdfDoc, pg.page, pdfjsLib);
    const xobjCandidates = xobj.map((r) => ({ ...r, source: "image-xobject" }));
    // Strip IDs so mergeCandidates can re-assign in reading order.
    const stripped = (pg.candidates || []).map(({ id, ...r }) => r);
    const candidates = mergeCandidates(xobjCandidates, stripped);
    merged.push({ page: pg.page, candidates });
  }
  return merged;
}

// Stringify detection results for inclusion in a prompt.
export function formatDetectionForPrompt(detections) {
  const lines = [];
  for (const { page, candidates } of detections) {
    if (!candidates.length) continue;
    lines.push(`Page ${page} candidate figure regions:`);
    for (const c of candidates) {
      lines.push(`  ${c.id}: left=${c.left.toFixed(3)} top=${c.top.toFixed(3)} width=${c.width.toFixed(3)} height=${c.height.toFixed(3)}`);
    }
  }
  return lines.length ? lines.join("\n") : "(no candidate figure regions detected)";
}
