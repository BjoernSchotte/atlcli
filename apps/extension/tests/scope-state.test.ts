import { describe, expect, it } from "bun:test";
import { ExportScopeError, normalizeLabelFilter } from "@atlcli/confluence/browser";
import {
  canUseSpaceScope,
  clampDepth,
  exportScopeIdentity,
  initialScopeState,
  parseLabelInput,
  reduceScope,
  SCOPE_DEFAULT_DEPTH,
  SCOPE_MAX_DEPTH,
  SCOPE_MIN_DEPTH,
  scopeIdentity,
  toExportScope,
  toLabelFilter,
  type ScopeContext,
  type ScopeEvent,
  type ScopeState,
} from "../utils/scope-state.js";

const ctx: ScopeContext = { pageId: "123", spaceKey: "DOCSY" };

/** Fold a list of events onto a starting state. */
const fold = (events: ScopeEvent[], start: ScopeState = initialScopeState): ScopeState =>
  events.reduce(reduceScope, start);

describe("initial scope state", () => {
  it("defaults to today's behavior: a single page, no filters", () => {
    expect(initialScopeState.kind).toBe("page");
    expect(initialScopeState.includeLabels).toEqual([]);
    expect(initialScopeState.excludeLabels).toEqual([]);
    expect(initialScopeState.includeRoot).toBe(true);
    expect(initialScopeState.maxDepth).toBe(SCOPE_DEFAULT_DEPTH);
  });

  it("defaults excludeMode to prune-subtree (excluded pages take their children)", () => {
    expect(initialScopeState.excludeMode).toBe("prune-subtree");
    // …and the same default survives into the engine-facing filter.
    const state = reduceScope(initialScopeState, {
      type: "add-labels",
      field: "exclude",
      input: "internal",
    });
    expect(toLabelFilter(state)?.excludeMode).toBe("prune-subtree");
  });
});

describe("kind transitions", () => {
  it("moves between page / tree / space", () => {
    expect(fold([{ type: "set-kind", kind: "tree" }]).kind).toBe("tree");
    expect(
      fold([
        { type: "set-kind", kind: "tree" },
        { type: "set-kind", kind: "space" },
      ]).kind
    ).toBe("space");
  });

  it("keeps depth, include-root and labels across a kind round-trip", () => {
    const configured = fold([
      { type: "set-kind", kind: "tree" },
      { type: "set-max-depth", depth: 3 },
      { type: "set-include-root", includeRoot: false },
      { type: "add-labels", field: "exclude", input: "internal" },
    ]);
    const roundTripped = fold(
      [
        { type: "set-kind", kind: "page" },
        { type: "set-kind", kind: "tree" },
      ],
      configured
    );
    expect(roundTripped.maxDepth).toBe(3);
    expect(roundTripped.includeRoot).toBe(false);
    expect(roundTripped.excludeLabels).toEqual(["internal"]);
  });

  it("is identity-preserving for a no-op transition", () => {
    expect(reduceScope(initialScopeState, { type: "set-kind", kind: "page" })).toBe(
      initialScopeState
    );
    expect(
      reduceScope(initialScopeState, { type: "set-include-root", includeRoot: true })
    ).toBe(initialScopeState);
    expect(reduceScope(initialScopeState, { type: "clear-labels", field: "include" })).toBe(
      initialScopeState
    );
  });

  it("resets to the initial state", () => {
    const dirty = fold([
      { type: "set-kind", kind: "space" },
      { type: "add-labels", field: "include", input: "handbook" },
    ]);
    expect(reduceScope(dirty, { type: "reset" })).toEqual(initialScopeState);
  });
});

