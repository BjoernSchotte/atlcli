/**
 * Pure scope-form state machine (spec 010 T5.1, Architecture point 1).
 *
 * `reduceScope(state, event)` is a pure `(state, event) => state` transition
 * with no DOM, no React, no `chrome.*`, no IO — mirroring `utils/panel-state.ts`
 * so the scope form is exhaustively testable without a panel, and so a second
 * host (the Forge dialog) can reuse the exact same reducer. Everything
 * host-specific (the current page id, the space key) is passed in as a
 * {@link ScopeContext} at *selector* time rather than stored in the state, which
 * is what keeps the state serializable and host-neutral.
 *
 * The selectors are the contract with the engine: `toExportScope` and
 * `toLabelFilter` produce the *shared* `ExportScope` / `LabelFilter` values from
 * `@atlcli/confluence` — the same objects the CLI builds from its flags — and
 * reuse the shared `validateExportScope` / `normalizeLabelFilter` rather than
 * growing a panel-only dialect of the same rules (hard rule: no extension-only
 * engine logic).
 *
 * The reducer is identity-preserving: a no-op event returns the *same* state
 * object, so a React host can bail out of a re-render cheaply.
 */
import {
  normalizeLabelFilter,
  validateExportScope,
  type ExportScope,
  type LabelFilter,
} from "@atlcli/confluence/browser";

/** What the user picked in the scope radio. */
export type ScopeKind = "page" | "tree" | "space";

/** Which of the two label chip lists an event addresses. */
export type LabelField = "include" | "exclude";

/** `LabelFilter.excludeMode`, without the optionality. */
export type LabelExcludeMode = NonNullable<LabelFilter["excludeMode"]>;

/**
 * Depth bounds for the `tree` scope. `maxDepth` counts levels *below* the root
 * (root = 0 in `ExportScope`), so the minimum useful value for a UI that calls
 * this "Page + children" is 1 — depth 0 would silently export the root alone
 * (or, with `includeRoot: false`, nothing at all). The ceiling is a guardrail,
 * not a Confluence limit: real handbooks nest ~3–5 deep, and an unbounded depth
 * box is a footgun in a form whose other end is a whole-space export.
 */
export const SCOPE_MIN_DEPTH = 1;
export const SCOPE_MAX_DEPTH = 10;
export const SCOPE_DEFAULT_DEPTH = 5;

/** Serializable scope-form state. No host handles, no DOM nodes. */
export interface ScopeState {
  kind: ScopeKind;
  /** Only meaningful for `kind: "tree"`; kept across kind switches so toggling back restores the user's pick. */
  maxDepth: number;
  /** Only meaningful for `kind: "tree"`; whether the root page itself becomes a chapter. */
  includeRoot: boolean;
  /** Normalized include chips (OR semantics), in the order the user added them. */
  includeLabels: string[];
  /** Normalized exclude chips (OR semantics), in the order the user added them. */
  excludeLabels: string[];
  /** `"prune-subtree"` (default) takes an excluded page's children with it. */
  excludeMode: LabelExcludeMode;
}

/** Host facts the selectors need; supplied per call, never stored in state. */
export interface ScopeContext {
  /** The currently loaded page (`LoadedPage.details.id`). */
  pageId: string;
  /** The loaded page's space (`LoadedPage.details.spaceKey`), when known. */
  spaceKey?: string;
}

/** Events the scope form folds into the state. */
export type ScopeEvent =
  | { type: "set-kind"; kind: ScopeKind }
  | { type: "set-max-depth"; depth: number }
  | { type: "set-include-root"; includeRoot: boolean }
  | { type: "set-exclude-mode"; mode: LabelExcludeMode }
  /** Commit raw chip-input text (Enter / comma / blur): parsed, appended, deduped. */
  | { type: "add-labels"; field: LabelField; input: string }
  /** Replace a whole list from raw text (a plain comma-separated text field). */
  | { type: "set-labels"; field: LabelField; input: string }
  | { type: "remove-label"; field: LabelField; label: string }
  | { type: "clear-labels"; field: LabelField }
  | { type: "reset" };

