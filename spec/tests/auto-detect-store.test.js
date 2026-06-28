import { test, expect, describe } from "bun:test";
import { pickStore } from "../../src/storage/store.js";

describe("pickStore precedence", () => {
  test("Tauri wins over everything", () => {
    expect(pickStore({ isTauri: true, hasOpfs: true, hasFsa: true })).toBe("tauri");
  });
  test("on web, OPFS is preferred over FSA", () => {
    expect(pickStore({ isTauri: false, hasOpfs: true, hasFsa: true })).toBe("opfs");
  });
  test("FSA is used only when OPFS is absent", () => {
    expect(pickStore({ isTauri: false, hasOpfs: false, hasFsa: true })).toBe("fsa");
  });
  test("OPFS works even without FSA (Safari/Firefox)", () => {
    expect(pickStore({ isTauri: false, hasOpfs: true, hasFsa: false })).toBe("opfs");
  });
  test("no backend -> null", () => {
    expect(pickStore({ isTauri: false, hasOpfs: false, hasFsa: false })).toBeNull();
  });
});
