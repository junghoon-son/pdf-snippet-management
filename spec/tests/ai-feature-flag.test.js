import { test, expect, describe } from "bun:test";
import { isAiEnabled, AI_ENABLED } from "../../src/ai/feature-flags.js";

describe("isAiEnabled", () => {
  test("AI is disabled in Phase 1", () => {
    expect(AI_ENABLED).toBe(false);
    expect(isAiEnabled()).toBe(false);
  });
  test("returns a strict boolean", () => {
    expect(typeof isAiEnabled()).toBe("boolean");
  });
});
