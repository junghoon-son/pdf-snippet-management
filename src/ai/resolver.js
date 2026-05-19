// Resolve a verbatim quote from an LLM into a canonical Marklee
// snippet, using the document's actual DOM (rendered article for flow
// docs, rendered text-layer spans for PDFs). The shape returned matches
// what `getSelectionFlowSnippet` / `getSelectionSnippet` produce when
// the user makes the selection by hand — so AI-accepted snippets are
// indistinguishable from manual ones in the sidecar.

import { normalizeText } from "../flow-viewer.js";

const CONTEXT_LEN = 40;

// Walk every text node of `root`, return [{ node, start, end, len }]
// plus the concatenated flat-text string. `start`/`end` are absolute
// offsets into the flat string.
function buildTextIndex(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentNode;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.nodeName;
      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let flat = "";
  let n;
  while ((n = walker.nextNode())) {
    const v = n.nodeValue || "";
    if (!v) continue;
    nodes.push({ node: n, start: flat.length, end: flat.length + v.length, len: v.length });
    flat += v;
  }
  return { nodes, flat };
}

// Locate a flat-string offset (0..flat.length) back to its (node, offset).
function locateOffset(nodes, offset) {
  let lo = 0, hi = nodes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = nodes[mid];
    if (offset < e.start) hi = mid - 1;
    else if (offset > e.end) lo = mid + 1;
    else return { node: e.node, offset: offset - e.start };
  }
  return null;
}

// Character classes for "fuzzy-equivalent" symbols. LLMs routinely
// normalize en/em dashes to hyphen-minus, smart quotes to straight,
// collapse weird spaces. Any character from a class matches any other
// in the same class.
const DASH_CLASS  = "[\\u002D\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015\\u2212]";
const DQUOTE_CLASS = "[\"\\u201C\\u201D\\u201E\\u201F\\u2033]";
const SQUOTE_CLASS = "[\\u0027\\u2018\\u2019\\u201A\\u201B\\u2032]";
const ELLIPSIS_CLASS = "(?:\\u2026|\\.{3})";

// Try to find `quote` in `flat`. Returns [start,end] in the ORIGINAL
// `flat` coordinate space, or null. Iterates over tiers from strict to
// loose; first hit wins. Designed for LLM quotes which routinely differ
// from the source by whitespace, dash/quote normalization, ligatures,
// soft hyphens, line-end hyphenation, leading numbering, and case.
export function findInFlat(flat, quote) {
  if (!flat || !quote) return null;

  // (1) Exact substring.
  let i = flat.indexOf(quote);
  if (i !== -1) return [i, i + quote.length];

  // (2) Whitespace + dash/quote-tolerant regex.
  const re = buildFuzzyRegex(quote);
  if (re) {
    const m = re.exec(flat);
    if (m) return [m.index, m.index + m[0].length];
  }

  // (3) Strip leading numbering prefix and retry exact + fuzzy regex.
  const stripped = quote.replace(/^\s*(?:\d{1,3}|[IVXLivxl]{1,5}|[a-zA-Z])[.)]\s+/, "");
  if (stripped && stripped !== quote) {
    const i2 = flat.indexOf(stripped);
    if (i2 !== -1) return [i2, i2 + stripped.length];
    const re2 = buildFuzzyRegex(stripped);
    if (re2) {
      const m = re2.exec(flat);
      if (m) return [m.index, m.index + m[0].length];
    }
  }

  // (4) Aggressive normalize-fuzzy match — both sides go through a
  //     full canonicalization pass (NFC, ligatures, dashes, quotes,
  //     line-end hyphenation, soft hyphens, whitespace, case). We map
  //     normalized offsets back to original offsets via a position
  //     table built during normalization.
  const flatMap = normalizeWithMap(flat);
  const quoteNorm = normalizeWithMap(quote).norm;
  if (quoteNorm) {
    const j = flatMap.norm.indexOf(quoteNorm);
    if (j !== -1) {
      const origStart = flatMap.origOf[j] ?? 0;
      const origEnd = flatMap.origOf[j + quoteNorm.length] ?? flat.length;
      if (origEnd > origStart) return [origStart, origEnd];
    }
    // (5) Substring anchor — find the first ~60 normalized chars of the
    //     quote; if anchored, expand by the quote's normalized length.
    //     Catches cases where the tail of the quote drifted but the head
    //     is intact (common when the model paraphrases the closing
    //     clause of a sentence).
    const ANCHOR = 60;
    if (quoteNorm.length > ANCHOR + 10) {
      const head = quoteNorm.slice(0, ANCHOR);
      const jh = flatMap.norm.indexOf(head);
      if (jh !== -1) {
        const targetEnd = jh + quoteNorm.length;
        const origStart = flatMap.origOf[jh] ?? 0;
        const origEnd = flatMap.origOf[Math.min(targetEnd, flatMap.norm.length)]
                      ?? flat.length;
        if (origEnd > origStart) return [origStart, origEnd];
      }
      // (6) Tail anchor — last 60 normalized chars.
      const tail = quoteNorm.slice(-ANCHOR);
      const jt = flatMap.norm.lastIndexOf(tail);
      if (jt !== -1) {
        const targetStart = Math.max(0, jt + ANCHOR - quoteNorm.length);
        const origStart = flatMap.origOf[targetStart] ?? 0;
        const origEnd = flatMap.origOf[jt + ANCHOR] ?? flat.length;
        if (origEnd > origStart) return [origStart, origEnd];
      }
    }
  }

  return null;
}