describe("depth bounds", () => {
  it("clamps below the minimum and above the maximum", () => {
    expect(fold([{ type: "set-max-depth", depth: 0 }]).maxDepth).toBe(SCOPE_MIN_DEPTH);
    expect(fold([{ type: "set-max-depth", depth: -7 }]).maxDepth).toBe(SCOPE_MIN_DEPTH);
    expect(fold([{ type: "set-max-depth", depth: 999 }]).maxDepth).toBe(SCOPE_MAX_DEPTH);
  });

  it("floors fractional depths to an integer (ExportScope requires one)", () => {
    expect(fold([{ type: "set-max-depth", depth: 3.7 }]).maxDepth).toBe(3);
  });

  it("keeps the current depth for a non-numeric input (empty number field)", () => {
    const start = fold([{ type: "set-max-depth", depth: 4 }]);
    expect(reduceScope(start, { type: "set-max-depth", depth: Number.NaN })).toBe(start);
    expect(
      reduceScope(start, { type: "set-max-depth", depth: Number.POSITIVE_INFINITY })
    ).toBe(start);
  });

  it("clampDepth falls back explicitly", () => {
    expect(clampDepth(Number.NaN, 2)).toBe(2);
    expect(clampDepth(Number.NaN)).toBe(SCOPE_DEFAULT_DEPTH);
  });

  it("emits a valid maxDepth into the ExportScope", () => {
    const state = fold([
      { type: "set-kind", kind: "tree" },
      { type: "set-max-depth", depth: 99 },
    ]);
    const scope = toExportScope(state, ctx);
    expect(scope).toEqual({
      kind: "tree",
      rootPageId: "123",
      includeRoot: true,
      maxDepth: SCOPE_MAX_DEPTH,
    });
  });
});

describe("label parsing, normalization and dedupe", () => {
  it("splits on commas and whitespace, trims, drops empties, dedupes", () => {
    expect(parseLabelInput(" internal, draft ,, internal,  archive ")).toEqual([
      "internal",
      "draft",
      "archive",
    ]);
    expect(parseLabelInput("internal draft")).toEqual(["internal", "draft"]);
    expect(parseLabelInput("   ")).toEqual([]);
  });

  it("dedupes case-sensitively, matching @atlcli/confluence label semantics", () => {
    expect(parseLabelInput("Internal, internal")).toEqual(["Internal", "internal"]);
  });

  it("appends without re-adding an existing chip", () => {
    const state = fold([
      { type: "add-labels", field: "include", input: "handbook, public" },
      { type: "add-labels", field: "include", input: "public, released" },
    ]);
    expect(state.includeLabels).toEqual(["handbook", "public", "released"]);
  });

  it("is identity-preserving when every added label is already present", () => {
    const start = fold([{ type: "add-labels", field: "include", input: "handbook" }]);
    expect(reduceScope(start, { type: "add-labels", field: "include", input: "handbook" })).toBe(
      start
    );
  });

  it("replaces a whole list via set-labels", () => {
    const state = fold([
      { type: "add-labels", field: "exclude", input: "a, b" },
      { type: "set-labels", field: "exclude", input: "c" },
    ]);
    expect(state.excludeLabels).toEqual(["c"]);
  });

  it("removes and clears chips per field, leaving the other field alone", () => {
    const start = fold([
      { type: "add-labels", field: "include", input: "a, b" },
      { type: "add-labels", field: "exclude", input: "x, y" },
    ]);
    const removed = reduceScope(start, { type: "remove-label", field: "include", label: "a" });
    expect(removed.includeLabels).toEqual(["b"]);
    expect(removed.excludeLabels).toEqual(["x", "y"]);
    const cleared = reduceScope(removed, { type: "clear-labels", field: "exclude" });
    expect(cleared.excludeLabels).toEqual([]);
    expect(cleared.includeLabels).toEqual(["b"]);
  });
});

describe("toLabelFilter", () => {
  it("is undefined when no chip is set (no filter == empty filter)", () => {
    expect(toLabelFilter(initialScopeState)).toBeUndefined();
  });

  it("produces exactly what the shared normalizer produces", () => {
    const state = fold([
      { type: "add-labels", field: "include", input: "handbook" },
      { type: "add-labels", field: "exclude", input: "internal, draft" },
      { type: "set-exclude-mode", mode: "page-only" },
    ]);
    expect(toLabelFilter(state)).toEqual(
      normalizeLabelFilter({
        include: ["handbook"],
        exclude: ["internal", "draft"],
        excludeMode: "page-only",
      })
    );
  });

  it("carries excludeMode even when only include labels are set", () => {
    const state = fold([{ type: "add-labels", field: "include", input: "handbook" }]);
    expect(toLabelFilter(state)).toEqual({
      include: ["handbook"],
      excludeMode: "prune-subtree",
    });
  });
});

