import { describe, expect, test } from "bun:test";
import { allCommands } from "./app.js";
import { keyString, paletteCommands, resolveCommand } from "./keymap.js";
import { initialState } from "./state.js";

describe("keyString", () => {
  test("printable keys by their character, named keys by name, modifiers as prefixes", () => {
    expect(keyString({ name: "g", sequence: "G", shift: true })).toBe("G");
    expect(keyString({ name: "slash", sequence: "?", shift: true })).toBe("?");
    expect(keyString({ name: "k", sequence: "\u000b", ctrl: true })).toBe("ctrl+k");
    expect(keyString({ name: "tab", sequence: "\t", shift: true })).toBe("shift+tab");
    expect(keyString({ name: "return", sequence: "\r" })).toBe("return");
    expect(keyString({ name: "space", sequence: " " })).toBe("space");
  });
});

describe("resolveCommand", () => {
  const commands = allCommands();

  test("the same key does what the focused pane means", () => {
    const s = initialState();
    expect(resolveCommand(commands, { ...s, focus: "list" }, "j")?.id).toBe("list.down");
    expect(resolveCommand(commands, { ...s, focus: "detail" }, "j")?.id).toBe("detail.down");
    expect(resolveCommand(commands, { ...s, focus: "nav" }, "j")?.id).toBe("nav.down");
    expect(resolveCommand(commands, { ...s, focus: "nav" }, "return")?.id).toBe("nav.open");
  });

  test("Jira commands do not run in the Wiki area", () => {
    const s = initialState("wiki");
    expect(resolveCommand(commands, s, "t")?.id).not.toBe("jira.transition");
  });

  test("the user's keymap replaces a command's keys", () => {
    const s = initialState();
    const keymap = { "jira.transition": ["T"] };
    expect(resolveCommand(commands, s, "t", keymap)?.id).not.toBe("jira.transition");
    expect(resolveCommand(commands, s, "T", keymap)?.id).toBe("jira.transition");
  });

  test("the palette finds commands by words of their title, regardless of the pane", () => {
    const found = paletteCommands(commands, { ...initialState(), focus: "nav" }, "move sprint").map((c) => c.id);
    expect(found).toContain("jira.sprint");
  });

  test("every command id is unique", () => {
    const ids = commands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
