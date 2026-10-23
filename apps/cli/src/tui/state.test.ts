import { describe, expect, test } from "bun:test";
import { initialState, keyFor, reduce } from "./state.js";

const loaded = reduce(initialState, { type: "loaded", count: 3 });

describe("reduce", () => {
  test("moves within the list and clamps at both ends", () => {
    expect(reduce(loaded, { type: "move", by: 1 }).selected).toBe(1);
    expect(reduce(loaded, { type: "move", by: -1 }).selected).toBe(0);
    expect(reduce(loaded, { type: "move", by: 10 }).selected).toBe(2);
    expect(reduce(loaded, { type: "bottom" }).selected).toBe(2);
  });

  test("a reload with fewer issues keeps the selection inside the list", () => {
    const last = reduce(loaded, { type: "bottom" });
    expect(reduce(last, { type: "loaded", count: 1 }).selected).toBe(0);
    expect(reduce(last, { type: "loaded", count: 0 }).selected).toBe(0);
  });

  test("a click selects and focuses the list", () => {
    const inDetail = reduce(loaded, { type: "focus", pane: "detail" });
    expect(reduce(inDetail, { type: "select", index: 2 })).toEqual({ selected: 2, count: 3, pane: "list" });
  });
});

describe("keyFor", () => {
  test("j/k move in the list and scroll in the detail pane", () => {
    expect(keyFor({ name: "j" }, "list")).toEqual({ type: "move", by: 1 });
    expect(keyFor({ name: "j" }, "detail")).toBe("scroll-down");
    expect(keyFor({ name: "up" }, "detail")).toBe("scroll-up");
  });

  test("g and G jump; q and ctrl+c quit", () => {
    expect(keyFor({ name: "g" }, "list")).toEqual({ type: "top" });
    expect(keyFor({ name: "g", shift: true }, "list")).toEqual({ type: "bottom" });
    expect(keyFor({ name: "q" }, "detail")).toBe("quit");
    expect(keyFor({ name: "c", ctrl: true }, "list")).toBe("quit");
  });
});
