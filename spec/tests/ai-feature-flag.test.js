import { test, expect, describe } from "bun:test";
import { isAiEnabled, AI_ENABLED } from "../../src/ai/feature-flags.js";

describe("isAiEnabled", () => {
  test("AI is enabled via the authenticated proxy", () => {
    expect(AI_ENABLED).toBe(true);
    expect(isAiEnabled()).toBe(true);
  });
  test("returns a strict boolean", () => {
    expect(typeof isAiEnabled()).toBe("boolean");
  });
});
