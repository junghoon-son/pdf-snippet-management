import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export async function loadDocument(data) {
  return pdfjsLib.getDocument({ data }).promise;
}

let currentScale = 1;
const pageStates = new Map();
let pageObserver = null;

export async function renderPages(pdf, container, scale) {
  currentScale = scale;
  if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
  pageStates.clear();
  _pageHashes.clear();
  _pageBuckets.clear();
  _lastSnippets = [];
  _hoverSnippetId = null;
  container.innerHTML = "";

  const pageHandles = await Promise.all(
    Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)),
  );

  for (let i = 0; i < pageHandles.length; i++) {
    const pageNum = i + 1;
    const page = pageHandles[i];
    const viewport = page.getViewport({ scale });

    const wrap = document.createElement("div");
    wrap.className = "page-wrap pending";
    wrap.dataset.page = String(pageNum);
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;

    const highlightLayer = document.createElement("canvas");
    highlightLayer.className = "highlight-layer";
    highlightLayer.width = Math.floor(viewport.width);
    highlightLayer.height = Math.floor(viewport.height);
    highlightLayer.style.width = `${viewport.width}px`;
    highlightLayer.style.height = `${viewport.height}px`;
    wrap.appendChild(highlightLayer);

    container.appendChild(wrap);

    pageStates.set(pageNum, {
      wrap, page, viewport, highlightLayer,
      canvas: null, textLayer: null,
      rendered: false, renderPromise: null,
    });
  }

  const root = container.closest("#viewer-scroll") || null;
  pageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const pageNum = parseInt(entry.target.dataset.page, 10);
        renderPage(pageNum);
      }
    }
  }, {
    root,
    rootMargin: "200% 0px",
    threshold: 0,
  });

  for (const ps of pageStates.values()) {
    pageObserver.observe(ps.wrap);
  }
}

async function renderPage(pageNum) {
  const ps = pageStates.get(pageNum);
  if (!ps || ps.rendered) return;
  if (ps.renderPromise) return ps.renderPromise;

  ps.renderPromise = (async () => {
    const { wrap, page, viewport, highlightLayer } = ps;
    const dpr = window.devicePixelRatio || 1;

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    wrap.insertBefore(canvas, highlightLayer);

    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;
    textLayer.style.setProperty("--scale-factor", String(currentScale));
    wrap.insertBefore(textLayer, highlightLayer);

    try {
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

      ps.canvas = canvas;
      ps.textLayer = textLayer;
      ps.rendered = true;
      wrap.classList.remove("pending");
    } catch (err) {
      console.warn(`pdf page ${pageNum} render failed`, err);
      canvas.remove();
      textLayer.remove();
      ps.renderPromise = null;
    }
  })();
  return ps.renderPromise;
}

export async function ensurePageRendered(pageNum) {
  return renderPage(pageNum);
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

const HL_FILL = "#ffd75a";
const HL_HOVER_FILL = "#ffaa28";
const HL_IMAGE_STROKE = "#2ea58c";
const HL_IMAGE_HOVER_STROKE = "#6ee0c5";

let _lastSnippets = [];
let _hoverSnippetId = null;
const _pageBuckets = new Map();
const _pageHashes = new Map();

function bucketByPage(snippets) {
  _pageBuckets.clear();
  for (const s of snippets) {
    if (!_pageBuckets.has(s.page)) _pageBuckets.set(s.page, []);
    const arr = _pageBuckets.get(s.page);
    for (const r of s.rects || []) arr.push({ rect: r, snippet: s });
  }
}

function hashItems(items, hoverId) {
  if (!items || items.length === 0) return "";
  const parts = [];
  for (const it of items) {
    const r = it.rect;
    const hot = it.snippet.id === hoverId ? "h" : "n";
    parts.push(
      `${it.snippet.id}:${it.snippet.kind || "t"}:${hot}:` +
      `${r.left.toFixed(4)},${r.top.toFixed(4)},${r.width.toFixed(4)},${r.height.toFixed(4)}`,
    );
  }
  parts.sort();
  return parts.join("|");
}

export function applyHighlights(container, snippets) {
  _lastSnippets = snippets || [];
  bucketByPage(_lastSnippets);
  for (const ps of pageStates.values()) {
    const pageNum = parseInt(ps.wrap.dataset.page, 10);
    const items = _pageBuckets.get(pageNum) || [];
    const hash = hashItems(items, _hoverSnippetId);
    if (_pageHashes.get(pageNum) === hash) continue;
    paintHighlightCanvas(ps.highlightLayer, items);
    _pageHashes.set(pageNum, hash);
  }
}

export function setHoverSnippetId(id) {
  const prev = _hoverSnippetId;
  if (id === prev) return;
  _hoverSnippetId = id;
  const pagesToRepaint = new Set();
  if (prev) {
    const s = _lastSnippets.find((x) => x.id === prev);
    if (s) pagesToRepaint.add(s.page);
  }
  if (id) {
    const s = _lastSnippets.find((x) => x.id === id);
    if (s) pagesToRepaint.add(s.page);
  }
  for (const page of pagesToRepaint) {
    const ps = pageStates.get(page);
    if (ps) repaintPage(ps);
  }
}

export function pulseSnippet(snippetId) {
  const s = _lastSnippets.find((x) => x.id === snippetId);
  if (!s) return;
  const ps = pageStates.get(s.page);
  if (!ps) return;
  for (const r of s.rects || []) {
    const div = document.createElement("div");
    div.className = "hl-pulse";
    div.style.left = `${r.left * 100}%`;
    div.style.top = `${r.top * 100}%`;
    div.style.width = `${r.width * 100}%`;
    div.style.height = `${r.height * 100}%`;
    ps.wrap.appendChild(div);
    setTimeout(() => div.remove(), 720);
  }
}

function repaintPage(ps) {
  const pageNum = parseInt(ps.wrap.dataset.page, 10);
  const items = _pageBuckets.get(pageNum) || [];
  paintHighlightCanvas(ps.highlightLayer, items);
  _pageHashes.set(pageNum, hashItems(items, _hoverSnippetId));
}

function paintHighlightCanvas(canvas, items) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (items.length === 0) return;

  items.sort((a, b) => rectArea(b.rect) - rectArea(a.rect));
  const placed = [];
  for (const item of items) {
    const covered = placed.some((p) =>
      p.snippet.id !== item.snippet.id && rectContains(p.rect, item.rect),
    );
    if (covered) continue;
    placed.push(item);
  }

  for (const { rect, snippet } of placed) {
    if (snippet.kind === "image") continue;
    ctx.fillStyle = snippet.id === _hoverSnippetId ? HL_HOVER_FILL : HL_FILL;
    ctx.fillRect(rect.left * W, rect.top * H, rect.width * W, rect.height * H);
  }

  for (const { rect, snippet } of placed) {
    if (snippet.kind !== "image") continue;
    const hot = snippet.id === _hoverSnippetId;
    ctx.strokeStyle = hot ? HL_IMAGE_HOVER_STROKE : HL_IMAGE_STROKE;
    ctx.lineWidth = hot ? 2.5 : 1.5;
    ctx.strokeRect(
      rect.left * W + 0.75,
      rect.top * H + 0.75,
      Math.max(0, rect.width * W - 1.5),
      Math.max(0, rect.height * H - 1.5),
    );
  }
}