describe("toExportScope", () => {
  it("maps each kind onto the shared ExportScope shape", () => {
    expect(toExportScope(initialScopeState, ctx)).toEqual({ kind: "page", pageId: "123" });
    expect(toExportScope(fold([{ type: "set-kind", kind: "space" }]), ctx)).toEqual({
      kind: "space",
      spaceKey: "DOCSY",
    });
  });

  it("threads include-root into the tree scope", () => {
    const state = fold([
      { type: "set-kind", kind: "tree" },
      { type: "set-include-root", includeRoot: false },
      { type: "set-max-depth", depth: 2 },
    ]);
    expect(toExportScope(state, ctx)).toEqual({
      kind: "tree",
      rootPageId: "123",
      includeRoot: false,
      maxDepth: 2,
    });
  });

  it("fails with the shared ExportScopeError when a space scope has no space key", () => {
    const state = fold([{ type: "set-kind", kind: "space" }]);
    expect(() => toExportScope(state, { pageId: "123" })).toThrow(ExportScopeError);
  });

  it("canUseSpaceScope gates the radio on a usable space key", () => {
    expect(canUseSpaceScope(ctx)).toBe(true);
    expect(canUseSpaceScope({ pageId: "123" })).toBe(false);
    expect(canUseSpaceScope({ pageId: "123", spaceKey: "  " })).toBe(false);
  });
});

describe("scopeIdentity (cache discrimination)", () => {
  it("distinguishes a tree export from a single-page export of the same page", () => {
    const page = scopeIdentity(initialScopeState, ctx);
    const tree = scopeIdentity(fold([{ type: "set-kind", kind: "tree" }]), ctx);
    const space = scopeIdentity(fold([{ type: "set-kind", kind: "space" }]), ctx);
    expect(new Set([page, tree, space]).size).toBe(3);
  });

  it("changes when depth, include-root or the label filter changes", () => {
    const base = fold([{ type: "set-kind", kind: "tree" }]);
    const identities = [
      scopeIdentity(base, ctx),
      scopeIdentity(reduceScope(base, { type: "set-max-depth", depth: 2 }), ctx),
      scopeIdentity(reduceScope(base, { type: "set-include-root", includeRoot: false }), ctx),
      scopeIdentity(
        reduceScope(base, { type: "add-labels", field: "exclude", input: "internal" }),
        ctx
      ),
      scopeIdentity(
        reduceScope(base, { type: "add-labels", field: "include", input: "internal" }),
        ctx
      ),
      scopeIdentity(
        reduceScope(
          reduceScope(base, { type: "add-labels", field: "exclude", input: "internal" }),
          { type: "set-exclude-mode", mode: "page-only" }
        ),
        ctx
      ),
    ];
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("is stable under label input order (OR semantics cannot depend on it)", () => {
    const a = fold([{ type: "add-labels", field: "exclude", input: "internal, draft" }]);
    const b = fold([{ type: "add-labels", field: "exclude", input: "draft, internal" }]);
    expect(scopeIdentity(a, ctx)).toBe(scopeIdentity(b, ctx));
  });

  it("does not collide across labels containing the separators", () => {
    const a = fold([{ type: "set-labels", field: "include", input: "a%2Cb" }]);
    const b = fold([{ type: "add-labels", field: "include", input: "a, b" }]);
    expect(scopeIdentity(a, ctx)).not.toBe(scopeIdentity(b, ctx));
  });

  it("is total for an unselectable space scope (safe to call during render)", () => {
    const state = fold([{ type: "set-kind", kind: "space" }]);
    expect(() => scopeIdentity(state, { pageId: "123" })).not.toThrow();
  });

  it("agrees with the ExportScope overload run-export.ts uses", () => {
    // run-export.ts holds `scope` + `labels`, not the form state — both entry
    // points must produce the same cache key for the same export.
    const state = fold([
      { type: "set-kind", kind: "tree" },
      { type: "set-max-depth", depth: 2 },
      { type: "set-include-root", includeRoot: false },
      { type: "add-labels", field: "exclude", input: "internal" },
    ]);
    expect(exportScopeIdentity(toExportScope(state, ctx), toLabelFilter(state))).toBe(
      scopeIdentity(state, ctx)
    );

    const plain = fold([{ type: "set-kind", kind: "space" }]);
    expect(exportScopeIdentity(toExportScope(plain, ctx), toLabelFilter(plain))).toBe(
      scopeIdentity(plain, ctx)
    );
  });

  it("distinguishes an unbounded tree depth from every concrete depth", () => {
    const unbounded = exportScopeIdentity({ kind: "tree", rootPageId: "123" });
    const bounded = exportScopeIdentity({ kind: "tree", rootPageId: "123", maxDepth: 5 });
    expect(unbounded).not.toBe(bounded);
    // includeRoot defaults to true in ExportScope — the identity must agree.
    expect(exportScopeIdentity({ kind: "tree", rootPageId: "123", includeRoot: true })).toBe(
      unbounded
    );
  });
});
