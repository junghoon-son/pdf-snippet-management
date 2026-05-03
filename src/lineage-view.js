import cytoscape from "cytoscape";

const COL_DOC_X = 140;
const COL_SNIPPET_X = 560;
const COL_GROUP_X = 980;
const ROW_GAP = 60;
const DOC_NODE_W = 220;
const SNIPPET_NODE_W = 320;
const GROUP_NODE_W = 200;

let cy = null;
let onSnippetClick = null;
let onDocClick = null;
let getGroupName = (id) => `Group ${id.slice(0, 4)}`;
let getGroupColor = () => "#bbb";

export function initLineage(container, callbacks) {
  onSnippetClick = callbacks.onSnippetClick;
  onDocClick = callbacks.onDocClick;
  getGroupName = callbacks.groupName || getGroupName;
  getGroupColor = callbacks.groupColor || getGroupColor;

  cy = cytoscape({
    container,
    minZoom: 0.25,
    maxZoom: 2.5,
    wheelSensitivity: 0.2,
    style: [
      {
        selector: "node",
        style: {
          "background-color": "#fbf9f3",
          "border-width": 1,
          "border-color": "#cfc8b6",
          "shape": "round-rectangle",
          "label": "data(label)",
          "color": "#1f1f1f",
          "font-family": "ui-sans-serif, -apple-system, system-ui",
          "font-size": "11px",
          "text-wrap": "wrap",
          "text-valign": "center",
          "text-halign": "center",
          "padding": 10,
          "min-zoomed-font-size": 6,
        },
      },
      {
        selector: "node[type='doc']",
        style: {
          "background-color": "#ece8dc",
          "border-color": "#a89e83",
          "border-width": 2,
          "width": DOC_NODE_W,
          "height": 56,
          "text-max-width": DOC_NODE_W - 24,
          "font-weight": 600,
          "font-size": "12px",
          "shape": "round-rectangle",
        },
      },
      {
        selector: "node[type='snippet']",
        style: {
          "background-color": "#fbf9f3",
          "border-color": "#d4cebc",
          "width": SNIPPET_NODE_W,
          "height": "label",
          "text-max-width": SNIPPET_NODE_W - 24,
          "font-family": "ui-serif, 'Iowan Old Style', Charter, Georgia, serif",
          "font-size": "11px",
          "padding": 12,
        },
      },
      {
        selector: "node[type='snippet'][?isImage]",
        style: {
          "background-image": "data(imageUrl)",
          "background-fit": "cover",
          "width": 140,
          "height": 90,
          "label": "",
          "border-color": "#2ea58c",
          "border-width": 2,
        },
      },
      {
        selector: "node[type='group']",
        style: {
          "background-color": "data(color)",
          "background-opacity": 0.9,
          "border-color": "data(color)",
          "border-width": 2,
          "color": "#1a1a1a",
          "shape": "round-rectangle",
          "width": GROUP_NODE_W,
          "height": 40,
          "text-max-width": GROUP_NODE_W - 20,
          "font-weight": 600,
          "font-size": "12px",
        },
      },
      {
        selector: "node:selected",
        style: {
          "border-color": "#2ea58c",
          "border-width": 3,
          "overlay-opacity": 0,
        },
      },
      {
        selector: "edge",
        style: {
          "curve-style": "bezier",
          "control-point-step-size": 60,
          "width": 1.4,
          "line-color": "#c0b89c",
          "target-arrow-shape": "none",
          "opacity": 0.55,
        },
      },
      {
        selector: "edge[type='doc-snippet']",
        style: {
          "line-color": "#a89e83",
          "opacity": 0.45,
        },
      },
      {
        selector: "edge[type='snippet-group']",
        style: {
          "line-color": "data(color)",
          "opacity": 0.7,
          "width": 2,
        },
      },
      {
        selector: "edge.hot",
        style: {
          "opacity": 1,
          "width": 3,
          "line-color": "#2ea58c",
        },
      },
      {
        selector: "node.dim",
        style: {
          "opacity": 0.25,
        },
      },
      {
        selector: "edge.dim",
        style: {
          "opacity": 0.08,
        },
      },
    ],
    layout: { name: "preset" },
  });

  cy.on("tap", "node[type='snippet']", (evt) => {
    const data = evt.target.data();
    onSnippetClick?.(data.snippetId, data.pdfPath);
  });
  cy.on("tap", "node[type='doc']", (evt) => {
    const data = evt.target.data();
    onDocClick?.(data.pdfPath);
  });

  cy.on("mouseover", "node", (evt) => focusNode(evt.target));
  cy.on("mouseout", "node", () => clearFocus());
}

function focusNode(node) {
  if (!cy) return;
  const connected = node.connectedEdges();
  const neighbors = connected.connectedNodes().union(node);
  cy.elements().not(neighbors).addClass("dim");
  cy.elements().not(connected).filter("edge").addClass("dim");
  connected.removeClass("dim").addClass("hot");
}

function clearFocus() {
  if (!cy) return;
  cy.elements().removeClass("dim hot");
}

function ellipsis(s, n = 32) {
  const t = String(s || "");
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + "…";
}

function snippetPreview(s) {
  if (s.kind === "image") return `[image · p.${s.page}]`;
  const text = (s.text || "").trim();
  return ellipsis(text, 140);
}

