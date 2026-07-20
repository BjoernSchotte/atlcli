/**
 * Pure parsing of `atlcli wiki export` scope/label/completeness flags into a
 * host-agnostic {@link ParsedExportRequest} (spec 002, CLI task).
 *
 * This is the ONE flag-construction site. It runs BEFORE any client/network work
 * so the pre-existing "page reference is required" gate no longer blocks the
 * space codepath (`--scope space --space DOCSY ...`), and every invalid flag
 * combination is rejected here with a `USAGE`-shaped {@link ExportRequestError}
 * naming the conflict — never host-dependent or silent behavior.
 *
 * Pure: no IO, no network, no `process`. Fully table-driven testable.
 *
 * Actual `ExportScope` objects are constructed once, later, by
 * {@link buildExportScope} — after the (network) page-ref/homepage resolution
 * the pure layer cannot do. Keeping both here means there is a single place that
 * knows how flags map onto the serializable scope model.
 */
import {
  type CompletenessMode,
  type ExportScope,
  type LabelFilter,
} from "@atlcli/confluence";
import { getFlag, getFlags, hasFlag } from "@atlcli/core";

type Flags = Record<string, string | boolean | string[]>;

/** Upper bound for `--max-depth` (reject absurd values). Root = depth 0. */
export const MAX_DEPTH_LIMIT = 1000;
/** Upper bound for `--max-pages` (reject absurd values). */
export const MAX_PAGES_LIMIT = 100_000;
/** Upper bound for `--max-folders` (reject absurd values). */
export const MAX_FOLDERS_LIMIT = 10_000;

export type ExportScopeKind = "page" | "tree" | "space";
export type ExportEngine = "python" | "ts";

/** The parsed, validated result — everything the handler needs to proceed. */
export interface ParsedExportRequest {
  scopeKind: ExportScopeKind;
  engine: ExportEngine;
  /** Positional page reference (page/tree scopes); undefined for space. */
  pageRef?: string;
  /** Space key (space scope); undefined otherwise. */
  spaceKey?: string;
  /** Tree/space: include the root page as a chapter (always true from the CLI). */
  includeRoot: boolean;
  /** Tree/space: max traversal depth (root = 0 in the model; 0 = root only). */
  maxDepth?: number;
  /** Tree/space: hard page cap. */
  maxPages?: number;
  /** Tree/space: hard folder cap. */
  maxFolders?: number;
  /** Tree/space: normalized label filter, or undefined when none was given. */
  labels?: LabelFilter;
  /** Completeness contract (default `strict`). */
  completenessMode: CompletenessMode;
  /** True when `--include-children` was used (deprecated alias for `--scope tree`). */
  usedIncludeChildrenAlias: boolean;
}

/** A structurally invalid flag combination. Handler maps this to a USAGE error. */
export class ExportRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportRequestError";
  }
}

function fail(message: string): never {
  throw new ExportRequestError(message);
}

/**
 * Parse a bounded-integer flag (`min` 0 or 1). `parseArgs` turns `--flag -3` /
 * a bare `--flag` into the boolean `true` (the next token starts with `-`), so a
 * present-but-valueless flag (and thus any negative value) is reported as a bad
 * value rather than silently ignored.
 */
