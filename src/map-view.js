import cytoscape from "cytoscape";
import edgehandles from "cytoscape-edgehandles";
import fcose from "cytoscape-fcose";

cytoscape.use(edgehandles);
cytoscape.use(fcose);

const NODE_W = 220;
const NODE_H_PER_LINE = 18;
const NODE_PAD = 14;

let cy = null;
let eh = null;
let onChange = null;
let onSelectEdge = null;
let getGroupName = null;

export function initMap(container, callbacks) {
  onChange = callbacks.onChange;
  onSelectEdge = callbacks.onSelectEdge;
  getGroupName = callbacks.groupName || ((id) => `Group ${id.slice(0, 4)}`);

  cy = cytoscape({
    container,
    minZoom: 0.2,
    maxZoom: 2.5,
    wheelSensitivity: 0.2,
    style: [
      {
        selector: "node",
        style: {
          "background-color": "#ffffff",
          "border-width": 1,
          "border-color": "#d4d2c8",
          "shape": "round-rectangle",
          "label": "data(displayText)",
          "color": "#1f1f1f",
          "font-family": "ui-serif, 'Iowan Old Style', Charter, Georgia, serif",
          "font-size": "11px",
          "text-wrap": "wrap",
          "text-max-width": NODE_W - 2 * NODE_PAD,
          "text-valign": "center",
          "text-halign": "center",
          "padding": NODE_PAD,
          "width": NODE_W,
          "height": "label",
          "min-zoomed-font-size": 6,
        },
      },
      {
        selector: "node[group]",
        style: {
          "border-color": "data(groupColor)",
          "border-width": 3,
        },
      },
      {
        selector: "node[?isImage]",
        style: {
          "background-image": "data(imageUrl)",
          "background-fit": "cover",
          "background-image-opacity": 1,
          "background-color": "#ffffff",
          "shape": "round-rectangle",
          "width": 110,
          "height": 78,
          "label": "data(displayText)",
          "text-valign": "bottom",
          "text-margin-y": 8,
          "font-size": "9px",
          "color": "#666",
          "border-width": 1,
          "border-color": "#d4d2c8",
        },
      },
      {
        selector: "node[?isGroup]",
        style: {
          "background-color": "data(lightColor)",
          "background-opacity": 1,
          "border-color": "data(color)",
          "border-width": 2,
          "shape": "round-rectangle",
          "label": "data(displayText)",
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": -8,
          "color": "data(color)",
          "font-family": "ui-serif, 'Iowan Old Style', Charter, Georgia, serif",
          "font-size": "14px",
          "font-weight": 600,
          "font-style": "italic",
          "padding": "40px",
          "z-index": 0,
        },
      },
      {
        selector: "node:selected",
        style: { "border-color": "#4ec9b0", "border-width": 2 },
      },
      {
        selector: "edge",
        style: {
          "width": 1.5,
          "line-color": "#a8a6a0",
          "target-arrow-color": "#a8a6a0",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "label": "data(label)",
          "font-size": "10px",
          "color": "#555",
          "text-background-color": "#f6f4ee",
          "text-background-opacity": 1,
          "text-background-padding": 3,
          "font-family": "ui-serif, 'Iowan Old Style', Charter, Georgia, serif",
          "font-style": "italic",
        },
      },
      {
        selector: "edge:selected",
        style: { "line-color": "#4ec9b0", "target-arrow-color": "#4ec9b0" },
      },
      {
        selector: "edge[?isMembership]",
        style: {
          "line-style": "dashed",
          "line-dash-pattern": [6, 4],
          "line-color": "data(color)",
          "opacity": 0.5,
          "target-arrow-shape": "none",
          "source-arrow-shape": "none",
          "width": 1.2,
          "label": "",
          "z-index": -1,
          "events": "no",
        },
      },
      {
        selector: ".eh-handle",
        style: {
          "background-color": "#4ec9b0",
          "width": 10,
          "height": 10,
          "shape": "ellipse",
          "overlay-opacity": 0,
          "border-width": 0,
          "label": "",
        },
      },
      {
        selector: ".eh-ghost-edge, .eh-preview",
        style: {
          "background-color": "#4ec9b0",
          "line-color": "#4ec9b0",
          "target-arrow-color": "#4ec9b0",
          "source-arrow-color": "#4ec9b0",
          "label": "",
        },
      },
    ],
  });

  eh = cy.edgehandles({
    snap: true,
    canConnect: (src, tgt) => !src.same(tgt),
    edgeParams: () => ({ data: { label: "" } }),
  });

  cy.on("ehcomplete", (_evt, _src, _tgt, addedEdge) => {
    const id = `e_${crypto.randomUUID()}`;
    addedEdge.data("id", id);
    notifyChange();
  });

  cy.on("dragfree", "node", () => notifyChange());

  cy.on("tap", "edge", (evt) => {
    onSelectEdge?.(evt.target);
  });

  cy.on("tap", (evt) => {
    if (evt.target === cy) onSelectEdge?.(null);
  });
}

