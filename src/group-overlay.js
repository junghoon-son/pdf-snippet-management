import {
  forceSimulation,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
} from "d3-force";

const SVG_NS = "http://www.w3.org/2000/svg";
const PILL_HEIGHT = 38;
const PILL_PAD_X = 18;
const PILL_MIN_W = 70;
const PILL_MAX_W = 200;
const CHAR_W = 7;
const NEW_RADIUS = 30;
const HIT_PADDING = 6;
const CURSOR_PULL_RADIUS = 220;

function pillWidth(label) {
  const len = (label || "").length;
  return Math.max(PILL_MIN_W, Math.min(PILL_MAX_W, PILL_PAD_X * 2 + len * CHAR_W));
}

// Push any input color into a "neon Post-it" zone for the drag overlay
// — saturation maxed, lightness locked to a punchy mid-tone. Hue is
// preserved so each group is still recognizable. Doesn't try to match
// the source palette swatch; the brief is "pop, not fidelity".
function popColor(input) {
  if (!input) return "hsl(280, 85%, 58%)";
  let h, s, l;
  const hsl = /hsla?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)%[\s,]+(\d+(?:\.\d+)?)%/.exec(input);
  if (hsl) {
    h = +hsl[1]; s = +hsl[2]; l = +hsl[3];
  } else {
    const hex = String(input).trim().replace("#", "");
    if (hex.length !== 3 && hex.length !== 6 && hex.length !== 8) return input;
    const c = hex.length === 3 ? hex.split("").map((x) => x + x).join("") : hex.slice(0, 6);
    const r = parseInt(c.slice(0, 2), 16) / 255;
    const g = parseInt(c.slice(2, 4), 16) / 255;
    const b = parseInt(c.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    l = (max + min) / 2;
    if (max === min) { h = 0; s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    s *= 100;
    l *= 100;
  }
  // Vivid Post-it band: saturation maxed, lightness in the 52–60 punch zone.
  s = Math.max(90, s);
  l = Math.max(52, Math.min(60, l));
  return `hsl(${h.toFixed(0)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%)`;
}

export function openGroupOverlay({ snippet, allSnippets, allGroups, container, anchor, groupColor, groupName, paneRect, dragMode = false }) {
  return new Promise((resolve) => {
    const overlay = container;
    overlay.innerHTML = "";
    overlay.classList.remove("active", "closing");
    overlay.hidden = false;
    void overlay.offsetWidth;
    requestAnimationFrame(() => overlay.classList.add("active"));

    // Build group inventory: union of groupsMeta and group ids referenced by snippets.
    const counts = new Map();
    for (const s of allSnippets) {
      for (const g of s.groups || []) counts.set(g, (counts.get(g) || 0) + 1);
    }
    const hiddenIds = new Set((allGroups || []).filter((m) => m.hidden).map((m) => m.id));
    const knownIds = new Set();
    for (const m of allGroups || []) {
      if (!m.hidden) knownIds.add(m.id);
    }
    for (const id of counts.keys()) {
      if (!hiddenIds.has(id)) knownIds.add(id);
    }
    const memberOf = new Set(snippet.groups || []);
    const NEW_ID = "__new__";

    const bubbles = [...knownIds].map((id) => {
      const count = counts.get(id) || 0;
      const name = (groupName ? groupName(id) : "") || "";
      const label = count > 0 ? `${name} · ${count}` : name;
      const w = pillWidth(label);
      const h = PILL_HEIGHT;
      return {
        id,
        kind: "group",
        count,
        name,
        label,
        w,
        h,
        r: Math.max(w, h) / 2,
        color: popColor(groupColor(id)),
        isMember: memberOf.has(id),
      };
    });
    bubbles.push({
      id: NEW_ID,
      kind: "new",
      count: 0,
      name: "",
      label: "+",
      w: NEW_RADIUS * 2,
      h: NEW_RADIUS * 2,
      r: NEW_RADIUS,
      color: "#4ec9b0",
      isMember: false,
    });

    const w = paneRect.width;
    const h = paneRect.height;
    // Spawn bubbles in a small ring around the drag origin so the user
    // doesn't have to chase the menu. Bias the angle slightly toward the
    // pane interior when the cursor sits near an edge so the ring is
    // less likely to spawn off-screen.
    const originX = clamp(anchor.x - paneRect.left, 0, w);
    const originY = clamp(anchor.y - paneRect.top, 0, h);
    const towardCenter = Math.atan2(h / 2 - originY, w / 2 - originX);
    const ringR = Math.min(w, h) * 0.16;
    bubbles.forEach((b, i) => {
      // Spread bubbles around a partial arc biased toward the pane interior
      const t = (i / Math.max(1, bubbles.length - 1)) - 0.5;
      const a = towardCenter + t * Math.PI * 1.2;
      b.x = originX + Math.cos(a) * ringR;
      b.y = originY + Math.sin(a) * ringR;
    });

    // SVG layer for bubbles
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.classList.add("bubble-svg");
    overlay.appendChild(svg);

    // Linking line (card → hovered bubble)
    const linkGroup = document.createElementNS(SVG_NS, "g");
    linkGroup.classList.add("link-group");
    const linkGlow = document.createElementNS(SVG_NS, "path");
    linkGlow.classList.add("link-path", "link-glow");
    const linkCore = document.createElementNS(SVG_NS, "path");
    linkCore.classList.add("link-path", "link-core");
    linkGroup.append(linkGlow, linkCore);
    svg.appendChild(linkGroup);

    const bubbleEls = bubbles.map((b) => {
      const g = document.createElementNS(SVG_NS, "g");
      g.classList.add("bubble");
      if (b.kind === "new") g.classList.add("bubble-new");
      if (b.isMember) g.classList.add("bubble-member");
      g.dataset.id = b.id;

      let shape;
      if (b.kind === "new") {
        shape = document.createElementNS(SVG_NS, "circle");
        shape.setAttribute("r", String(NEW_RADIUS));
        shape.setAttribute("fill", "transparent");
        shape.setAttribute("stroke", b.color);
        shape.setAttribute("stroke-width", "1.5");
        shape.setAttribute("stroke-dasharray", "4 4");
        g.appendChild(shape);
      } else {
        // Folder shape: a small tab perched on top-left of a rounded body.
        // Reads as a manila folder you'd drop a snippet into. Body filled
        // with a translucent tint of the group color so the underlying
        // backdrop blur shows through; stroke + tab use the saturated color.
        const TAB_H = 8;
        const TAB_W = Math.max(28, Math.min(b.w * 0.42, 70));
        const TAB_X = -b.w / 2 + 6;
        const TAB_Y = -b.h / 2;
        const BODY_X = -b.w / 2;
        const BODY_Y = -b.h / 2 + TAB_H - 1;
        const BODY_W = b.w;
        const BODY_H = b.h - TAB_H + 1;

        shape = document.createElementNS(SVG_NS, "g");
        shape.classList.add("folder-shape");

        // Tab on top
        const tab = document.createElementNS(SVG_NS, "rect");
        tab.setAttribute("x", String(TAB_X));
        tab.setAttribute("y", String(TAB_Y));
        tab.setAttribute("width", String(TAB_W));
        tab.setAttribute("height", String(TAB_H + 3));
        tab.setAttribute("rx", "2.5");
        tab.setAttribute("ry", "2.5");
        tab.setAttribute("fill", b.color);
        tab.setAttribute("stroke", b.color);
        tab.setAttribute("stroke-width", "1");
        shape.appendChild(tab);

        // Folder body
        const body = document.createElementNS(SVG_NS, "rect");
        body.setAttribute("x", String(BODY_X));
        body.setAttribute("y", String(BODY_Y));
        body.setAttribute("width", String(BODY_W));
        body.setAttribute("height", String(BODY_H));
        body.setAttribute("rx", "3");
        body.setAttribute("ry", "3");
        body.setAttribute("fill", b.color);
        body.setAttribute("fill-opacity", "0.18");
        body.setAttribute("stroke", b.color);
        body.setAttribute("stroke-width", "1.5");
        shape.appendChild(body);

        g.appendChild(shape);
      }

      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("text-anchor", "middle");
      // Shift label slightly down so it centers inside the body, not the tab.
      text.setAttribute("y", b.kind === "new" ? "0" : "5");
      text.setAttribute("dominant-baseline", "central");
      text.textContent = b.label;
      g.appendChild(text);

      svg.appendChild(g);
      return { bubble: b, el: g, shape, text };
    });

    // Lifted card
    const card = document.createElement("div");
    card.classList.add("lifted-card");
    const preview = (snippet.text || "").slice(0, 80) + ((snippet.text || "").length > 80 ? "…" : "");
    card.innerHTML = `
      <div class="lifted-meta">p.${snippet.page}</div>
      <div class="lifted-text">${escapeHtml(preview)}</div>
      <span class="lifted-dot tl"></span><span class="lifted-dot tr"></span>
      <span class="lifted-dot bl"></span><span class="lifted-dot br"></span>
    `;
    overlay.appendChild(card);

    const hint = document.createElement("div");
    hint.className = "overlay-hint";
    hint.textContent = "drop on a bubble · esc to cancel";
    overlay.appendChild(hint);

    // Position card initially under the cursor anchor (relative to overlay)
    let cursor = { x: anchor.x - paneRect.left, y: anchor.y - paneRect.top };
    let cardW = 0, cardH = 0;
    let pendingFrame = false;
    let renderedX = cursor.x, renderedY = cursor.y;
    const SNAP_EASE = 0.32;
    const updateLinkPath = () => {
      if (hoveredId) {
        const hot = bubbleEls.find(({ bubble: b }) => b.id === hoveredId);
        if (hot) {
          const x1 = renderedX, y1 = renderedY;
          const x2 = hot.bubble.x, y2 = hot.bubble.y;
          const dx = x2 - x1, dy = y2 - y1;
          const cx = (x1 + x2) / 2 - dy * 0.2;
          const cy = (y1 + y2) / 2 + dx * 0.2;
          const d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
          linkGlow.setAttribute("d", d);
          linkCore.setAttribute("d", d);
          linkGroup.classList.add("connected");
          return;
        }
      }
      linkGroup.classList.remove("connected");
    };

    const placeCard = () => {
      if (pendingFrame) return;
      pendingFrame = true;
      requestAnimationFrame(() => {
        pendingFrame = false;
        if (!cardW) { cardW = card.offsetWidth; cardH = card.offsetHeight; }
        const targetX = cursor.x;
        const targetY = cursor.y;
        renderedX += (targetX - renderedX) * SNAP_EASE;
        renderedY += (targetY - renderedY) * SNAP_EASE;
        if (Math.abs(targetX - renderedX) < 0.5) renderedX = targetX;
        if (Math.abs(targetY - renderedY) < 0.5) renderedY = targetY;
        const x = renderedX - cardW / 2;
        const y = renderedY - cardH / 2;
        card.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        updateLinkPath();
        if (renderedX !== targetX || renderedY !== targetY) {
          pendingFrame = false;
          placeCard();
        }
      });
    };
    requestAnimationFrame(() => { cardW = card.offsetWidth; cardH = card.offsetHeight; placeCard(); });

    // Force simulation — bubbles cluster around the cursor (drag origin),
    // not the pane center, so the menu sits where the user already is.
    // Edge-repel keeps any bubble from being pushed past the pane border.
    const EDGE_MARGIN = 60;
    const edgeRepel = () => {
      for (const b of bubbles) {
        const padX = b.w / 2 + 4;
        const padY = b.h / 2 + 4;
        if (b.x < EDGE_MARGIN + padX) b.vx += (EDGE_MARGIN + padX - b.x) * 0.06;
        if (b.x > w - EDGE_MARGIN - padX) b.vx -= (b.x - (w - EDGE_MARGIN - padX)) * 0.06;
        if (b.y < EDGE_MARGIN + padY) b.vy += (EDGE_MARGIN + padY - b.y) * 0.06;
        if (b.y > h - EDGE_MARGIN - padY) b.vy -= (b.y - (h - EDGE_MARGIN - padY)) * 0.06;
      }
    };
    const sim = forceSimulation(bubbles)
      .alphaDecay(0.05)
      .velocityDecay(0.55)
      .force("charge", forceManyBody().strength(-160).distanceMax(220))
      .force("xCenter", forceX().x(() => cursor.x).strength(0.10))
      .force("yCenter", forceY().y(() => cursor.y).strength(0.10))
      .force("collide", forceCollide().radius((d) => d.r + HIT_PADDING).iterations(2))
      .force("xPull", forceX().x((d) => cursor.x).strength((d) => cursorPullStrength(d, cursor)))
      .force("yPull", forceY().y((d) => cursor.y).strength((d) => cursorPullStrength(d, cursor)))
      .force("edges", edgeRepel);

    sim.on("tick", () => {
      for (const { bubble, el } of bubbleEls) {
        bubble.x = clamp(bubble.x, bubble.w / 2, w - bubble.w / 2);
        bubble.y = clamp(bubble.y, bubble.h / 2, h - bubble.h / 2);
        el.setAttribute("transform", `translate(${bubble.x},${bubble.y})`);
      }
      updateHover();
    });

    let hoveredId = null;
    const updateHover = () => {
      let bestId = null;
      for (const { bubble } of bubbleEls) {
        const dx = cursor.x - bubble.x;
        const dy = cursor.y - bubble.y;
        let inside;
        if (bubble.kind === "new") {
          inside = dx * dx + dy * dy < bubble.r * bubble.r;
        } else {
          inside = Math.abs(dx) <= bubble.w / 2 && Math.abs(dy) <= bubble.h / 2;
        }
        if (inside) { bestId = bubble.id; break; }
      }
      if (bestId !== hoveredId) {
        hoveredId = bestId;
        const hotBubble = bestId
          ? bubbleEls.find(({ bubble: b }) => b.id === bestId)?.bubble
          : null;
        for (const { bubble, el } of bubbleEls) {
          el.classList.toggle("hot", bubble.id === bestId);
        }
        card.classList.toggle("over-target", bestId !== null);
        const overlayEl = card.parentElement;
        if (hotBubble) {
          overlayEl?.style.setProperty("--target-color", hotBubble.color || "#2ea58c");
          card.style.setProperty("--target-color", hotBubble.color || "#2ea58c");
        } else {
          overlayEl?.style.removeProperty("--target-color");
          card.style.removeProperty("--target-color");
        }
        placeCard();
      }
    };

    const updateCursor = (clientX, clientY) => {
      cursor.x = clientX - paneRect.left;
      cursor.y = clientY - paneRect.top;
      placeCard();
      if (sim.alpha() < 0.05) sim.alpha(0.15).restart();
    };

    const finalize = (droppedOn) => {
      cleanup();
      if (!droppedOn) return resolve(null);
      const bubble = bubbleEls.find(({ bubble: b }) => b.id === droppedOn)?.bubble;
      if (!bubble) return resolve(null);
      if (bubble.kind === "new") return resolve({ kind: "new" });
      if (bubble.isMember) return resolve(null);
      return resolve({ kind: "existing", groupId: bubble.id });
    };

    const onMove = (e) => updateCursor(e.clientX, e.clientY);
    const onUp = () => finalize(hoveredId);
    const onDragOver = (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "link";
      updateCursor(e.clientX, e.clientY);
    };
    const onDrop = (e) => {
      e.preventDefault();
      finalize(hoveredId);
    };
    const onDragEnd = () => finalize(null);
    const onKey = (e) => {
      if (e.key === "Escape") {
        cleanup();
        resolve(null);
      }
    };
    const onContextMenu = (e) => e.preventDefault();

    function cleanup() {
      sim.stop();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      overlay.removeEventListener("dragover", onDragOver);
      overlay.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", onDragEnd, true);
      window.removeEventListener("keydown", onKey, true);
      overlay.removeEventListener("contextmenu", onContextMenu);
      overlay.classList.remove("active");
      overlay.classList.add("closing");
      setTimeout(() => {
        overlay.hidden = true;
        overlay.classList.remove("closing");
        overlay.innerHTML = "";
      }, 160);
    }

    if (dragMode) {
      overlay.addEventListener("dragover", onDragOver);
      overlay.addEventListener("drop", onDrop);
      window.addEventListener("dragend", onDragEnd, true);
    } else {
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    }
    window.addEventListener("keydown", onKey, true);
    overlay.addEventListener("contextmenu", onContextMenu);
  });
}

function cursorPullStrength(d, cursor) {
  const dx = cursor.x - d.x;
  const dy = cursor.y - d.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > CURSOR_PULL_RADIUS) return 0;
  return 0.02 * (1 - dist / CURSOR_PULL_RADIUS);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
