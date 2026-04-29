import cytoscape from "cytoscape";
import edgehandles from "cytoscape-edgehandles";

cytoscape.use(edgehandles);

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
          "background-color": "#1f1f1f",
          "border-width": 1,
          "border-color": "#3a3a3a",
          "shape": "round-rectangle",
          "label": "data(displayText)",
          "color": "#cfcfcf",
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
        selector: "node[?isGroup]",
        style: {
          "background-color": "data(color)",
          "background-opacity": 0.08,
          "border-color": "data(color)",
          "border-width": 2,
          "shape": "round-rectangle",
          "label": "data(displayText)",
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": -8,
          "color": "data(color)",
          "font-family": "ui-sans-serif, -apple-system, system-ui",
          "font-size": "13px",
          "font-weight": 600,
          "padding": "26px",
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
          "line-color": "#5a5a5a",
          "target-arrow-color": "#5a5a5a",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "label": "data(label)",
          "font-size": "9px",
          "color": "#9a9a9a",
          "text-background-color": "#1a1a1a",
          "text-background-opacity": 1,
          "text-background-padding": 3,
          "font-family": "ui-monospace, 'SF Mono', monospace",
        },
      },
      {
        selector: "edge:selected",
        style: { "line-color": "#4ec9b0", "target-arrow-color": "#4ec9b0" },
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

export function renderMap(snippets, edges, layoutMode) {
  if (!cy) return;
  cy.elements().remove();

  const groupColor = (id) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 70% 55%)`;
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
    ? [...groupParents.keys()].map((gid) => ({
        group: "nodes",
        data: {
          id: `g_${gid}`,
          isGroup: true,
          color: groupColor(gid),
          displayText: getGroupName ? getGroupName(gid) : "Group",
        },
      }))
    : [];

  const nodes = snippets.map((s) => {
    const text = s.text.length > 140 ? s.text.slice(0, 137) + "…" : s.text;
    const primary = (s.groups && s.groups[0]) || null;
    return {
      group: "nodes",
      data: {
        id: s.id,
        snippetId: s.id,
        page: s.page,
        text: s.text,
        displayText: `[p.${s.page}]\n${text}`,
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

  cy.add(parentNodes);
  cy.add(nodes);
  cy.add(edgeEls);

  applyLayout(layoutMode, snippets);
}

export function applyLayout(mode, snippets) {
  if (!cy) return;
  const hasPositions = cy.nodes().every((n) => {
    const s = snippets.find((x) => x.id === n.id());
    return s && s.pos;
  });

  if (mode === "page") {
    cy.layout({
      name: "preset",
      positions: (n) => {
        const s = snippets.find((x) => x.id === n.id());
        if (!s) return { x: 0, y: 0 };
        const col = (s.rects?.[0]?.left ?? 0) > 0.5 ? 1 : 0;
        const x = col * (NODE_W + 60);
        const y = (s.page - 1) * 220 + (s.rects?.[0]?.top ?? 0) * 200;
        return { x, y };
      },
      fit: true,
      padding: 30,
    }).run();
  } else if (mode === "group") {
    if (hasPositions) {
      cy.layout({
        name: "preset",
        positions: (n) => {
          const s = snippets.find((x) => x.id === n.id());
          return s?.pos || { x: 0, y: 0 };
        },
        fit: true,
        padding: 30,
      }).run();
    } else {
      cy.layout({
        name: "cose",
        idealEdgeLength: 140,
        nodeOverlap: 12,
        refresh: 20,
        fit: true,
        padding: 30,
        randomize: true,
        componentSpacing: 100,
        nodeRepulsion: 8000,
        edgeElasticity: 100,
        nestingFactor: 5,
        gravity: 60,
        numIter: 800,
      }).run();
    }
  }
}

export function getEdgesData() {
  if (!cy) return [];
  return cy.edges().map((e) => ({
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