export async function renderMap(snippets, edges, layoutMode, getImageUrl) {
  if (!cy) return;
  cy.elements().remove();

  const groupColor = (id) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 70% 55%)`;
  };

  const lighten = (c) => {
    let m = /hsl\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)%[\s,]+(\d+(?:\.\d+)?)%\s*\)/.exec(c);
    if (m) {
      const h = +m[1];
      const s = Math.min(70, +m[2]);
      return `hsl(${h}, ${s}%, 84%)`;
    }
    m = /^#([0-9a-fA-F]{3,6})$/.exec(c);
    if (m) {
      let hex = m[1];
      if (hex.length === 3) hex = hex.split("").map((x) => x + x).join("");
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      let h, s;
      if (max === min) { h = 0; s = 0; }
      else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
      }
      return `hsl(${Math.round(h)}, ${Math.min(70, Math.round(s * 100))}%, 84%)`;
    }
    return c;
  };

  const useCompound = layoutMode === "group";
  const groupParents = new Map();
  if (useCompound) {
    for (const s of snippets) {
      const primary = (s.groups && s.groups[0]) || null;
      if (primary && !groupParents.has(primary)) {
        groupParents.set(primary, true);
      }
    }
  }

  const parentNodes = useCompound
    ? [...groupParents.keys()].map((gid) => {
        const baseColor = groupColor(gid);
        return {
          group: "nodes",
          data: {
            id: `g_${gid}`,
            isGroup: true,
            color: baseColor,
            lightColor: lighten(baseColor),
            displayText: getGroupName ? getGroupName(gid) : "Group",
          },
        };
      })
    : [];

  const imageUrls = new Map();
  if (getImageUrl) {
    await Promise.all(
      snippets
        .filter((s) => s.kind === "image" && s.imagePath)
        .map(async (s) => {
          const url = await getImageUrl(s.imagePath);
          if (url) imageUrls.set(s.id, url);
        })
    );
  }

  const nodes = snippets.map((s) => {
    const text = s.text.length > 140 ? s.text.slice(0, 137) + "…" : s.text;
    const primary = (s.groups && s.groups[0]) || null;
    const isImage = s.kind === "image";
    return {
      group: "nodes",
      data: {
        id: s.id,
        snippetId: s.id,
        page: s.page,
        text: s.text,
        displayText: isImage ? `p.${s.page}` : `[p.${s.page}]\n${text}`,
        isImage: isImage || undefined,
        imageUrl: imageUrls.get(s.id) || undefined,
        group: primary,
        groupColor: primary ? groupColor(primary) : null,
        parent: useCompound && primary ? `g_${primary}` : undefined,
      },
      position: useCompound ? undefined : s.pos || undefined,
    };
  });

  const edgeEls = edges.map((e) => ({
    group: "edges",
    data: { id: e.id, source: e.source, target: e.target, label: e.label || "" },
  }));

  const membershipEdges = [];
  if (useCompound) {
    for (const s of snippets) {
      const gs = s.groups || [];
      for (let i = 1; i < gs.length; i++) {
        const gid = gs[i];
        if (!groupParents.has(gid)) continue;
        membershipEdges.push({
          group: "edges",
          data: {
            id: `mem_${s.id}_${gid}`,
            source: s.id,
            target: `g_${gid}`,
            isMembership: true,
            color: groupColor(gid),
          },
        });
      }
    }
  }

  cy.add(parentNodes);
  cy.add(nodes);
  cy.add(edgeEls);
  cy.add(membershipEdges);

  applyLayout(layoutMode, snippets);
}

export function applyLayout(mode, snippets) {
  if (!cy) return;
  cy.layout({
    name: "fcose",
    quality: "default",
    animate: false,
    randomize: true,
    fit: true,
    padding: 60,
    nodeRepulsion: 18000,
    idealEdgeLength: 140,
    edgeElasticity: 0.45,
    nestingFactor: 0.3,
    gravity: 0.18,
    gravityRange: 4,
    gravityRangeCompound: 2.0,
    gravityCompound: 0.6,
    numIter: 3500,
    tile: true,
    tilingPaddingVertical: 30,
    tilingPaddingHorizontal: 30,
    tilingCompareBy: undefined,
  }).run();
}

export function getEdgesData() {
  if (!cy) return [];
  return cy
    .edges()
    .filter((e) => !e.data("isMembership"))
    .map((e) => ({
      id: e.id(),
      source: e.source().id(),
      target: e.target().id(),
      label: e.data("label") || "",
    }));
}

export function getNodePositions() {
  if (!cy) return new Map();
  const map = new Map();
  cy.nodes().forEach((n) => {
    const p = n.position();
    map.set(n.id(), { x: p.x, y: p.y });
  });
  return map;
}

export function setEdgeLabel(edge, label) {
  if (!edge) return;
  edge.data("label", label);
  notifyChange();
}

export function deleteEdge(edge) {
  if (!edge) return;
  edge.remove();
  notifyChange();
}

export function fit() {
  if (cy) cy.fit(undefined, 30);
}

export function resize() {
  if (cy) cy.resize();
}

function notifyChange() {
  if (onChange) onChange();
}
