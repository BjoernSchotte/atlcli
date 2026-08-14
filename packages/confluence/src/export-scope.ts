/**
 * Export scope + label filter model (spec 002, Cluster A).
 *
 * Deliberately serializable: CLI flags, extension URL/panel state and library
 * callers all construct the *same* `ExportScope`/`LabelFilter` object, so the
 * orchestration layer (`tree-fetch.ts`) has one input shape regardless of host.
 * Pure types + small validators, no IO.
 */

/**
 * What to export.
 *
 * - `page`  — a single page (today's default).
 * - `tree`  — a page and its descendants. `includeRoot` (default `true`)
 *   controls whether the root page itself becomes a chapter; `maxDepth` caps
 *   traversal depth (root = depth 0).
 * - `space` — a whole space; resolves to the space homepage and delegates to
 *   the `tree` walk with the homepage as the included root.
 */
export type ExportScope =
  | { kind: "page"; pageId: string }
  | { kind: "tree"; rootPageId: string; includeRoot?: boolean; maxDepth?: number }
  | { kind: "space"; spaceKey: string; maxDepth?: number };

/**
 * Label-based pruning, applied after the ordering walk and before body fetch.
 *
 * - `include` — OR semantics: a page is kept when it carries *any* include
 *   label. Acts page-only (a child of a non-included page may still stay).
 * - `exclude` — OR semantics: a page carrying *any* exclude label is removed.
 * - `excludeMode` — `"prune-subtree"` (default) removes an excluded node *and*
 *   its descendants before they are ever fetched (cost + privacy); `"page-only"`
 *   removes just the node and reparents its surviving children.
 */
export interface LabelFilter {
  include?: string[];
  exclude?: string[];
  excludeMode?: "prune-subtree" | "page-only";
}

/** Error thrown when a scope or filter is structurally invalid. */
export class ExportScopeError extends Error {
  readonly code = "export-scope-invalid" as const;
  constructor(message: string) {
    super(message);
    this.name = "ExportScopeError";
  }
}

/** True when the value is a non-empty, non-whitespace string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate an {@link ExportScope}. Pure — throws {@link ExportScopeError} on a
 * structurally invalid scope, returns the (unchanged) scope otherwise so it can
 * be used inline: `const s = validateExportScope(scope)`.
 */
export function validateExportScope(scope: ExportScope): ExportScope {
  switch (scope.kind) {
    case "page":
      if (!isNonEmptyString(scope.pageId)) {
        throw new ExportScopeError("A page scope requires a non-empty pageId.");
      }
      return scope;
    case "tree":
      if (!isNonEmptyString(scope.rootPageId)) {
        throw new ExportScopeError("A tree scope requires a non-empty rootPageId.");
      }
      if (scope.maxDepth !== undefined) {
        if (!Number.isInteger(scope.maxDepth) || scope.maxDepth < 0) {
          throw new ExportScopeError(
            `A tree scope maxDepth must be a non-negative integer (got ${scope.maxDepth}).`
          );
        }
      }
      return scope;
    case "space":
      if (!isNonEmptyString(scope.spaceKey)) {
        throw new ExportScopeError("A space scope requires a non-empty spaceKey.");
      }
      if (scope.maxDepth !== undefined) {
        if (!Number.isInteger(scope.maxDepth) || scope.maxDepth < 0) {
          throw new ExportScopeError(
            `A space scope maxDepth must be a non-negative integer (got ${scope.maxDepth}).`
          );
        }
      }
      return scope;
    default: {
      const exhaustive: never = scope;
      throw new ExportScopeError(
        `Unknown export scope kind: ${JSON.stringify(exhaustive)}`
      );
    }
  }
}

/**
 * Normalize a {@link LabelFilter}: trim entries, drop empties, de-duplicate
 * (case-sensitively — Confluence labels are case-sensitive). Returns `undefined`
 * when the filter carries no effective include/exclude labels, so callers can
 * treat "no filter" and "an all-empty filter" identically. Pure.
 */
export function normalizeLabelFilter(
  filter: LabelFilter | undefined
): LabelFilter | undefined {
  if (!filter) return undefined;
  const clean = (list: string[] | undefined): string[] | undefined => {
    if (!list) return undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of list) {
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out.length > 0 ? out : undefined;
  };
  const include = clean(filter.include);
  const exclude = clean(filter.exclude);
  if (!include && !exclude) return undefined;
  const normalized: LabelFilter = {};
  if (include) normalized.include = include;
  if (exclude) normalized.exclude = exclude;
  normalized.excludeMode = filter.excludeMode ?? "prune-subtree";
  return normalized;
}

/** True when the (normalized) filter actually prunes anything. */
export function hasActiveLabelFilter(filter: LabelFilter | undefined): boolean {
  return normalizeLabelFilter(filter) !== undefined;
}
