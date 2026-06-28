// Verifies the pure import helpers in src/source-kind.js used by the
// web upload path in main.js (importFiles -> store.importDocument).
import { describe, test, expect } from "bun:test";
import { sanitizeImportName, fileToDescriptor } from "../../src/source-kind.js";

describe("sanitizeImportName", () => {
  test("strips directory components", () => {
    expect(sanitizeImportName("/Users/me/docs/paper.pdf")).toBe("paper.pdf");
    expect(sanitizeImportName("a\\b\\c.pdf")).toBe("c.pdf");
  });
  test("removes reserved / control characters", () => {
    expect(sanitizeImportName('re<po>rt:final?.pdf')).toBe("report final.pdf");
  });
  test("trims leading/trailing dots and spaces", () => {
    expect(sanitizeImportName("  ..notes.md..  ")).toBe("notes.md");
  });
  test("empty / falsy names fall back to 'untitled'", () => {
    expect(sanitizeImportName("")).toBe("untitled");
    expect(sanitizeImportName(null)).toBe("untitled");
    expect(sanitizeImportName("///")).toBe("untitled");
  });
});

describe("fileToDescriptor", () => {
  test("derives sanitized name and kind from a File-like object", () => {
    expect(fileToDescriptor({ name: "/tmp/Slides.PDF" })).toEqual({ name: "Slides.PDF", kind: "pdf" });
    expect(fileToDescriptor({ name: "notes.md" })).toEqual({ name: "notes.md", kind: "markdown" });
    expect(fileToDescriptor({ name: "cover.PNG" })).toEqual({ name: "cover.PNG", kind: "image" });
  });
  test("unknown extension defaults kind to pdf", () => {
    expect(fileToDescriptor({ name: "data.xyz" })).toEqual({ name: "data.xyz", kind: "pdf" });
  });
});