function parseBoundedInt(
  flags: Flags,
  name: string,
  min: 0 | 1,
  limit: number
): number | undefined {
  if (!hasFlag(flags, name)) return undefined;
  const kind = min === 0 ? "non-negative" : "positive";
  const raw = getFlag(flags, name);
  if (raw === undefined) {
    fail(`--${name} requires a ${kind} integer value.`);
  }
  if (!/^\d+$/.test(raw)) {
    fail(`--${name} must be a ${kind} integer (got "${raw}").`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < min) {
    fail(`--${name} must be at least ${min} (got ${value}).`);
  }
  if (value > limit) {
    fail(`--${name} must not exceed ${limit} (got ${value}).`);
  }
  return value;
}

/**
 * Split one or more comma-separated label flag values into a clean, deduped
 * list. Rejects empty entries after split (e.g. `a,,b` or a trailing comma) so a
 * typo never silently drops a filter term. Case-sensitive dedupe (Confluence
 * labels are case-sensitive). Returns `undefined` when the flag was absent.
 */
function parseLabelList(flags: Flags, name: string): string[] | undefined {
  if (!hasFlag(flags, name)) return undefined;
  const raw = getFlags(flags, name);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of raw) {
    const parts = chunk.split(",");
    for (const part of parts) {
      const value = part.trim();
      if (!value) {
        fail(
          `--${name} contains an empty label entry (check for a stray or trailing comma in "${chunk}").`
        );
      }
      if (!seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parse the export request. Pure — throws {@link ExportRequestError} on any
 * invalid combination, returns a validated {@link ParsedExportRequest} otherwise.
 */
export function parseExportRequest(
  pageRef: string | undefined,
  flags: Flags
): ParsedExportRequest {
  // --- engine ---
  const engine = (getFlag(flags, "engine") ?? "python") as string;
  if (engine !== "python" && engine !== "ts") {
    fail(`Unknown --engine "${engine}". Use "ts" or "python".`);
  }

  // --- raw scope inputs ---
  const rawScope = getFlag(flags, "scope");
  if (rawScope !== undefined && rawScope !== "page" && rawScope !== "tree" && rawScope !== "space") {
    fail(`Unknown --scope "${rawScope}". Use "page", "tree", or "space".`);
  }
  const includeChildren = hasFlag(flags, "include-children");
  const spacePresent = hasFlag(flags, "space");
  const spaceKey = getFlag(flags, "space");
  if (spacePresent && spaceKey === undefined) {
    fail("--space requires a space key (e.g. --space DOCSY).");
  }

  // --- resolve the effective scope kind ---
  let scopeKind: ExportScopeKind;
  if (rawScope === "space" || rawScope === "tree" || rawScope === "page") {
    scopeKind = rawScope;
  } else if (includeChildren) {
    scopeKind = "tree"; // deprecated alias
  } else if (spacePresent) {
    scopeKind = "space"; // --space implies --scope space
  } else {
    scopeKind = "page";
  }

  // --- cross-flag conflicts ---
  if (includeChildren && rawScope !== undefined && rawScope !== "tree") {
    fail(
      `--include-children is a deprecated alias for --scope tree and conflicts with --scope ${rawScope}.`
    );
  }
  if (spacePresent && scopeKind !== "space") {
    fail(
      `--space implies --scope space and conflicts with --scope ${scopeKind}. ` +
        `Drop --space, or use --scope space with no positional page reference.`
    );
  }

  // --- numeric + label + completeness flags (validated regardless of scope) ---
  // --max-depth 0 is valid: root = depth 0, so 0 means "root only".
  const maxDepth = parseBoundedInt(flags, "max-depth", 0, MAX_DEPTH_LIMIT);
  const maxPages = parseBoundedInt(flags, "max-pages", 1, MAX_PAGES_LIMIT);
  const maxFolders = parseBoundedInt(flags, "max-folders", 1, MAX_FOLDERS_LIMIT);

  const include = parseLabelList(flags, "label-include");
  const exclude = parseLabelList(flags, "label-exclude");
  const excludeModeRaw = getFlag(flags, "label-exclude-mode");
  if (
    excludeModeRaw !== undefined &&
    excludeModeRaw !== "prune-subtree" &&
    excludeModeRaw !== "page-only"
  ) {
    fail(`Unknown --label-exclude-mode "${excludeModeRaw}". Use "prune-subtree" or "page-only".`);
  }
  if (hasFlag(flags, "label-exclude-mode") && excludeModeRaw === undefined) {
    fail(`--label-exclude-mode requires a value ("prune-subtree" or "page-only").`);
  }
  const labelFlagsPresent =
    include !== undefined || exclude !== undefined || hasFlag(flags, "label-exclude-mode");

  const completenessRaw = getFlag(flags, "completeness");
  if (
    completenessRaw !== undefined &&
    completenessRaw !== "strict" &&
    completenessRaw !== "partial"
  ) {
    fail(`Unknown --completeness "${completenessRaw}". Use "strict" or "partial".`);
  }
  if (hasFlag(flags, "completeness") && completenessRaw === undefined) {
    fail(`--completeness requires a value ("strict" or "partial").`);
  }
  const completenessMode: CompletenessMode =
    completenessRaw === "partial" ? "partial" : "strict";

  let labels: LabelFilter | undefined;
  if (include || exclude) {
    labels = {};
    if (include) labels.include = include;
    if (exclude) labels.exclude = exclude;
    if (excludeModeRaw) labels.excludeMode = excludeModeRaw as LabelFilter["excludeMode"];
  } else if (excludeModeRaw !== undefined) {
    fail("--label-exclude-mode has no effect without --label-exclude.");
  }

  // --- python engine only supports the legacy single-page / --include-children path ---
  if (engine === "python") {
    const usesNewFlags =
      rawScope === "tree" ||
      rawScope === "space" ||
      spacePresent ||
      labelFlagsPresent ||
      hasFlag(flags, "completeness") ||
      maxDepth !== undefined ||
      maxPages !== undefined ||
      maxFolders !== undefined;
    if (usesNewFlags) {
      fail(
        "Scope, label, completeness and traversal flags require --engine ts " +
          "(the python engine only supports single-page export and the legacy --include-children merge)."
      );
    }
  }

  // --- per-scope validation of the flags that only make sense for a tree/space ---
  if (scopeKind === "page") {
    if (maxDepth !== undefined) fail("--max-depth is only valid with --scope tree or --scope space.");
    if (maxPages !== undefined) fail("--max-pages is only valid with --scope tree or --scope space.");
    if (maxFolders !== undefined) fail("--max-folders is only valid with --scope tree or --scope space.");
    if (labels) fail("--label-include/--label-exclude are only valid with --scope tree or --scope space.");
    if (hasFlag(flags, "completeness")) {
      fail("--completeness is only valid with --scope tree or --scope space.");
    }
  }

  // --- resolve the positional / space arguments per scope ---
  switch (scopeKind) {
    case "page": {
      if (!pageRef) {
        fail("A page reference is required. Use page ID, SPACE:Title, or URL.");
      }
      return {
        scopeKind: "page",
        engine,
        pageRef,
        includeRoot: true,
        completenessMode,
        usedIncludeChildrenAlias: includeChildren,
      };
    }
    case "tree": {
      if (!pageRef) {
        fail("--scope tree requires a page reference (the root of the tree to export).");
      }
      return {
        scopeKind: "tree",
        engine,
        pageRef,
        includeRoot: true,
        ...(maxDepth !== undefined ? { maxDepth } : {}),
        ...(maxPages !== undefined ? { maxPages } : {}),
        ...(maxFolders !== undefined ? { maxFolders } : {}),
        ...(labels ? { labels } : {}),
        completenessMode,
        usedIncludeChildrenAlias: includeChildren,
      };
    }
    case "space": {
      if (!spaceKey) {
        fail("--scope space requires --space <KEY>.");
      }
      if (pageRef) {
        fail(
          `--scope space takes --space <KEY> and no positional page reference (got "${pageRef}"). ` +
            "Remove the page reference, or use --scope tree to export from a specific page."
        );
      }
      return {
        scopeKind: "space",
        engine,
        spaceKey,
        includeRoot: true,
        ...(maxDepth !== undefined ? { maxDepth } : {}),
        ...(maxPages !== undefined ? { maxPages } : {}),
        ...(maxFolders !== undefined ? { maxFolders } : {}),
        ...(labels ? { labels } : {}),
        completenessMode,
        usedIncludeChildrenAlias: includeChildren,
      };
    }
  }
}

/**
 * The single {@link ExportScope} construction site. Takes the parsed request and
 * the (network-)resolved ids and returns the serializable scope the shared
 * orchestration layer consumes.
 *
 * A `space` request is resolved to a `tree` scope rooted at the space homepage:
 * space *is* a tree whose root is the homepage, and resolving it here (rather
 * than re-resolving inside `fetchExportTree`) lets `--max-depth` apply to space
 * exports and makes the request→resolution traceable in the `--json` report
 * (requested `space` vs resolved `tree` rooted at the homepage id).
 */
export function buildExportScope(
  request: ParsedExportRequest,
  resolvedRootId: string
): ExportScope {
  switch (request.scopeKind) {
    case "page":
      return { kind: "page", pageId: resolvedRootId };
    case "tree":
    case "space":
      return {
        kind: "tree",
        rootPageId: resolvedRootId,
        includeRoot: request.includeRoot,
        ...(request.maxDepth !== undefined ? { maxDepth: request.maxDepth } : {}),
      };
  }
}

/** The report's scope-traceability pair (spec 002 A5), as emitted under `--json`. */
export interface ScopeReportFields {
  requestedScope: Record<string, unknown>;
  resolvedScope: Record<string, unknown>;
}

/**
 * The ONE construction site for the report's `requestedScope`/`resolvedScope`
 * traceability pair (spec 002 A5), shared by the DOCX (`export.ts`) and PDF
 * (`export-pdf.ts`) tree/space paths so both formats emit an IDENTICAL field set
 * for the same logical request.
 *
 * `requestedScope` mirrors the flags as given (a `--scope space --space DOCSY`
 * request stays visible as `kind: "space"`); `resolvedScope` is the
 * {@link buildExportScope} output, so the space→tree-at-homepage resolution is
 * traceable in the `--json` report rather than being silently collapsed.
 *
 * Pure: no IO, no network. Both fields are plain JSON-serializable records that
 * validate against `export-report.schema.json`'s open `requestedScope`/
 * `resolvedScope` objects.
 */
export function buildScopeReportFields(
  request: ParsedExportRequest,
  resolvedScope: ExportScope
): ScopeReportFields {
  return {
    requestedScope: {
      kind: request.scopeKind,
      ...(request.pageRef ? { pageRef: request.pageRef } : {}),
      ...(request.spaceKey ? { spaceKey: request.spaceKey } : {}),
      ...(request.maxDepth !== undefined ? { maxDepth: request.maxDepth } : {}),
      ...(request.maxPages !== undefined ? { maxPages: request.maxPages } : {}),
      ...(request.maxFolders !== undefined ? { maxFolders: request.maxFolders } : {}),
      ...(request.labels ? { labels: request.labels } : {}),
      completeness: request.completenessMode,
    },
    resolvedScope: { ...resolvedScope },
  };
}
