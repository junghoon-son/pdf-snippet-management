// Conformance tests for the anchoring algorithm core (SPEC.md §4).
//
// Tests target `findInFlat(flat, quote)` from src/ai/resolver.js — the
// pure substring matcher used by both the PDF and flow-doc resolvers.
// Returns [start, end] in original `flat` coordinates, or null when
// the quote can't be anchored (SPEC §4 Tier 4 — Orphaned).
//
// The implementation cascades through six internal tiers (exact,
// whitespace-tolerant regex, prefix-stripped retry, normalize-fuzzy,
// head-anchor for paraphrased tails, tail-anchor for paraphrased heads).
// Each test below names the tier it stresses.

import { describe, test, expect } from "bun:test";
import { findInFlat, normalizeWithMap } from "../../src/ai/resolver.js";

const SAMPLE = "Methods. We enrolled 1,024 patients aged 18–65. " +
               "Primary endpoint was mortality at 30 days. " +
               "We used a mixed-effects model with random intercepts. " +
               "Results. Mortality was 4.2% (95% CI 3.1–5.4). " +
               "The treatment group showed a statistically significant " +
               "reduction (p < 0.001). Discussion. These findings " +
               "support prior work by Smith et al.";

describe("findInFlat — tier 1 (exact substring)", () => {
  test("verbatim quote matches at the expected offset", () => {
    const r = findInFlat(SAMPLE, "Primary endpoint was mortality at 30 days.");
    expect(r).not.toBeNull();
    const [s, e] = r;
    expect(SAMPLE.slice(s, e)).toBe("Primary endpoint was mortality at 30 days.");
  });

  test("single-word quote matches", () => {
    const r = findInFlat(SAMPLE, "Mortality");
    expect(r).not.toBeNull();
    expect(SAMPLE.slice(r[0], r[1])).toBe("Mortality");
  });

  test("quote at end of doc", () => {
    const r = findInFlat(SAMPLE, "Smith et al.");
    expect(r).not.toBeNull();
    expect(r[1]).toBe(SAMPLE.length);
  });
});

describe("findInFlat — tier 2 (whitespace-tolerant regex)", () => {
  test("extra spaces in quote still match collapsed source", () => {
    const r = findInFlat(SAMPLE, "Primary  endpoint  was  mortality");
    expect(r).not.toBeNull();
    expect(SAMPLE.slice(r[0], r[1]).replace(/\s+/g, " "))
      .toBe("Primary endpoint was mortality");
  });

  test("dash normalization — hyphen-minus in quote vs en-dash in source", () => {
    const r = findInFlat(SAMPLE, "aged 18-65");
    expect(r).not.toBeNull();
    expect(SAMPLE.slice(r[0], r[1])).toBe("aged 18–65");
  });

  test("dash normalization — em-dash in quote vs en-dash in source", () => {
    const r = findInFlat(SAMPLE, "aged 18—65");
    expect(r).not.toBeNull();
  });

  test("quote variant — straight vs curly double quotes", () => {
    const src = 'He said "hello world" yesterday.';
    const r = findInFlat(src, "“hello world”");
    expect(r).not.toBeNull();
    expect(src.slice(r[0], r[1])).toBe('"hello world"');
  });
});

describe("findInFlat — tier 3 (leading-numbering strip)", () => {
  test("strips '1. ' prefix and matches the body", () => {
    const r = findInFlat(SAMPLE, "1. Primary endpoint was mortality at 30 days.");
    expect(r).not.toBeNull();
    expect(SAMPLE.slice(r[0], r[1])).toBe("Primary endpoint was mortality at 30 days.");
  });

  test("strips '(a) ' prefix and matches", () => {
    // The regex strips "a. " / "1. " / "I. " / "1) " etc. — test the
    // common letter-paren variant.
    const r = findInFlat(SAMPLE, "a) Mortality was 4.2%");
    expect(r).not.toBeNull();
    expect(SAMPLE.slice(r[0], r[1])).toBe("Mortality was 4.2%");
  });
});

describe("findInFlat — tier 4 (aggressive normalize-fuzzy)", () => {
  test("case-insensitive match via normalization", () => {
    const r = findInFlat(SAMPLE, "PRIMARY ENDPOINT WAS MORTALITY AT 30 DAYS");
    expect(r).not.toBeNull();
    expect(SAMPLE.slice(r[0], r[1]).toLowerCase()).toBe("primary endpoint was mortality at 30 days");
  });

  test("soft-hyphen-in-source matches dehyphenated quote", () => {
    // Source has a soft hyphen mid-word; quote does not.
    const src = "The me­thod we used was simple.";
    const r = findInFlat(src, "method we used");
    expect(r).not.toBeNull();
  });

  test("line-end hyphenation rejoined across whitespace", () => {
    // Source has "method-\nology" — the dash+whitespace gets dropped
    // during normalization so "methodology" matches.
    const src = "We describe our method-\nology in detail.";
    const r = findInFlat(src, "methodology");
    expect(r).not.toBeNull();
  });

  test("ligature in source matches expanded quote", () => {
    // U+FB01 "fi" ligature → "fi" during normalization.
    const src = "The deﬁnition is given below.";
    const r = findInFlat(src, "definition");
    expect(r).not.toBeNull();
  });
});

describe("findInFlat — tier 5/6 (head/tail anchor for paraphrased ends)", () => {
  test("returns null for completely unrelated quote (Tier 4 — Orphaned)", () => {
    const r = findInFlat(SAMPLE, "This sentence appears nowhere in the source document at all.");
    expect(r).toBeNull();
  });

  test("returns null for empty inputs", () => {
    expect(findInFlat("", "anything")).toBeNull();
    expect(findInFlat(SAMPLE, "")).toBeNull();
    expect(findInFlat("", "")).toBeNull();
  });
});

describe("normalizeWithMap — SPEC §4.1 transforms", () => {
  test("collapses whitespace runs and lowercases", () => {
    const { norm } = normalizeWithMap("Hello   World");
    expect(norm).toBe("hello world");
  });

  test("strips soft hyphens (U+00AD)", () => {
    const { norm } = normalizeWithMap("me­thod");
    expect(norm).toBe("method");
  });

  test("maps dashes to '-'", () => {
    const { norm } = normalizeWithMap("a–b—c−d");
    expect(norm).toBe("a-b-c-d");
  });

  test("maps double-quote variants to '\"'", () => {
    const { norm } = normalizeWithMap("“hi”");
    expect(norm).toBe('"hi"');
  });

  test("maps single-quote variants to '''", () => {
    const { norm } = normalizeWithMap("‘hi’");
    expect(norm).toBe("'hi'");
  });

  test("expands ellipsis to three dots", () => {
    const { norm } = normalizeWithMap("wait… stop");
    expect(norm).toBe("wait... stop");
  });

  test("origOf table maps every normalized index back into the original", () => {
    const src = "He­llo";
    const { norm, origOf } = normalizeWithMap(src);
    expect(norm).toBe("hello");
    expect(origOf[origOf.length - 1]).toBe(src.length);
    // The 'l' after the soft hyphen should map past the hyphen in source.
    const idxOfThirdChar = 2; // 'l' in normalized "hello"
    expect(origOf[idxOfThirdChar]).toBeGreaterThanOrEqual(2);
  });
});
