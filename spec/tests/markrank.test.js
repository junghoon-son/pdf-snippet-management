// Conformance tests for MarkRank (SPEC.md §8).
// Verifies the PageRank-variant centrality computation in src/markrank.js.

import { describe, test, expect } from "bun:test";
import { computeMarkRank, rankPercentiles } from "../../src/markrank.js";

const closeTo = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

describe("computeMarkRank — base cases", () => {
  test("empty graph returns an empty map", () => {
    const r = computeMarkRank([], []);
    expect(r.size).toBe(0);
  });

  test("single node gets all the mass", () => {
    const r = computeMarkRank([{ id: "a" }], []);
    expect(r.size).toBe(1);
    expect(closeTo(r.get("a"), 1)).toBe(true);
  });

  test("isolated nodes share mass uniformly", () => {
    const r = computeMarkRank(
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      [],
    );
    expect(r.size).toBe(4);
    for (const v of r.values()) expect(closeTo(v, 0.25, 1e-5)).toBe(true);
  });
});

describe("computeMarkRank — convergence + distribution", () => {
  test("two-node cycle is symmetric", () => {
    // a → b, b → a — perfectly symmetric, should each score 0.5.
    const r = computeMarkRank(
      [{ id: "a" }, { id: "b" }],
      [{ id: "e1", source: "a", target: "b" }, { id: "e2", source: "b", target: "a" }],
    );
    expect(closeTo(r.get("a"), 0.5, 1e-5)).toBe(true);
    expect(closeTo(r.get("b"), 0.5, 1e-5)).toBe(true);
  });

  test("ranks sum to ~1 on an arbitrary graph", () => {
    const snippets = [
      { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" },
    ];
    const edges = [
      { id: "1", source: "a", target: "b" },
      { id: "2", source: "b", target: "c" },
      { id: "3", source: "c", target: "a" },
      { id: "4", source: "d", target: "a" },
      { id: "5", source: "e", target: "a" },
    ];
    const r = computeMarkRank(snippets, edges);
    let total = 0;
    for (const v of r.values()) total += v;
    expect(closeTo(total, 1, 1e-5)).toBe(true);
  });

  test("popular node ranks above an isolated node", () => {
    // a has 3 inbound edges; z is isolated.
    const snippets = [
      { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "z" },
    ];
    const edges = [
      { id: "1", source: "b", target: "a" },
      { id: "2", source: "c", target: "a" },
      { id: "3", source: "d", target: "a" },
    ];
    const r = computeMarkRank(snippets, edges);
    expect(r.get("a")).toBeGreaterThan(r.get("z"));
    expect(r.get("a")).toBeGreaterThan(r.get("b"));
  });

  test("self-loops are ignored", () => {
    // s === t edges are skipped. Result should match the no-edge case.
    const r1 = computeMarkRank(
      [{ id: "a" }, { id: "b" }],
      [{ id: "self", source: "a", target: "a" }],
    );
    const r2 = computeMarkRank([{ id: "a" }, { id: "b" }], []);
    expect(closeTo(r1.get("a"), r2.get("a"), 1e-6)).toBe(true);
    expect(closeTo(r1.get("b"), r2.get("b"), 1e-6)).toBe(true);
  });
});

describe("rankPercentiles", () => {
  test("empty map → empty map", () => {
    expect(rankPercentiles(new Map()).size).toBe(0);
  });

  test("single entry gets percentile 1", () => {
    const out = rankPercentiles(new Map([["only", 0.42]]));
    expect(out.get("only")).toBe(1);
  });

  test("monotonic order — lowest score gets 0, highest gets 1", () => {
    const scores = new Map([["low", 0.1], ["mid", 0.3], ["high", 0.6]]);
    const out = rankPercentiles(scores);
    expect(out.get("low")).toBe(0);
    expect(out.get("high")).toBe(1);
    expect(out.get("mid")).toBeGreaterThan(0);
    expect(out.get("mid")).toBeLessThan(1);
  });
});
