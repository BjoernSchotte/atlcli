import { describe, expect, test } from "bun:test";
import { createRegistry } from "./registry.js";
import type { MacroRenderer } from "./types.js";

function stub(id: string, macros: string[]): MacroRenderer {
  return {
    id,
    macros,
    requiresLivePort: false,
    async render() {
      return { kind: "skip" };
    },
  };
}

describe("createRegistry invariants", () => {
  test("duplicate non-catch-all macro name across two renderers throws", () => {
    expect(() => createRegistry([stub("a", ["jira"]), stub("b", ["jira"])])).toThrow(
      /both "a" and "b" claim macro "jira"/
    );
  });

  test("case-insensitive duplicate detection", () => {
    expect(() => createRegistry([stub("a", ["Jira"]), stub("b", ["jira"])])).toThrow(/claim macro "jira"/);
  });

  test("more than one catch-all throws", () => {
    expect(() => createRegistry([stub("a", ["*"]), stub("b", ["*"])])).toThrow(/catch-all/);
  });

  test("one catch-all plus distinct renderers is valid", () => {
    const r = createRegistry([stub("toc", ["toc"]), stub("jira", ["jira"]), stub("ev", ["*"])]);
    expect(r.renderers.length).toBe(3);
  });

  test("introspection gives a stable, complete supported-macros list", () => {
    const r = createRegistry([stub("toc", ["toc"]), stub("jira", ["jira", "jiraissues"]), stub("ev", ["*"])]);
    const supported = r.renderers.flatMap((x) => x.macros);
    expect(supported).toEqual(["toc", "jira", "jiraissues", "*"]);
  });
});

describe("compose", () => {
  test("places overrides before built-ins and shadows a built-in", () => {
    const base = createRegistry([stub("jira", ["jira"]), stub("ev", ["*"])]);
    const custom = stub("custom-jira", ["jira"]);
    const composed = base.compose(custom);
    expect(composed.renderers[0].id).toBe("custom-jira");
    // The built-in jira renderer is still present but comes after the override.
    expect(composed.renderers.map((r) => r.id)).toEqual(["custom-jira", "jira", "ev"]);
  });

  test("override may supply a new catch-all, dropping the built-in one", () => {
    const base = createRegistry([stub("jira", ["jira"]), stub("ev", ["*"])]);
    const composed = base.compose(stub("custom-ev", ["*"]));
    const catchAlls = composed.renderers.filter((r) => r.macros.includes("*"));
    expect(catchAlls.length).toBe(1);
    expect(catchAlls[0].id).toBe("custom-ev");
  });

  test("two overrides colliding on the same macro still throws", () => {
    const base = createRegistry([stub("ev", ["*"])]);
    expect(() => base.compose(stub("x", ["jira"]), stub("y", ["jira"]))).toThrow(/claim macro "jira"/);
  });

  test("compose is chainable and still validated", () => {
    const base = createRegistry([stub("ev", ["*"])]);
    const composed = base.compose(stub("a", ["toc"])).compose(stub("b", ["jira"]));
    expect(composed.renderers.map((r) => r.id)).toEqual(["b", "a", "ev"]);
  });
});
