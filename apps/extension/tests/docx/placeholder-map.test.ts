/**
 * Placeholder classification + the `$scroll.pageproperty.(…)` argument grammar.
 *
 * The grammar is worth pinning explicitly because it is partly INFERRED. Scroll
 * documents `(key)`, `(key,fallback-enabled)` and
 * `(key,macro-id,true,alternate-text)`, but not how to tell a 2-arg
 * `(key,macroId)` from `(key,fallback)`. We disambiguate on shape: a boolean
 * second argument is the fallback flag, anything else is a macro id. If that
 * ever contradicts real Scroll behaviour, these tests are where it surfaces.
 */
import { describe, expect, it } from "bun:test";
import { classifyPlaceholder, parsePagePropertyArgs } from "../../utils/docx/placeholder-map.js";

describe("parsePagePropertyArgs — documented forms", () => {
  it("(key)", () => {
    expect(parsePagePropertyArgs("$scroll.pageproperty.(Status)")).toEqual({
      key: "Status",
      fallbackEnabled: false,
    });
  });

  it("(key,fallback-enabled) — a boolean 2nd arg is the fallback flag", () => {
    expect(parsePagePropertyArgs("$scroll.pageproperty.(Status,true)")).toEqual({
      key: "Status",
      fallbackEnabled: true,
    });
    expect(parsePagePropertyArgs("$scroll.pageproperty.(Status,false)")).toEqual({
      key: "Status",
      fallbackEnabled: false,
    });
  });

  it("(key,macro-id,true,alternate-text) — the full form", () => {
    expect(parsePagePropertyArgs("$scroll.pageproperty.(Status,specs,true,not set)")).toEqual({
      key: "Status",
      macroId: "specs",
      fallbackEnabled: true,
      alternateText: "not set",
    });
  });

  it("a non-boolean 2nd arg is a macro id, not a fallback flag", () => {
    expect(parsePagePropertyArgs("$scroll.pageproperty.(Status,specs)")).toEqual({
      key: "Status",
      macroId: "specs",
      fallbackEnabled: false,
      alternateText: undefined,
    });
  });

  it("trims whitespace and strips quotes around arguments", () => {
    expect(parsePagePropertyArgs('$scroll.pageproperty.( "Status" , "specs" )')).toEqual({
      key: "Status",
      macroId: "specs",
      fallbackEnabled: false,
      alternateText: undefined,
    });
  });

  it("no argument group / empty group → no key", () => {
    expect(parsePagePropertyArgs("$scroll.pageproperty").key).toBe("");
    expect(parsePagePropertyArgs("$scroll.pageproperty.()").key).toBe("");
  });
});

describe("classifyPlaceholder — pageproperty is lazy per ARGUMENT", () => {
  it("(key) needs nothing — the page's own storage is already in hand", () => {
    const cls = classifyPlaceholder("$scroll.pageproperty.(Status)");
    expect(cls.status).toBe("supported");
    expect(cls.dependency).toBe("none");
  });

  it("(key,true) needs the space homepage", () => {
    expect(classifyPlaceholder("$scroll.pageproperty.(Status,true)").dependency).toBe(
      "spaceHomepage"
    );
  });

  it("the 4-arg form's fallback flag drives the dependency, not the macro id", () => {
    expect(classifyPlaceholder("$scroll.pageproperty.(S,specs,false,x)").dependency).toBe("none");
    expect(classifyPlaceholder("$scroll.pageproperty.(S,specs,true,x)").dependency).toBe(
      "spaceHomepage"
    );
  });
});

describe("classifyPlaceholder — $adhocState is dropped but still handled", () => {
  it("classifies as unsupported so it is blanked rather than left literal", () => {
    const cls = classifyPlaceholder("$adhocState");
    // NOT "never": the curated Comala entry was removed on purpose. What must
    // NOT happen is it becoming unknown to the resolver — then the raw token
    // would survive into the exported document.
    expect(cls.status).toBe("unsupported");
    expect(cls.base).toBe("$adhocState");
    expect(cls.reason).toBeDefined();
  });
});
