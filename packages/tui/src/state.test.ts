import { describe, expect, test } from "bun:test";
import {
  cycleFocus,
  emptyList,
  emptyTree,
  filterItems,
  initialState,
  moveSelection,
  moveTreeSelection,
  setChildren,
  setExpanded,
  toggleMark,
  visibleNodes,
  withItems,
} from "./state.js";

const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `I-${i}` }));

describe("lists", () => {
  test("selection clamps at both ends", () => {
    const list = withItems(emptyList<{ id: string }>(), ids(3), (i) => i.id);
    expect(moveSelection(list, 7).selected).toBe(2);
    expect(moveSelection(list, -3).selected).toBe(0);
  });

  test("a reload keeps the selection on the same item and drops marks of items gone", () => {
    let list = withItems(emptyList<{ id: string }>(), ids(5), (i) => i.id);
    list = toggleMark(moveSelection(list, 3), "I-4");
    const reloaded = withItems(list, [{ id: "I-9" }, { id: "I-3" }], (i) => i.id);
    expect(reloaded.selected).toBe(1);
    expect(reloaded.marked).toEqual([]);
  });

  test("toggleMark adds and removes", () => {
    const list = toggleMark(toggleMark(emptyList(), "A"), "B");
    expect(list.marked).toEqual(["A", "B"]);
    expect(toggleMark(list, "A").marked).toEqual(["B"]);
  });
});

describe("trees", () => {
  const tree = () => {
    let t = setChildren(emptyTree(), undefined, [
      { id: "a", label: "A", kind: "group", expandable: true },
      { id: "b", label: "B", kind: "query", expandable: false },
    ]);
    t = setChildren(t, "a", [{ id: "a1", label: "A1", kind: "board", expandable: false }]);
    return t;
  };

  test("only children of expanded nodes are visible, at depth + 1", () => {
    expect(visibleNodes(tree()).map((n) => n.id)).toEqual(["a", "b"]);
    const open = setExpanded(tree(), "a", true);
    expect(visibleNodes(open).map((n) => `${n.id}:${n.depth}`)).toEqual(["a:0", "a1:1", "b:0"]);
  });

  test("moving walks the visible nodes", () => {
    const open = setExpanded(tree(), "a", true);
    expect(moveTreeSelection(open, 1).selected).toBe("a1");
    expect(moveTreeSelection(open, "bottom").selected).toBe("b");
    expect(moveTreeSelection(setExpanded(open, "a", false), 1).selected).toBe("b");
  });
});

describe("focus and pickers", () => {
  test("tab cycles the visible panes", () => {
    const s = initialState();
    expect(cycleFocus(s, 1).focus).toBe("detail");
    expect(cycleFocus({ ...s, navOpen: false, focus: "detail" }, 1).focus).toBe("list");
    expect(cycleFocus({ ...s, zoom: true, focus: "detail" }, 1)).toEqual({ ...s, zoom: true, focus: "detail" });
  });

  test("filterItems needs every word, in label, hint or id", () => {
    const items = [
      { id: "acc:1", label: "Ann Lee", hint: "ann@example.com" },
      { id: "acc:2", label: "Bob Lee" },
    ];
    expect(filterItems(items, "lee ann").map((i) => i.id)).toEqual(["acc:1"]);
    expect(filterItems(items, "example").map((i) => i.id)).toEqual(["acc:1"]);
    expect(filterItems(items, "")).toHaveLength(2);
  });
});
