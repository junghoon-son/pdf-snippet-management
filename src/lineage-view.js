import cytoscape from "cytoscape";

const COL_DOC_X = 110;
const COL_SNIPPET_X = 400;
const COL_GROUP_X = 680;
const ROW_GAP = 78;
const DOC_NODE_W = 170;
const DOC_NODE_H = 42;
const SNIPPET_NODE_W = 260;
const SNIPPET_NODE_H = 56;
const GROUP_NODE_W = 150;
const GROUP_NODE_H = 30;

let cy = null;
let onSnippetClick = null;
let onDocClick = null;
let getGroupName = (id) => `Group ${id.slice(0, 4)}`;
let getGroupColor = () => "#bbb";
const searchTextCache = new Map();

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
          "font-family": "ui-serif, 'Iowan Old Style', Charter, Georgia, serif",
          "font-size": "10.5px",
          "text-wrap": "wrap",
          "text-valign": "center",
          "text-halign": "center",
          "padding": 6,
          "min-zoomed-font-size": 6,
        },
      },
      {
        selector: "node[type='doc']",
        style: {
          "background-color": "#ece8dc",
          "border-color": "#a89e83",
          "border-width": 1,
          "width": DOC_NODE_W,
          "height": DOC_NODE_H,
          "text-max-width": DOC_NODE_W - 16,
          "font-style": "italic",
          "font-size": "11px",
          "shape": "round-rectangle",
          "padding": 6,
        },
      },
      {
        selector: "node[type='snippet']",
        style: {
          "background-color": "#fbf9f3",
          "border-color": "#d4cebc",
          "width": SNIPPET_NODE_W,
          "height": SNIPPET_NODE_H,
          "text-max-width": SNIPPET_NODE_W - 16,
          "text-overflow-wrap": "ellipsis",
          "font-family": "ui-serif, 'Iowan Old Style', Charter, Georgia, serif",
          "font-size": "10.5px",
          "line-height": 1.35,
          "padding": 7,
        },
      },
      {
        selector: "node[type='snippet'][?isImage]",
        style: {
          "background-image": "data(imageUrl)",
          "background-fit": "cover",
          "width": 110,
          "height": 72,
          "label": "",
          "border-color": "#2ea58c",
          "border-width": 1.5,
        },
      },
      {
        selector: "node[type='group']",
        style: {
          "background-color": "data(color)",
          "background-opacity": 0.9,
          "border-color": "data(color)",
          "border-width": 1.5,
          "color": "#1a1a1a",
          "shape": "round-rectangle",
          "width": GROUP_NODE_W,
          "height": GROUP_NODE_H,
          "text-max-width": GROUP_NODE_W - 14,
          "font-style": "italic",
          "font-size": "11px",
          "padding": 5,
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
          "opacity": 0.18,
        },
      },
      {
        selector: "edge.dim",
        style: {
          "opacity": 0.06,
        },
      },
      {
        selector: "node.match",
        style: {
          "border-color": "#d97757",
          "border-width": 3,
          "shadow-blur": 18,
          "shadow-color": "#d97757",
          "shadow-opacity": 0.7,
        },
      },
      {
        selector: "node.connected",
        style: {
          "border-color": "#2ea58c",
          "border-width": 2,
        },
      },
      {
        selector: "edge.connected",
        style: {
          "line-color": "#2ea58c",
          "opacity": 0.85,
          "width": 2.4,
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
  // Directional traversal so hovering a terminal (doc or group) doesn't
  // bleed across sibling terminals via shared snippets:
  //   - doc:     successors only (its snippets + their groups)
  //   - group:   predecessors only (its snippets + their source docs)
  //   - snippet: both directions (its doc + all its groups)
  const type = node.data("type");
  let focusedNodes, focusedEdges;
  if (type === "group") {
    const preds = node.predecessors();
    focusedNodes = preds.nodes().union(node);
    focusedEdges = preds.edges();
  } else if (type === "doc") {
    const succs = node.successors();
    focusedNodes = succs.nodes().union(node);
    focusedEdges = succs.edges();
  } else {
    const preds = node.predecessors();
    const succs = node.successors();
    focusedNodes = preds.nodes().union(succs.nodes()).union(node);
    focusedEdges = preds.edges().union(succs.edges());
  }
  cy.elements().addClass("dim");
  focusedNodes.removeClass("dim");
  focusedEdges.removeClass("dim").addClass("hot");
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

function bold(s) {
  return Array.from(String(s)).map((c) => {
    const code = c.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D400 + code - 65);
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D41A + code - 97);
    if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7CE + code - 48);
    return c;
  }).join("");
}