// Build a normalized version of `s` plus a parallel table mapping each
// normalized character index to its original index in `s`. The tail
// entry origOf[normLen] = s.length so range bounds work cleanly.
//
// Normalizations applied (in order):
//   - Unicode NFC
//   - Common ligatures: ﬁ ﬂ ﬀ ﬃ ﬄ ﬅ ﬆ → expanded
//   - Soft hyphens dropped
//   - Line-end hyphenation rejoined ("-" followed by whitespace dropped)
//   - All dash variants → '-'
//   - All double-quote variants → '"'
//   - All single-quote variants → "'"
//   - Ellipsis '…' → '...'
//   - Whitespace runs collapsed to single space
//   - Case folded to lowercase
export function normalizeWithMap(s) {
  const src = s.normalize ? s.normalize("NFC") : s;
  const out = [];
  const origOf = [];
  const LIGS = { "ﬀ":"ff","ﬁ":"fi","ﬂ":"fl","ﬃ":"ffi","ﬄ":"ffl","ﬅ":"ft","ﬆ":"st" };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    // Soft hyphen → drop
    if (c === "­") { i++; continue; }
    // Line-end hyphenation: hyphen-like followed by whitespace, surrounded
    // by letters. Drop the dash AND the whitespace run.
    if ("-‐‑‒–—―−".indexOf(c) !== -1 && /\s/.test(src[i + 1] || "") && /[A-Za-z]/.test(src[i - 1] || "")) {
      i++;
      while (i < src.length && /\s/.test(src[i])) i++;
      continue;
    }
    // Ligatures
    if (LIGS[c]) {
      const exp = LIGS[c];
      for (const ch of exp) { out.push(ch); origOf.push(i); }
      i++;
      continue;
    }
    // Whitespace → single space (collapsed)
    if (/\s/.test(c)) {
      out.push(" ");
      origOf.push(i);
      while (i < src.length && /\s/.test(src[i])) i++;
      continue;
    }
    // Dashes
    if ("-‐‑‒–—―−".indexOf(c) !== -1) { out.push("-"); origOf.push(i); i++; continue; }
    // Double quotes
    if ('"“”„‟″'.indexOf(c) !== -1) { out.push('"'); origOf.push(i); i++; continue; }
    // Single quotes / apostrophes
    if ("'‘’‚‛′".indexOf(c) !== -1) { out.push("'"); origOf.push(i); i++; continue; }
    // Ellipsis
    if (c === "…") { out.push("..."); origOf.push(i); origOf.push(i); origOf.push(i); i++; continue; }
    // Default — lowercase
    out.push(c.toLowerCase());
    origOf.push(i);
    i++;
  }
  origOf.push(src.length);
  return { norm: out.join(""), origOf };
}

