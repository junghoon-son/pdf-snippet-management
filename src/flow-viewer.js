import { marked } from "marked";

const CONTEXT_LEN = 40;

marked.setOptions({
  breaks: false,
  gfm: true,
});

export async function renderFlowDoc(container, sourceText, kind) {
  container.innerHTML = "";
  container.dataset.flow = "1";
  container.dataset.kind = kind;
  let html;
  if (kind === "markdown") {
    html = marked.parse(sourceText || "");
  } else {
    html = `<pre>${escapeHtml(sourceText || "")}</pre>`;
  }
  const article = document.createElement("article");
  article.className = "flow-doc";
  article.innerHTML = html;
  container.appendChild(article);
  return article;
}

export function clearFlowDoc(container) {
  container.innerHTML = "";
  delete container.dataset.flow;
  delete container.dataset.kind;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function normalizeText(s) {
  return String(s || "")
    .replace(/[­]/g, "")
    .replace(/[ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getFlowArticle(container) {
  return container.querySelector(".flow-doc");
}

export function getSelectionFlowSnippet(container) {
  const article = getFlowArticle(container);
  if (!article) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!article.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString();
  if (!text.trim()) return null;

  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(article);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const flatBefore = beforeRange.toString();

  const afterRange = document.createRange();
  afterRange.selectNodeContents(article);
  afterRange.setStart(range.endContainer, range.endOffset);
  const flatAfter = afterRange.toString();

  const startEl = range.startContainer.nodeType === 3
    ? range.startContainer.parentElement
    : range.startContainer;
  const anchor = computeHeadingPath(article, startEl);

  return {
    text,
    contextBefore: flatBefore.slice(-CONTEXT_LEN),
    contextAfter: flatAfter.slice(0, CONTEXT_LEN),
    anchor,
    flowPos: flatBefore.length,
    textNormalized: normalizeText(text),
  };
}

function computeHeadingPath(article, fromEl) {
  if (!fromEl) return null;
  const all = Array.from(article.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  let nearest = null;
  for (const h of all) {
    const pos = h.compareDocumentPosition(fromEl);
    const isBefore = pos & Node.DOCUMENT_POSITION_FOLLOWING;
    const containsTarget = pos & Node.DOCUMENT_POSITION_CONTAINED_BY;
    if (isBefore || containsTarget || h === fromEl || h.contains(fromEl)) {
      nearest = h;
    } else {
      break;
    }
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
      prev = previousAnyElement(prev);
      if (!prev) break;
      if (prev.tagName === `H${targetLevel}`) {
        found = prev;
        break;
      }
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

function previousAnyElement(el) {
  if (el.previousElementSibling) return el.previousElementSibling;
  let cur = el.parentElement;
  while (cur) {
    if (cur.previousElementSibling) return cur.previousElementSibling;
    cur = cur.parentElement;
  }
  return null;
}

export function applyFlowHighlights(container, snippets) {
  const article = getFlowArticle(container);
  if (!article) return;
  unwrapHighlights(article);
  const flatText = article.textContent || "";
  const flatNormalized = normalizeText(flatText);

  const targets = [];
  for (const s of snippets || []) {
    if (s.kind === "image") continue;
    const located = locateSnippet(flatText, flatNormalized, s);
    if (located) {
      targets.push({ snippet: s, ...located });
    }
  }
  targets.sort((a, b) => b.start - a.start);
  for (const t of targets) {
    const range = rangeAtFlatOffset(article, t.start, t.end);
    if (!range) continue;
    try {
      wrapRangeAsMark(range, t.snippet.id);
    } catch (err) {
      console.warn("highlight wrap failed for snippet", t.snippet.id, err);
    }
  }
}

function locateSnippet(flatText, flatNormalized, s) {
  const text = s.text || "";
  if (!text) return null;
  let idx = -1;
  if (s.contextBefore || s.contextAfter) {
    const probe = (s.contextBefore || "") + text + (s.contextAfter || "");
    const p = flatText.indexOf(probe);
    if (p >= 0) {
      idx = p + (s.contextBefore || "").length;
      return { start: idx, end: idx + text.length };
    }
  }
  let from = 0;
  const occurrences = [];
  while (true) {
    const found = flatText.indexOf(text, from);
    if (found < 0) break;
    occurrences.push(found);
    from = found + Math.max(1, text.length);
  }
  if (occurrences.length === 1) {
    return { start: occurrences[0], end: occurrences[0] + text.length };
  }
  if (occurrences.length > 1 && (s.contextBefore || s.contextAfter)) {
    let best = -1;
    let bestScore = -1;
    for (const o of occurrences) {
      const cb = flatText.slice(Math.max(0, o - CONTEXT_LEN), o);
      const ca = flatText.slice(o + text.length, o + text.length + CONTEXT_LEN);
      const score = simpleSimilarity(cb, s.contextBefore || "") +
                    simpleSimilarity(ca, s.contextAfter || "");
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    if (best >= 0) {
      return { start: best, end: best + text.length };
    }
  }
  if (s.textNormalized) {
    const found = flatNormalized.indexOf(s.textNormalized);
    if (found >= 0) {
      const mappedStart = mapNormalizedToFlat(flatText, found);
      const mappedEnd = mapNormalizedToFlat(flatText, found + s.textNormalized.length);
      if (mappedStart != null && mappedEnd != null) {
        return { start: mappedStart, end: mappedEnd };
      }
    }
  }
  return null;
}

function simpleSimilarity(a, b) {
  if (!a || !b) return 0;
  const minLen = Math.min(a.length, b.length);
  if (minLen === 0) return 0;
  let common = 0;
  for (let i = 0; i < minLen; i++) {
    const ai = a[a.length - 1 - i];
    const bi = b[b.length - 1 - i];
    if (ai === bi) common += 1;
    else break;
  }
  return common / Math.max(a.length, b.length);
}

function mapNormalizedToFlat(flatText, normalizedOffset) {
  let normalizedSeen = 0;
  let lastWasSpace = true;
  for (let i = 0; i < flatText.length; i++) {
    const ch = flatText[i];
    const isSpace = /\s/.test(ch);
    if (isSpace) {
      if (!lastWasSpace) {
        if (normalizedSeen === normalizedOffset) return i;
        normalizedSeen += 1;
      }
      lastWasSpace = true;
    } else {
      if (normalizedSeen === normalizedOffset) return i;
      normalizedSeen += 1;
      lastWasSpace = false;
    }
  }
  return flatText.length;
}

function rangeAtFlatOffset(article, start, end) {
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, null);
  let acc = 0;
  let startNode = null, startOffset = 0;
  let endNode = null, endOffset = 0;
  let node = walker.nextNode();
  while (node) {
    const len = node.nodeValue.length;
    if (startNode == null && acc + len >= start) {
      startNode = node;
      startOffset = start - acc;
    }
    if (endNode == null && acc + len >= end) {
      endNode = node;
      endOffset = end - acc;
      break;
    }
    acc += len;
    node = walker.nextNode();
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  try {
    range.setStart(startNode, Math.max(0, Math.min(startOffset, startNode.nodeValue.length)));
    range.setEnd(endNode, Math.max(0, Math.min(endOffset, endNode.nodeValue.length)));
  } catch {
    return null;
  }
  return range;
}

function wrapRangeAsMark(range, snippetId) {
  if (range.startContainer === range.endContainer && range.startContainer.nodeType === 3) {
    const tn = range.startContainer;
    const before = tn.nodeValue.slice(0, range.startOffset);
    const middle = tn.nodeValue.slice(range.startOffset, range.endOffset);
    const after = tn.nodeValue.slice(range.endOffset);
    const mark = document.createElement("mark");
    mark.className = "hl";
    mark.dataset.snippetId = snippetId;
    mark.textContent = middle;
    const parent = tn.parentNode;
    if (before) parent.insertBefore(document.createTextNode(before), tn);
    parent.insertBefore(mark, tn);
    if (after) parent.insertBefore(document.createTextNode(after), tn);
    parent.removeChild(tn);
    return;
  }
  const textNodes = [];
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const r = document.createRange();
      r.selectNodeContents(n);
      if (range.compareBoundaryPoints(Range.END_TO_START, r) <= 0 &&
          range.compareBoundaryPoints(Range.START_TO_END, r) >= 0) {
        return NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_REJECT;
    },
  });
  let n = walker.nextNode();
  while (n) {
    textNodes.push(n);
    n = walker.nextNode();
  }
  for (const tn of textNodes) {
    let s = 0, e = tn.nodeValue.length;
    if (tn === range.startContainer) s = range.startOffset;
    if (tn === range.endContainer) e = range.endOffset;
    if (s >= e) continue;
    const before = tn.nodeValue.slice(0, s);
    const middle = tn.nodeValue.slice(s, e);
    const after = tn.nodeValue.slice(e);
    const mark = document.createElement("mark");
    mark.className = "hl";
    mark.dataset.snippetId = snippetId;
    mark.textContent = middle;
    const parent = tn.parentNode;
    if (before) parent.insertBefore(document.createTextNode(before), tn);
    parent.insertBefore(mark, tn);
    if (after) parent.insertBefore(document.createTextNode(after), tn);
    parent.removeChild(tn);
  }
}

function unwrapHighlights(article) {
  const marks = article.querySelectorAll("mark.hl");
  for (const m of marks) {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  }
}

export function previewFlowSnippet(container, snippet) {
  const article = getFlowArticle(container);
  if (!article) return;
  const m = article.querySelector(`mark.hl[data-snippet-id="${cssEscape(snippet.id)}"]`);
  if (!m) return;
  m.scrollIntoView({ behavior: "smooth", block: "center" });
  m.classList.remove("pulse");
  void m.offsetWidth;
  m.classList.add("pulse");
}

function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