function kindIcon(kind) {
  if (kind === "markdown") return "📝";
  if (kind === "docx") return "📘";
  return "📄";
}

function kindFromPath(p) {
  const m = (p || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return "pdf";
  if (m[1] === "md" || m[1] === "markdown") return "markdown";
  if (m[1] === "docx") return "docx";
  return "pdf";
}

function snippetPreview(s) {
  if (s.kind === "image") return `[image · ${bold(`p.${s.page}`)}]`;
  const text = (s.text || "").trim();
  const loc = s.anchor ? bold(`§ ${ellipsis(s.anchor, 24)}`) : bold(`p.${s.page}`);
  return `${loc}\n${ellipsis(text, 90)}`;
}

export async function renderLineage(snippets, groupsMeta, getImageUrl) {
  if (!cy) return;
  searchTextCache.clear();
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
    docSnippets.sort((a, b) => {
      if (typeof a.flowPos === "number" && typeof b.flowPos === "number") return a.flowPos - b.flowPos;
      return (a.page - b.page) || 0;
    });
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
    const kind = kindFromPath(path);
    const display = `${kindIcon(kind)}  ${ellipsis(filename, 24)}`;
    elements.push({
      group: "nodes",
      data: {
        id: `doc::${path}`,
        type: "doc",
        kind,
        label: display,
        pdfPath: path,
        title: filename,
        searchText: `${filename} ${path}`,
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
          searchText: `${s.text || ""} ${s.comment || ""} ${s.anchor || ""} p.${s.page}`,
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
    const fullName = getGroupName(gid) || `Group ${gid.slice(0, 4)}`;
    elements.push({
      group: "nodes",
      data: {
        id: `grp::${gid}`,
        type: "group",
        groupId: gid,
        color: getGroupColor(gid),
        label: ellipsis(fullName, 22),
        searchText: fullName,
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

export function applyFilter(query) {
  if (!cy) return { matchCount: 0, error: null };
  cy.elements().removeClass("dim match connected");
  const trimmed = (query || "").trim();
  if (!trimmed) return { matchCount: 0, error: null };
  let regex;
  try {
    regex = new RegExp(trimmed, "i");
  } catch (err) {
    return { matchCount: 0, error: err.message };
  }
  const matched = cy.nodes().filter((n) => {
    const text = n.data("searchText") || "";
    return regex.test(text);
  });
  if (matched.length === 0) {
    cy.elements().addClass("dim");
    return { matchCount: 0, error: null };
  }
  const connectedEdges = matched.connectedEdges();
  const connectedNodes = connectedEdges.connectedNodes().difference(matched);
  const everything = cy.elements();
  const focused = matched.union(connectedEdges).union(connectedNodes);
  everything.difference(focused).addClass("dim");
  matched.addClass("match");
  connectedNodes.addClass("connected");
  connectedEdges.addClass("connected");
  return { matchCount: matched.length, error: null };
}

export function clearFilter() {
  if (!cy) return;
  cy.elements().removeClass("dim match connected");
}

export function resize() {
  if (cy) cy.resize();
}

export function fit() {
  if (cy) cy.fit(undefined, 40);
}
