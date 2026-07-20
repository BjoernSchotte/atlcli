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
import {
  classifyPlaceholder,
  parseIncludePageArgs,
  parseLogoArgs,
  parsePagePropertyArgs,
} from "./placeholder-map.js";

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

describe("classifyPlaceholder — .name is supported on Cloud (G2)", () => {
  it("creator/modifier .name need no round-trip (the page carries them)", () => {
    for (const raw of ["$scroll.creator.name", "$scroll.modifier.name"]) {
      const cls = classifyPlaceholder(raw);
      expect(cls.status).toBe("supported");
      expect(cls.dependency).toBe("none");
    }
  });

  it("exporter.name needs the current user, like the other exporter fields", () => {
    const cls = classifyPlaceholder("$scroll.exporter.name");
    expect(cls.status).toBe("supported");
    expect(cls.dependency).toBe("currentUser");
  });
});

describe("classifyPlaceholder — logo placeholders are supported (G3, spec 005)", () => {
  it("spacelogo and globallogo classify as supported with the spaceLogo dependency", () => {
    for (const raw of ["$scroll.spacelogo", "$scroll.globallogo", "$scroll.spacelogo.(50,120)"]) {
      const cls = classifyPlaceholder(raw);
      expect(cls.status).toBe("supported");
      expect(cls.dependency).toBe("spaceLogo");
    }
  });
});

describe("parseLogoArgs — the .(H,W) size grammar (height first)", () => {
  it("parses height-only and height+width forms", () => {
    expect(parseLogoArgs("$scroll.spacelogo")).toEqual({ heightPx: undefined, widthPx: undefined });
    expect(parseLogoArgs("$scroll.spacelogo.(50)")).toEqual({ heightPx: 50, widthPx: undefined });
    expect(parseLogoArgs("$scroll.spacelogo.(50, 120)")).toEqual({ heightPx: 50, widthPx: 120 });
  });

  it("ignores non-numeric or non-positive arguments (intrinsic size wins)", () => {
    expect(parseLogoArgs("$scroll.spacelogo.(auto,120)")).toEqual({
      heightPx: undefined,
      widthPx: 120,
    });
    expect(parseLogoArgs("$scroll.spacelogo.(0,-5)")).toEqual({
      heightPx: undefined,
      widthPx: undefined,
    });
  });
});

describe("classifyPlaceholder — includepage is supported (spec 005 D1)", () => {
  it("classifies the base and every argument form as supported/includePage", () => {
    for (const raw of [
      "$scroll.includepage",
      "$scroll.includepage.(Imprint)",
      "$scroll.includepage.(ENG:Imprint)",
      "$scroll.includepage.(123456)",
    ]) {
      const cls = classifyPlaceholder(raw);
      expect(cls.status).toBe("supported");
      expect(cls.dependency).toBe("includePage");
      expect(cls.base).toBe("$scroll.includepage");
    }
  });
});

describe("classifyPlaceholder — metadata reclassified never → unsupported (spec 005 D2)", () => {
  it("is unsupported with the remedy-stating reason", () => {
    for (const raw of ["$scroll.metadata", "$scroll.metadata.(docNumber)"]) {
      const cls = classifyPlaceholder(raw);
      expect(cls.status).toBe("unsupported");
      expect(cls.reason).toContain("content property");
    }
  });

  it("keeps the Scroll Documents neighbor $scroll.custom.* as never (pin)", () => {
    expect(classifyPlaceholder("$scroll.custom.field").status).toBe("never");
  });
});

describe("parseIncludePageArgs — the include grammar", () => {
  it("parses each documented argument form", () => {
    expect(parseIncludePageArgs("$scroll.includepage.(Imprint)")).toEqual({ title: "Imprint" });
    expect(parseIncludePageArgs("$scroll.includepage.(ENG:Imprint)")).toEqual({
      spaceKey: "ENG",
      title: "Imprint",
    });
    // First-colon split: the title itself may contain colons.
    expect(parseIncludePageArgs("$scroll.includepage.(DOCSY:A: colon title)")).toEqual({
      spaceKey: "DOCSY",
      title: "A: colon title",
    });
    expect(parseIncludePageArgs("$scroll.includepage.(123456)")).toEqual({ pageId: "123456" });
    // Quote-wrapped title is colon-safe (never split into space:title).
    expect(parseIncludePageArgs('$scroll.includepage.( "Quoted: Title" )')).toEqual({
      title: "Quoted: Title",
    });
  });

  it("returns null for an empty, missing, or half-blank argument group", () => {
    expect(parseIncludePageArgs("$scroll.includepage")).toBeNull();
    expect(parseIncludePageArgs("$scroll.includepage.()")).toBeNull();
    expect(parseIncludePageArgs("$scroll.includepage.(  )")).toBeNull();
    expect(parseIncludePageArgs("$scroll.includepage.(ENG:)")).toBeNull();
    expect(parseIncludePageArgs("$scroll.includepage.(:Imprint)")).toBeNull();
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
