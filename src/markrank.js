// MarkRank — PageRank over the snippet→snippet lineage graph.
// Returns a Map<snippetId, score> where scores sum to ~1 across all nodes.
// Higher score = more central / more cited within the graph.
//
// Edges are directed: an edge {source, target} means `source` references
// `target`. We rank "incoming attention" — a snippet many others point to
// scores higher than one with no inbound edges. Dangling nodes (no outgoing
// edges) distribute their rank uniformly to avoid trapping.
export function computeMarkRank(snippets, edges, opts = {}) {
  const damping = opts.damping ?? 0.85;
  const tolerance = opts.tolerance ?? 1e-7;
  const maxIter = opts.maxIter ?? 100;

  const ids = snippets.map((s) => s.id);
  const N = ids.length;
  if (N === 0) return new Map();

  const idx = new Map();
  for (let i = 0; i < N; i++) idx.set(ids[i], i);

  const outAdj = Array.from({ length: N }, () => []);
  const inAdj = Array.from({ length: N }, () => []);
  for (const e of edges || []) {
    const s = idx.get(e.source);
    const t = idx.get(e.target);
    if (s == null || t == null || s === t) continue;
    outAdj[s].push(t);
    inAdj[t].push(s);
  }

  let rank = new Float64Array(N);
  for (let i = 0; i < N; i++) rank[i] = 1 / N;
  const next = new Float64Array(N);
  const teleport = (1 - damping) / N;

  for (let iter = 0; iter < maxIter; iter++) {
    let danglingMass = 0;
    for (let i = 0; i < N; i++) {
      if (outAdj[i].length === 0) danglingMass += rank[i];
    }
    const danglingShare = (damping * danglingMass) / N;

    let diff = 0;
    for (let i = 0; i < N; i++) {
      let inflow = 0;
      const incoming = inAdj[i];
      for (let k = 0; k < incoming.length; k++) {
        const j = incoming[k];
        inflow += rank[j] / outAdj[j].length;
      }
      next[i] = teleport + danglingShare + damping * inflow;
      diff += Math.abs(next[i] - rank[i]);
    }

    [rank, /* swap */] = [Float64Array.from(next), rank];
    if (diff < tolerance) break;
  }

  const result = new Map();
  for (let i = 0; i < N; i++) result.set(ids[i], rank[i]);
  return result;
}

// Convenience: percentile rank (0..1) within the score distribution. Useful
// for UI badges where the absolute PageRank value is opaque but "this is
// in the top 10% of cited snippets" is intuitive.
export function rankPercentiles(scores) {
  const entries = [...scores.entries()].sort((a, b) => a[1] - b[1]);
  const out = new Map();
  const n = entries.length;
  if (n === 0) return out;
  for (let i = 0; i < n; i++) {
    out.set(entries[i][0], n === 1 ? 1 : i / (n - 1));
  }
  return out;
}
