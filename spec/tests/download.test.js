// Unit tests for the pure part of the browser download helper
// (src/storage/download.js). buildDownloadBlob() is the load-bearing,
// DOM-free piece that replaced the desktop-only invoke("write_file").
// triggerDownload() is DOM glue and is verified manually (see Task 4).

import { describe, test, expect } from "bun:test";
import { buildDownloadBlob } from "../../src/storage/download.js";

describe("buildDownloadBlob", () => {
  test("wraps a string and applies the given mime type", async () => {
    const blob = buildDownloadBlob({ content: "hello", mimeType: "text/plain" });
    expect(blob).toBeInstanceOf(Blob);
    // Bun's Blob may normalize to "text/plain;charset=utf-8"
    expect(blob.type.startsWith("text/plain")).toBe(true);
    expect(await blob.text()).toBe("hello");
  });

  test("falls back to octet-stream when mime type is missing", () => {
    const blob = buildDownloadBlob({ content: "x", mimeType: undefined });
    expect(blob.type).toBe("application/octet-stream");
  });

  test("wraps binary bytes (Uint8Array) into a Blob", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const blob = buildDownloadBlob({ content: bytes, mimeType: "image/png" });
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(4);
    const out = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(out)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("passes an existing Blob through unchanged", () => {
    const original = new Blob(["abc"], { type: "text/csv" });
    const blob = buildDownloadBlob({ content: original, mimeType: "text/plain" });
    expect(blob).toBe(original);
    expect(blob.type).toBe("text/csv");
  });
});
