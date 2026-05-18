// Conformance tests for normalizeText (SPEC.md §4.1 storage form).
// Verifies the six transforms in src/flow-viewer.js → normalizeText.
//
// Note: normalizeText is the STORAGE form (used for textNormalized fields).
// Case is NOT folded here — case-folding only applies when matching, per
// the spec. The matching-time case fold lives in normalizeWithMap (covered
// in anchoring.test.js).

import { describe, test, expect } from "bun:test";
import { normalizeText } from "../../src/flow-viewer.js";

describe("normalizeText", () => {
  test("null/undefined input → empty string", () => {
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
  });

  test("strips soft hyphens (U+00AD)", () => {
    expect(normalizeText("me­thod")).toBe("method");
  });

  test("converts non-breaking space (U+00A0) to regular space", () => {
    expect(normalizeText("hello world")).toBe("hello world");
  });

  test("collapses whitespace runs to a single space", () => {
    expect(normalizeText("a   b\t\tc\n\nd")).toBe("a b c d");
  });

  test("trims leading and trailing whitespace", () => {
    expect(normalizeText("   hello   ")).toBe("hello");
  });

  test("preserves case (storage form does not fold case)", () => {
    expect(normalizeText("HelloWorld")).toBe("HelloWorld");
  });

  test("end-to-end: SPEC §4.1 example shape", () => {
    // Combines newline, leading/trailing whitespace, soft hyphen.
    const input = "  load-­bearing\nquote  ";
    expect(normalizeText(input)).toBe("load-bearing quote");
  });
});
