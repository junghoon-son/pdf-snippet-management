// Source-kind detection from file path (SPEC.md §2.1 document table).
// Verifies detectKindFromPath in src/source-kind.js — the single source
// of truth for routing main.js's loadAnyDocument.

import { describe, test, expect } from "bun:test";
import { detectKindFromPath, IMAGE_EXTS } from "../../src/source-kind.js";

describe("detectKindFromPath", () => {
  test("PDF extension → pdf", () => {
    expect(detectKindFromPath("paper.pdf")).toBe("pdf");
    expect(detectKindFromPath("/abs/path/file.PDF")).toBe("pdf");
  });

  test("Markdown extensions → markdown", () => {
    expect(detectKindFromPath("notes.md")).toBe("markdown");
    expect(detectKindFromPath("notes.markdown")).toBe("markdown");
    expect(detectKindFromPath("notes.MD")).toBe("markdown");
  });

  test("DOCX extension → docx", () => {
    expect(detectKindFromPath("report.docx")).toBe("docx");
    expect(detectKindFromPath("report.DOCX")).toBe("docx");
  });

  test("text extensions → text", () => {
    expect(detectKindFromPath("readme.txt")).toBe("text");
    expect(detectKindFromPath("readme.text")).toBe("text");
  });

  test("PNG/JPG/JPEG → image (case-insensitive)", () => {
    expect(detectKindFromPath("cover.png")).toBe("image");
    expect(detectKindFromPath("cover.PNG")).toBe("image");
    expect(detectKindFromPath("photo.jpg")).toBe("image");
    expect(detectKindFromPath("photo.JPG")).toBe("image");
    expect(detectKindFromPath("photo.jpeg")).toBe("image");
    expect(detectKindFromPath("photo.JPEG")).toBe("image");
  });

  test("path with directory components → matched on extension only", () => {
    expect(detectKindFromPath("/Users/me/docs/2026/cover.png")).toBe("image");
    expect(detectKindFromPath("./relative/figure.jpeg")).toBe("image");
  });

  test("unknown / missing extension defaults to pdf", () => {
    expect(detectKindFromPath("file")).toBe("pdf");
    expect(detectKindFromPath("")).toBe("pdf");
    expect(detectKindFromPath("file.unknown")).toBe("pdf");
  });

  test("filename with dots but no recognized ext → pdf", () => {
    expect(detectKindFromPath("my.long.named.file.xyz")).toBe("pdf");
  });

  test("IMAGE_EXTS exported list matches the detector", () => {
    expect(IMAGE_EXTS).toEqual(["png", "jpg", "jpeg"]);
    for (const ext of IMAGE_EXTS) {
      expect(detectKindFromPath(`x.${ext}`)).toBe("image");
    }
  });
});