export async function renderLineage(snippets, groupsMeta, getImageUrl) {
  if (!cy) return;
  const elements = [];

  // 1. Group docs
  const docMap = new Map();
  for (const s of snippets) {
    const path = s._pdfPath || "(unknown)";
    if (!docMap.has(path)) docMap.set(path, []);
    docMap.get(path).push(s);
  }
  const docPaths = [...docMap.keys()].sort();

  // 2. Build group inventory (only groups that have at least one snippet here, plus all visible global groups)
  const groupsSet = new Set();
  for (const s of snippets) for (const g of s.groups || []) groupsSet.add(g);
  const visibleGroups = [...groupsSet].filter((gid) => {
    const meta = (groupsMeta || []).find((g) => g.id === gid);
    return !meta || !meta.hidden;
  });

  // 3. Layout: stack each column
  const docY = (i, total) => (i - (total - 1) / 2) * (90);
  const snippetIndex = new Map();
  let snippetSlot = 0;
  for (const path of docPaths) {
    const docSnippets = docMap.get(path);
    docSnippets.sort((a, b) => (a.page - b.page) || 0);
    for (const s of docSnippets) {
      snippetIndex.set(s.id, snippetSlot++);
    }
  }
  const totalSnippets = snippetSlot;
  const snippetY = (slot) => (slot - (totalSnippets - 1) / 2) * ROW_GAP;
  const groupY = (i, total) => (i - (total - 1) / 2) * 80;

  // 4. Doc nodes
  docPaths.forEach((path, i) => {
    const filename = path.split("/").pop() || path;
    const display = ellipsis(filename, 28);
    elements.push({
      group: "nodes",
      data: {
        id: `doc::${path}`,
        type: "doc",
        label: display,
        pdfPath: path,
        title: filename,
      },
      position: { x: COL_DOC_X, y: docY(i, docPaths.length) * docPaths.length / Math.max(1, docPaths.length) || 0 },
    });
  });

  // Reposition docs proportionally to their snippet groups
  // Average y of the doc's snippets so the doc lines up vertically
  for (const node of elements) {
    if (node.data.type !== "doc") continue;
    const path = node.data.pdfPath;
    const snippetSlots = docMap.get(path).map((s) => snippetY(snippetIndex.get(s.id)));
    const avg = snippetSlots.reduce((a, b) => a + b, 0) / snippetSlots.length;
    node.position.y = avg;
  }

  // 5. Snippet nodes + image URLs
  for (const path of docPaths) {
    for (const s of docMap.get(path)) {
      const isImage = s.kind === "image";
      let imageUrl = "";
      if (isImage && getImageUrl && s.imagePath) {
        try {
          imageUrl = await getImageUrl(s.imagePath, path);
        } catch {}
      }
      elements.push({
        group: "nodes",
        data: {
          id: `snip::${s.id}`,
          type: "snippet",
          snippetId: s.id,
          pdfPath: path,
          isImage,
          imageUrl,
          label: snippetPreview(s),
        },
        position: { x: COL_SNIPPET_X, y: snippetY(snippetIndex.get(s.id)) },
      });
      // doc → snippet edge
      elements.push({
        group: "edges",
        data: {
          id: `e-doc-${s.id}`,
          source: `doc::${path}`,
          target: `snip::${s.id}`,
          type: "doc-snippet",
        },
      });
    }
  }

  // 6. Group nodes + snippet→group edges
  visibleGroups.forEach((gid, i) => {
    const meta = (groupsMeta || []).find((g) => g.id === gid);
    elements.push({
      group: "nodes",
      data: {
        id: `grp::${gid}`,
        type: "group",
        groupId: gid,
        color: getGroupColor(gid),
        label: ellipsis(getGroupName(gid) || `Group ${gid.slice(0, 4)}`, 22),
      },
      position: { x: COL_GROUP_X, y: groupY(i, visibleGroups.length) },
    });
  });

  // Reposition groups to be near the average y of their member snippets
  const groupNodes = elements.filter((e) => e.data?.type === "group");
  for (const g of groupNodes) {
    const memberSlots = snippets
      .filter((s) => (s.groups || []).includes(g.data.groupId))
      .map((s) => snippetY(snippetIndex.get(s.id)))
      .filter((y) => y !== undefined);
    if (memberSlots.length > 0) {
      g.position.y = memberSlots.reduce((a, b) => a + b, 0) / memberSlots.length;
    }
  }
  // Spread groups vertically if they overlap
  spreadOverlaps(groupNodes, 50);

  // 7. snippet → group edges
  for (const s of snippets) {
    for (const gid of s.groups || []) {
      if (!visibleGroups.includes(gid)) continue;
      elements.push({
        group: "edges",
        data: {
          id: `e-grp-${s.id}-${gid}`,
          source: `snip::${s.id}`,
          target: `grp::${gid}`,
          type: "snippet-group",
          color: getGroupColor(gid),
        },
      });
    }
  }

  cy.elements().remove();
  cy.add(elements);
  cy.fit(undefined, 40);
}

function spreadOverlaps(nodes, minGap) {
  nodes.sort((a, b) => a.position.y - b.position.y);
  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1].position.y;
    if (nodes[i].position.y - prev < minGap) {
      nodes[i].position.y = prev + minGap;
    }
  }
}

export function resize() {
  if (cy) cy.resize();
}

export function fit() {
  if (cy) cy.fit(undefined, 40);
}