function buildFuzzyRegex(s) {
  // Escape regex meta, then rewrite specific characters into fuzzy
  // classes. Order matters: handle ellipsis before single dots.
  let out = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Restore the regex syntax for ellipsis (escaped dots back to a class).
  out = out.replace(/\\\.\\\.\\\./g, ELLIPSIS_CLASS);
  out = out.replace(/[…]/g, ELLIPSIS_CLASS);
  // Any dash → dash class.
  out = out.replace(/[-‐-―−]/g, DASH_CLASS);
  // Any double-quote → double-quote class.
  out = out.replace(/["“”„‟″]/g, DQUOTE_CLASS);
  // Any single-quote / apostrophe → single-quote class.
  out = out.replace(/['‘’‚‛′]/g, SQUOTE_CLASS);
  // Soft hyphen → optional (PDF text-layer sometimes has line-wrap soft hyphens).
  out = out.replace(/­/g, "\\u00AD?");
  // Collapse whitespace + allow extra punctuation around it (e.g., a
  // stray space before a comma "307 , 468"). Any whitespace run
  // matches any whitespace run, optionally with adjacent spaces around
  // punctuation flexed too.
  out = out.replace(/\s+/g, "\\s*\\s+\\s*");
  try { return new RegExp(out); } catch { return null; }
}

// Compute the §heading > subheading chain for `el` inside `article`.
function computeHeadingPath(article, fromEl) {
  if (!fromEl || !article) return null;
  const all = Array.from(article.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  let nearest = null;
  for (const h of all) {
    const pos = h.compareDocumentPosition(fromEl);
    const isBefore = pos & Node.DOCUMENT_POSITION_FOLLOWING;
    const contains = pos & Node.DOCUMENT_POSITION_CONTAINED_BY;
    if (isBefore || contains || h === fromEl || h.contains(fromEl)) nearest = h;
    else break;
  }
  if (!nearest) return null;
  const path = [nearest.textContent.trim()];
  let curLevel = parseInt(nearest.tagName[1], 10);
  let cursor = nearest;
  while (curLevel > 1) {
    const targetLevel = curLevel - 1;
    let prev = cursor;
    let found = null;
    while (prev) {
      prev = prev.previousElementSibling || prev.parentElement;
      if (!prev || prev === article) break;
      if (prev.tagName === `H${targetLevel}`) { found = prev; break; }
      const p = parseInt((prev.tagName || "").slice(1), 10);
      if (!Number.isNaN(p) && p < targetLevel) break;
    }
    if (!found) break;
    path.unshift(found.textContent.trim());
    cursor = found;
    curLevel = targetLevel;
  }
  return path.join(" > ");
}

// Resolve a verbatim quote into a flow-doc snippet record. Returns
// the canonical shape ready to drop into state.snippets, or null if
// the quote can't be located in the rendered article.
export function resolveFlowQuote(viewerContainer, quote) {
  const article = viewerContainer.querySelector(".flow-doc");
  if (!article) return null;
  const { nodes, flat } = buildTextIndex(article);
  const span = findInFlat(flat, quote);
  if (!span) return null;
  const [startOff, endOff] = span;
  const startLoc = locateOffset(nodes, startOff);
  if (!startLoc) return null;
  const startEl = startLoc.node.parentElement;
  const anchor = computeHeadingPath(article, startEl);
  const actualText = flat.slice(startOff, endOff);
  return {
    text: actualText,
    contextBefore: flat.slice(Math.max(0, startOff - CONTEXT_LEN), startOff),
    contextAfter: flat.slice(endOff, endOff + CONTEXT_LEN),
    anchor,
    flowPos: startOff,
    textNormalized: normalizeText(actualText),
    page: 1,
    rects: [],
    kind: "text",
  };
}

// Resolve a verbatim quote into a PDF snippet record. Searches every
// rendered .textLayer in priority order (hintPage first), builds a
// Range across the matching text-layer spans, and produces fractional
// rects in the page-wrap's coordinate space.
export function resolvePdfQuote(viewerContainer, quote, hintPage) {
  const wraps = Array.from(viewerContainer.querySelectorAll(".page-wrap"));
  if (!wraps.length) return null;
  // Build search order: hintPage's wrap first, then the rest.
  const ordered = [];
  if (hintPage) {
    const wp = wraps.find((w) => parseInt(w.dataset.page, 10) === hintPage);
    if (wp) ordered.push(wp);
  }
  for (const w of wraps) if (!ordered.includes(w)) ordered.push(w);

  for (const wrap of ordered) {
    const textLayer = wrap.querySelector(".textLayer");
    if (!textLayer) continue; // page not rendered yet
    const { nodes, flat } = buildTextIndex(textLayer);
    if (!flat) continue;
    const span = findInFlat(flat, quote);
    if (!span) continue;
    const startLoc = locateOffset(nodes, span[0]);
    const endLoc = locateOffset(nodes, span[1]);
    if (!startLoc || !endLoc) continue;

    const range = document.createRange();
    try {
      range.setStart(startLoc.node, startLoc.offset);
      range.setEnd(endLoc.node, endLoc.offset);
    } catch { continue; }

    const wrapRect = wrap.getBoundingClientRect();
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({
        left: (r.left - wrapRect.left) / wrapRect.width,
        top: (r.top - wrapRect.top) / wrapRect.height,
        width: r.width / wrapRect.width,
        height: r.height / wrapRect.height,
      }));

    if (rects.length === 0) continue;

    const actualText = flat.slice(span[0], span[1]);
    return {
      text: actualText,
      page: parseInt(wrap.dataset.page, 10),
      rects,
      contextBefore: flat.slice(Math.max(0, span[0] - CONTEXT_LEN), span[0]),
      contextAfter: flat.slice(span[1], span[1] + CONTEXT_LEN),
      textNormalized: normalizeText(actualText),
      kind: "text",
    };
  }
  return null;
}

// Resolve a quote against PDF.js text content (positioned items with
// transform matrices) — works for pages that haven't been rendered in
// the viewer yet. Same return shape as resolvePdfQuote so callers
// don't branch. `pageContents` is a Map<pageN, {flat, ranges, width, height}>.
export function resolvePdfQuoteFromContent(pageContents, quote, hintPage) {
  if (!pageContents || !quote) return null;
  // Iterate pages with hint first, then the rest.
  const order = [];
  if (hintPage && pageContents.has(hintPage)) order.push(hintPage);
  for (const p of pageContents.keys()) if (p !== hintPage) order.push(p);

  for (const pageNum of order) {
    const pc = pageContents.get(pageNum);
    if (!pc) continue;
    const span = findInFlat(pc.flat, quote);
    if (!span) continue;
    const [startOff, endOff] = span;
    const inRange = pc.ranges.filter((r) => r.start < endOff && r.end > startOff);
    if (!inRange.length) continue;
    const rects = computeLineRects(inRange, pc.width, pc.height);
    if (!rects.length) continue;
    const actualText = pc.flat.slice(startOff, endOff);
    return {
      text: actualText,
      page: pageNum,
      rects,
      contextBefore: pc.flat.slice(Math.max(0, startOff - 40), startOff),
      contextAfter: pc.flat.slice(endOff, endOff + 40),
      textNormalized: normalizeText(actualText),
      kind: "text",
    };
  }
  return null;
}

// Bucket PDF text-content items by their y-baseline (rounded to 3 PDF
// units) — same bucket = same visual line. Emit one fractional rect
// per bucket. PDF's transform[5] is the BASELINE; glyphs extend ~80%
// above (ascender + cap height) and ~20% below (descender), so we use
// those factors to position the rect on the visible glyph extent
// rather than at the baseline.
//
// Exported separately so the headless CLI (scripts/ai-batch.mjs) can
// reuse the same math without duplicating the constants.
export function computeLineRects(inRange, pageWidth, pageHeight) {
  const ASCENT = 0.8;
  const DESCENT = 0.2;
  const lines = new Map();
  for (const r of inRange) {
    const tx = r.item.transform;
    const yBase = Math.round(tx[5] / 3) * 3;
    const x = tx[4];
    const h = r.item.height || Math.abs(tx[3]) || 12;
    const w = r.item.width || 0;
    const itemTop = tx[5] + ASCENT * h;      // top of glyph box (PDF coords)
    const itemBottom = tx[5] - DESCENT * h;  // bottom of glyph box
    let line = lines.get(yBase);
    if (!line) {
      line = { left: Infinity, right: -Infinity, top: -Infinity, bottom: Infinity };
      lines.set(yBase, line);
    }
    if (x < line.left) line.left = x;
    if (x + w > line.right) line.right = x + w;
    if (itemTop > line.top) line.top = itemTop;
    if (itemBottom < line.bottom) line.bottom = itemBottom;
  }
  const rects = [];
  for (const line of lines.values()) {
    const left = line.left / pageWidth;
    const top = 1 - line.top / pageHeight;
    const width = (line.right - line.left) / pageWidth;
    const height = (line.top - line.bottom) / pageHeight;
    if (width <= 0 || height <= 0) continue;
    rects.push({ left, top, width, height });
  }
  return rects;
}

// Top-level resolver — picks the right resolver based on source kind.
// Returns a snippet record or null. `id`, `created`, `groups`, and
// `comment` are filled in by the caller (acceptAiSuggestion).
export function resolveQuoteToSnippet({ quote, kind, viewerContainer, hintPage, pageTextContent }) {
  if (!quote) return null;
  if (kind === "pdf") {
    // Prefer DOM resolver when the page is already rendered (pixel-
    // accurate rects via getClientRects). Fall back to PDF.js content
    // resolution for non-visible pages.
    return resolvePdfQuote(viewerContainer, quote, hintPage)
        || (pageTextContent ? resolvePdfQuoteFromContent(pageTextContent, quote, hintPage) : null);
  }
  return resolveFlowQuote(viewerContainer, quote);
}
