// Image-source viewer — renders a single PNG/JPEG as a one-page document
// inside the same `.page-wrap` structure the PDF viewer uses. Reusing
// the wrap structure means highlight rendering, AI preview overlays,
// the rect-draw tool, and the resize/scale layers all work without
// branching at the call sites — they just see a one-page document.
//
// No textLayer: image sources have no extractable text (see SPEC §7.3).
// The anchoring algorithm doesn't run on this kind of source.

// One-source-at-a-time state — same lifecycle as pdf-viewer.js (cleared
// on each renderImagePage call). Holds the natural-pixel dimensions
// so re-renders at a different scale don't need to re-decode the bytes.
let _natural = { width: 0, height: 0 };
let _imgEl = null;
let _objectUrl = null;

export async function renderImagePage(container, bytes, mime, scale) {
  // Free the previous source's object URL if any — leaving them
  // attached leaks blobs across doc switches.
  if (_objectUrl) {
    URL.revokeObjectURL(_objectUrl);
    _objectUrl = null;
  }
  container.innerHTML = "";

  const blob = new Blob([bytes], { type: mime || "image/png" });
  _objectUrl = URL.createObjectURL(blob);

  // Decode first so we know the natural dimensions before laying out
  // the page-wrap — otherwise the wrap would briefly be zero-sized.
  const img = new Image();
  img.src = _objectUrl;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("Failed to decode image"));
  });
  _natural = { width: img.naturalWidth, height: img.naturalHeight };
  _imgEl = img;

  const renderW = Math.floor(img.naturalWidth * scale);
  const renderH = Math.floor(img.naturalHeight * scale);

  const wrap = document.createElement("div");
  wrap.className = "page-wrap";
  wrap.dataset.page = "1";
  wrap.style.width = `${renderW}px`;
  wrap.style.height = `${renderH}px`;

  img.style.width = `${renderW}px`;
  img.style.height = `${renderH}px`;
  img.style.display = "block";
  img.style.userSelect = "none";
  img.draggable = false;
  img.className = "image-source";
  wrap.appendChild(img);

  // Match the PDF page's highlight canvas — the snippet-highlight
  // painter writes to this layer regardless of source kind.
  const dpr = window.devicePixelRatio || 1;
  const highlightLayer = document.createElement("canvas");
  highlightLayer.className = "highlight-layer";
  highlightLayer.width = Math.floor(renderW * dpr);
  highlightLayer.height = Math.floor(renderH * dpr);
  highlightLayer.style.width = `${renderW}px`;
  highlightLayer.style.height = `${renderH}px`;
  wrap.appendChild(highlightLayer);

  container.appendChild(wrap);

  return { naturalWidth: _natural.width, naturalHeight: _natural.height };
}

export function getImageNaturalDimensions() {
  return { ..._natural };
}

// Crop the source image to the fractional rect and return PNG bytes —
// parallel to pdf-viewer.js's renderRegionPng. hiresScale is unused
// for raster sources (the image IS the canonical resolution), but kept
// in the signature for caller symmetry.
export async function renderImageRegionPng(fracRect, _hiresScale = 1) {
  if (!_imgEl || !_natural.width || !_natural.height) {
    throw new Error("renderImageRegionPng: no image source mounted");
  }
  const fullW = _natural.width;
  const fullH = _natural.height;
  const cropX = Math.max(0, Math.floor(fracRect.left * fullW));
  const cropY = Math.max(0, Math.floor(fracRect.top * fullH));
  const cropW = Math.min(fullW - cropX, Math.ceil(fracRect.width * fullW));
  const cropH = Math.min(fullH - cropY, Math.ceil(fracRect.height * fullH));
  if (cropW <= 0 || cropH <= 0) {
    throw new Error("renderImageRegionPng: empty crop");
  }

  const out = document.createElement("canvas");
  out.width = cropW;
  out.height = cropH;
  out.getContext("2d").drawImage(_imgEl, -cropX, -cropY);

  return await new Promise((resolve, reject) => {
    out.toBlob((blob) => {
      if (!blob) return reject(new Error("toBlob failed"));
      const reader = new FileReader();
      reader.onloadend = () => resolve(new Uint8Array(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    }, "image/png");
  });
}

// Return the active source image as base64 PNG/JPEG (whichever encoding
// the user opened with). Used by the AI Reader vision-pass — the whole
// image is the one and only "page image" for image sources.
export async function getSourceImageBase64() {
  if (!_imgEl) throw new Error("getSourceImageBase64: no image source mounted");
  // Round-trip through canvas so we always emit a clean PNG regardless
  // of the source encoding — avoids ambiguity in the model's input
  // media_type and handles JPEGs uniformly.
  const c = document.createElement("canvas");
  c.width = _natural.width;
  c.height = _natural.height;
  c.getContext("2d").drawImage(_imgEl, 0, 0);
  const dataUrl = c.toDataURL("image/png");
  return { base64: dataUrl.split(",")[1], mediaType: "image/png" };
}

// Pick the scale that fits the image to the given available pixel width
// (parallel to fitWidthScale in pdf-viewer.js). Clamped to at most 1 so
// we don't upscale below-screen images and pixellate them needlessly;
// the user can still zoom in manually.
export function fitWidthScaleImage(availableWidth) {
  if (!_natural.width) return 1;
  return Math.min(1, availableWidth / _natural.width);
}