/** The starting state: today's behavior (single page, no filters). */
export const initialScopeState: ScopeState = {
  kind: "page",
  maxDepth: SCOPE_DEFAULT_DEPTH,
  includeRoot: true,
  includeLabels: [],
  excludeLabels: [],
  excludeMode: "prune-subtree",
};

/**
 * Parse raw label input into normalized labels.
 *
 * Splits on commas *and* whitespace: Confluence labels contain neither, so
 * pasting `"internal, draft"` or `"internal draft"` both do the obvious thing.
 * Trims, drops empties, and de-duplicates **case-sensitively** — matching
 * `normalizeLabelFilter` in `@atlcli/confluence`, which documents Confluence
 * labels as case-sensitive. Order of first appearance is preserved (the chips
 * must not reshuffle while the user types). Pure.
 */
export function parseLabelInput(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of String(raw ?? "").split(/[,\s]+/)) {
    const label = token.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/** Clamp a depth into the supported range; non-finite input keeps `fallback`. */
export function clampDepth(depth: number, fallback: number = SCOPE_DEFAULT_DEPTH): number {
  if (typeof depth !== "number" || !Number.isFinite(depth)) return fallback;
  const whole = Math.floor(depth);
  if (whole < SCOPE_MIN_DEPTH) return SCOPE_MIN_DEPTH;
  if (whole > SCOPE_MAX_DEPTH) return SCOPE_MAX_DEPTH;
  return whole;
}

const labelsKey = (field: LabelField): "includeLabels" | "excludeLabels" =>
  field === "include" ? "includeLabels" : "excludeLabels";

/** True when two label lists are element-wise equal (identity-preserving guard). */
function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Return `state` unchanged when the new list is equivalent, else a new state. */
function withLabels(state: ScopeState, field: LabelField, next: string[]): ScopeState {
  const key = labelsKey(field);
  if (sameLabels(state[key], next)) return state;
  return { ...state, [key]: next };
}

/** Pure transition. Never throws. */
export function reduceScope(state: ScopeState, event: ScopeEvent): ScopeState {
  switch (event.type) {
    case "set-kind":
      // Depth / include-root / labels deliberately survive a kind switch: a user
      // who configures a tree, peeks at "current page", and switches back must
      // not silently lose their settings. The selectors decide what applies.
      return state.kind === event.kind ? state : { ...state, kind: event.kind };

    case "set-max-depth": {
      const depth = clampDepth(event.depth, state.maxDepth);
      return depth === state.maxDepth ? state : { ...state, maxDepth: depth };
    }

    case "set-include-root":
      return state.includeRoot === event.includeRoot
        ? state
        : { ...state, includeRoot: event.includeRoot };

    case "set-exclude-mode":
      return state.excludeMode === event.mode ? state : { ...state, excludeMode: event.mode };

    case "add-labels": {
      const current = state[labelsKey(event.field)];
      const additions = parseLabelInput(event.input).filter((l) => !current.includes(l));
      if (additions.length === 0) return state;
      return withLabels(state, event.field, [...current, ...additions]);
    }

    case "set-labels":
      return withLabels(state, event.field, parseLabelInput(event.input));

    case "remove-label": {
      const current = state[labelsKey(event.field)];
      const next = current.filter((label) => label !== event.label);
      return withLabels(state, event.field, next);
    }

    case "clear-labels":
      return withLabels(state, event.field, []);

    case "reset":
      return initialScopeState;

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * True when the "Entire space" option is selectable — the loaded page must
 * report a space key, otherwise there is nothing to resolve a homepage from.
 * The panel disables the radio on `false`; `toExportScope` throws on it.
 */
export function canUseSpaceScope(context: ScopeContext): boolean {
  return typeof context.spaceKey === "string" && context.spaceKey.trim().length > 0;
}

/**
 * Build the shared {@link ExportScope} for the current form state.
 *
 * Runs the value through the shared `validateExportScope`, so a space scope
 * without a space key (or a page scope without a page id) fails with the same
 * `ExportScopeError` the CLI produces rather than a panel-specific message.
 */
export function toExportScope(state: ScopeState, context: ScopeContext): ExportScope {
  switch (state.kind) {
    case "page":
      return validateExportScope({ kind: "page", pageId: context.pageId });
    case "tree":
      return validateExportScope({
        kind: "tree",
        rootPageId: context.pageId,
        includeRoot: state.includeRoot,
        maxDepth: clampDepth(state.maxDepth),
      });
    case "space":
      return validateExportScope({ kind: "space", spaceKey: context.spaceKey ?? "" });
    default: {
      const _exhaustive: never = state.kind;
      return _exhaustive;
    }
  }
}

/**
 * Build the shared {@link LabelFilter}, or `undefined` when no chip is set.
 *
 * Delegates to `normalizeLabelFilter`, so "no filter" and "an all-empty filter"
 * collapse to the same value the CLI would produce — including the
 * `excludeMode` default of `"prune-subtree"`.
 */
export function toLabelFilter(state: ScopeState): LabelFilter | undefined {
  return normalizeLabelFilter({
    include: state.includeLabels,
    exclude: state.excludeLabels,
    excludeMode: state.excludeMode,
  });
}

/**
 * A canonical discriminator for a scope + label filter.
 *
 * Exists because `utils/pdf/run-export.ts` keys its compile cache on
 * `sourceIdentity` (today `pageUrl|id|version`): a tree or space export of the
 * same root page produces *different bytes* from a single-page export and must
 * therefore never collide with it. `run-export.ts` receives `ExportScope` +
 * `LabelFilter` (not the form state), so this is the overload it composes into
 * `sourceIdentity`; {@link scopeIdentity} is the same function for a UI that
 * still holds the reducer state, and the two agree by construction.
 *
 * Total and side-effect free. Labels are sorted (OR semantics — the order the
 * user typed them in cannot change the output) and percent-encoded, so the
 * mapping from filter to identity is injective. An unbounded tree depth
 * stringifies to `d*`, distinct from every concrete depth.
 */
export function exportScopeIdentity(scope: ExportScope, labels?: LabelFilter): string {
  const enc = encodeURIComponent;
  let head: string;
  switch (scope.kind) {
    case "page":
      head = `page|${enc(scope.pageId)}`;
      break;
    case "tree":
      head =
        `tree|${enc(scope.rootPageId)}` +
        `|d${scope.maxDepth ?? "*"}|root:${(scope.includeRoot ?? true) ? 1 : 0}`;
      break;
    case "space":
      head = `space|${enc(scope.spaceKey)}`;
      break;
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }

  const filter = normalizeLabelFilter(labels);
  if (!filter) return `${head}|labels:none`;
  const list = (values: string[] | undefined): string =>
    (values ?? []).slice().sort().map(enc).join(",");
  return (
    `${head}|inc:${list(filter.include)}|exc:${list(filter.exclude)}` +
    `|mode:${filter.excludeMode ?? "prune-subtree"}`
  );
}

/**
 * {@link exportScopeIdentity} for the current form state.
 *
 * Safe to call during render, unlike {@link toExportScope}: an unselectable
 * space scope stringifies to an empty space key rather than throwing.
 */
export function scopeIdentity(state: ScopeState, context: ScopeContext): string {
  const scope: ExportScope =
    state.kind === "page"
      ? { kind: "page", pageId: context.pageId }
      : state.kind === "tree"
        ? {
            kind: "tree",
            rootPageId: context.pageId,
            includeRoot: state.includeRoot,
            maxDepth: clampDepth(state.maxDepth),
          }
        : { kind: "space", spaceKey: context.spaceKey ?? "" };
  return exportScopeIdentity(scope, toLabelFilter(state));
}
