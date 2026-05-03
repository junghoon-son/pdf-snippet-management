import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export async function loadDocument(data) {
  return pdfjsLib.getDocument({ data }).promise;
}

export async function renderPages(pdf, container, scale) {
  container.innerHTML = "";
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;

    const wrap = document.createElement("div");
    wrap.className = "page-wrap";
    wrap.dataset.page = String(pageNum);
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    wrap.appendChild(canvas);

    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;
    textLayer.style.setProperty("--scale-factor", String(scale));
    wrap.appendChild(textLayer);

    const highlightLayer = document.createElement("div");
    highlightLayer.className = "highlight-layer";
    wrap.appendChild(highlightLayer);

    container.appendChild(wrap);

    const ctx = canvas.getContext("2d");
    const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
    await page.render({ canvasContext: ctx, viewport, transform }).promise;

    const textContent = await page.getTextContent();
    const tl = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayer,
      viewport,
    });
    await tl.render();
  }
}

export async function fitWidthScale(pdf, availableWidth) {
  const page = await pdf.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  return availableWidth / baseViewport.width;
}

export async function renderRegionPng(pdf, pageNum, fracRect, hiresScale = 2) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: hiresScale });
  const fullW = Math.floor(viewport.width);
  const fullH = Math.floor(viewport.height);

  const cropX = Math.max(0, Math.floor(fracRect.left * fullW));
  const cropY = Math.max(0, Math.floor(fracRect.top * fullH));
  const cropW = Math.min(fullW - cropX, Math.ceil(fracRect.width * fullW));
  const cropH = Math.min(fullH - cropY, Math.ceil(fracRect.height * fullH));

  const out = document.createElement("canvas");
  out.width = cropW;
  out.height = cropH;
  await page.render({
    canvasContext: out.getContext("2d"),
    viewport,
    transform: [1, 0, 0, 1, -cropX, -cropY],
  }).promise;

  return await new Promise((resolve, reject) => {
    out.toBlob((blob) => {
      if (!blob) return reject(new Error("toBlob failed"));
      const reader = new FileReader();
      reader.onloadend = () => {
        const buf = reader.result;
        resolve(new Uint8Array(buf));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    }, "image/png");
  });
}

export function getSelectionSnippet() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const text = sel.toString().trim();
  if (!text) return null;

  const range = sel.getRangeAt(0);
  const wrap = findPageWrap(range.commonAncestorContainer);
  if (!wrap) return null;
  const pageNum = parseInt(wrap.dataset.page, 10);

  const wrapRect = wrap.getBoundingClientRect();
  const rects = Array.from(range.getClientRects())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({
      left: (r.left - wrapRect.left) / wrapRect.width,
      top: (r.top - wrapRect.top) / wrapRect.height,
      width: r.width / wrapRect.width,
      height: r.height / wrapRect.height,
    }));

  if (rects.length === 0) return null;
  return { page: pageNum, text, rects };
}

function findPageWrap(node) {
  let n = node.nodeType === 1 ? node : node.parentElement;
  while (n && !n.classList?.contains("page-wrap")) n = n.parentElement;
  return n;
}

function rectArea(r) {
  return Math.max(0, r.width) * Math.max(0, r.height);
}
function rectContains(big, small) {
  const eps = 0.004;
  return small.left >= big.left - eps &&
         small.top >= big.top - eps &&
         small.left + small.width <= big.left + big.width + eps &&
         small.top + small.height <= big.top + big.height + eps;
}

export function applyHighlights(container, snippets) {
  container.querySelectorAll(".highlight-layer").forEach((l) => (l.innerHTML = ""));
  const byPage = new Map();
  for (const s of snippets) {
    if (!byPage.has(s.page)) byPage.set(s.page, []);
    for (const r of s.rects || []) {
      byPage.get(s.page).push({ rect: r, snippet: s });
    }
  }
  for (const [page, items] of byPage) {
    const wrap = container.querySelector(`.page-wrap[data-page="${page}"]`);
    if (!wrap) continue;
    const layer = wrap.querySelector(".highlight-layer");
    items.sort((a, b) => rectArea(b.rect) - rectArea(a.rect));
    const placed = [];
    for (const { rect, snippet } of items) {
      const covered = placed.some((p) =>
        p.snippet.id !== snippet.id && rectContains(p.rect, rect),
      );
      if (covered) continue;
      placed.push({ rect, snippet });
      const div = document.createElement("div");
      div.className = snippet.kind === "image" ? "hl hl-image" : "hl";
      div.dataset.snippetId = snippet.id;
      div.style.left = `${rect.left * 100}%`;
      div.style.top = `${rect.top * 100}%`;
      div.style.width = `${rect.width * 100}%`;
      div.style.height = `${rect.height * 100}%`;
      layer.appendChild(div);
    }
  }
}
