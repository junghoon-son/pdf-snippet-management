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
        color: groupColor(id),
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
    bubbles.forEach((b) => {
      const a = Math.random() * Math.PI * 2;
      const rad = Math.min(w, h) * 0.12;
      b.x = w / 2 + Math.cos(a) * rad;
      b.y = h / 2 + Math.sin(a) * rad;
    });

    // SVG layer for bubbles
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.classList.add("bubble-svg");
    overlay.appendChild(svg);

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
      } else {
        shape = document.createElementNS(SVG_NS, "rect");
        shape.setAttribute("x", String(-b.w / 2));
        shape.setAttribute("y", String(-b.h / 2));
        shape.setAttribute("width", String(b.w));
        shape.setAttribute("height", String(b.h));
        shape.setAttribute("rx", String(b.h / 2));
        shape.setAttribute("ry", String(b.h / 2));
        shape.setAttribute("fill", b.color);
        shape.setAttribute("stroke", b.color);
      }
      g.appendChild(shape);

      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("text-anchor", "middle");
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
    const SNAP_PULL = 0.55;
    const SNAP_EASE = 0.28;
    const placeCard = () => {
      if (pendingFrame) return;
      pendingFrame = true;
      requestAnimationFrame(() => {
        pendingFrame = false;
        if (!cardW) { cardW = card.offsetWidth; cardH = card.offsetHeight; }
        let targetX = cursor.x;
        let targetY = cursor.y;
        if (hoveredId) {
          const hot = bubbleEls.find(({ bubble: b }) => b.id === hoveredId);
          if (hot) {
            targetX = cursor.x + (hot.bubble.x - cursor.x) * SNAP_PULL;
            targetY = cursor.y + (hot.bubble.y - cursor.y) * SNAP_PULL;
          }
        }
        renderedX += (targetX - renderedX) * SNAP_EASE;
        renderedY += (targetY - renderedY) * SNAP_EASE;
        if (Math.abs(targetX - renderedX) < 0.5) renderedX = targetX;
        if (Math.abs(targetY - renderedY) < 0.5) renderedY = targetY;
        const x = renderedX - cardW / 2;
        const y = renderedY - cardH / 2;
        card.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        if (renderedX !== targetX || renderedY !== targetY) {
          pendingFrame = false;
          placeCard();
        }
      });
    };
    requestAnimationFrame(() => { cardW = card.offsetWidth; cardH = card.offsetHeight; placeCard(); });

    // Force simulation
    const sim = forceSimulation(bubbles)
      .alphaDecay(0.05)
      .velocityDecay(0.55)
      .force("charge", forceManyBody().strength(-160).distanceMax(220))
      .force("xCenter", forceX(w / 2).strength(0.08))
      .force("yCenter", forceY(h / 2).strength(0.08))
      .force("collide", forceCollide().radius((d) => d.r + HIT_PADDING).iterations(2))
      .force("xPull", forceX().x((d) => cursor.x).strength((d) => cursorPullStrength(d, cursor)))
      .force("yPull", forceY().y((d) => cursor.y).strength((d) => cursorPullStrength(d, cursor)));

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
        for (const { bubble, el } of bubbleEls) {
          el.classList.toggle("hot", bubble.id === bestId);
        }
        card.classList.toggle("over-target", bestId !== null);
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
