/**
 * Scroll placeholder classification (spec 004 Tasks 3/4).
 *
 * Normative source: `specs/001-browser-ready-core/scroll-placeholder-mapping.md`
 * §2. Every `$scroll.*` / `$adhocState` placeholder a scanned template can carry
 * is graded here into one of three buckets that drive both the panel scan UI and
 * the resolver:
 *
 *  - **supported** — atlcli resolves it to a real value in v1. These are the
 *    §2 `direct` and `derivable` rows the resolver ({@link resolvePlaceholders})
 *    can compute from `{ details, space?, currentUser?, template, exportDate }`.
 *  - **unsupported** — Confluence exposes it but atlcli does not model it yet
 *    (the §2 `unsupported (v1)` rows: page owner, DC usernames, space logo, page
 *    properties, JSON content properties) plus the derivable-but-out-of-v1-scope
 *    `$scroll.includepage.*` family (cross-page include is a Phase-2 non-goal,
 *    PLAN §Non-goals). Rendered ⚠ "will be empty"; resolves to `""` + report line.
 *  - **never** — depends on a third-party app or a system asset atlcli does not
 *    target (Comala `$adhocState`/`$scroll.metadata.*`, Scroll Documents
 *    `$scroll.custom.*`, `$scroll.globallogo`). Rendered ✗; resolves to `""`.
 *
 * A placeholder's *base* is its dotted name with any `.("format")` argument and
 * `.(params)` stripped (e.g. `$scroll.exportdate.("dd.MM.yyyy")` → base
 * `$scroll.exportdate`). Classification is on the base.
 */

/** Panel-facing classification bucket. */
export type PlaceholderStatus = "supported" | "unsupported" | "never";

/**
 * Which fetched resource a supported placeholder needs. Drives lazy fetching in
 * the resolver: `space` → one `getSpace()` call; `currentUser` →
 * one `getCurrentUser()` call; `none` → resolvable from `details`/`template`/date
 * already in hand.
 */
export type PlaceholderDependency = "none" | "space" | "currentUser";

export interface PlaceholderClass {
  /** The classified base (argument/params stripped). */
  base: string;
  status: PlaceholderStatus;
  /** For supported rows, the external fetch (if any) required to resolve it. */
  dependency: PlaceholderDependency;
  /** Human note for unsupported/never rows (why it will be empty). */
  reason?: string;
}

/**
 * Strip a placeholder occurrence down to its classification base: drop a
 * trailing `.("…")`/`.(…)` argument group and any leftover trailing dot.
 */
export function placeholderBase(raw: string): string {
  // Remove the first parenthesized argument group and everything after it.
  const paren = raw.indexOf("(");
  let base = paren === -1 ? raw : raw.slice(0, paren);
  // A format/param group is introduced by `.(` — drop the dangling dot.
  base = base.replace(/\.$/, "");
  return base;
}

/** Supported placeholders that need no extra fetch (`direct` + page-local `derivable`). */
const SUPPORTED_NONE = new Set<string>([
  "$scroll.title",
  "$scroll.version",
  "$scroll.pageid",
  "$scroll.pageurl",
  "$scroll.tinyurl",
  "$scroll.pagelabels",
  "$scroll.pagelabels.capitalised",
  "$scroll.creator",
  "$scroll.creator.fullName",
  "$scroll.creator.email",
  "$scroll.modifier",
  "$scroll.modifier.fullName",
  "$scroll.modifier.email",
  "$scroll.creationdate",
  "$scroll.modificationdate",
  "$scroll.exportdate",
  "$scroll.space.key",
  "$scroll.template.name",
  "$scroll.template.modificationdate",
  // Content insertion point: supported, resolved specially (not a text value).
  "$scroll.content",
]);

/** Supported placeholders requiring a `getSpace()` round-trip (G6). */
const SUPPORTED_SPACE = new Set<string>(["$scroll.space.name", "$scroll.space.url"]);

/** Supported placeholders requiring a `getCurrentUser()` round-trip (G7). */
const SUPPORTED_USER = new Set<string>([
  "$scroll.exporter",
  "$scroll.exporter.fullName",
  "$scroll.exporter.email",
]);

/**
 * `unsupported (v1)` bases (§2) — Confluence has it, atlcli does not model it.
 * `$scroll.includepage.*` and the parameterized `$scroll.pageproperty.*` /
 * `$scroll.jsoncontentproperty.*` families match by prefix (see classifier).
 */
const UNSUPPORTED_EXACT: Record<string, string> = {
  "$scroll.pageowner.fullName": "page owner is not modeled (Gap G1)",
  "$scroll.creator.name": "Data Center username is not modeled (Gap G2)",
  "$scroll.modifier.name": "Data Center username is not modeled (Gap G2)",
  "$scroll.exporter.name": "Data Center username is not modeled (Gap G2)",
  "$scroll.spacelogo": "space logo is not fetched (Gap G3)",
};

const UNSUPPORTED_PREFIXES: { prefix: string; reason: string }[] = [
  { prefix: "$scroll.includepage", reason: "cross-page include is out of scope in v1 (Phase 2)" },
  { prefix: "$scroll.pageproperty", reason: "Page Properties macro is not parsed (Gap G4)" },
  {
    prefix: "$scroll.jsoncontentproperty",
    reason: "content properties are not fetched (Gap G5)",
  },
];

const NEVER_EXACT: Record<string, string> = {
  $adhocState: "Comala workflow state — third-party app",
  "$scroll.globallogo": "Confluence system-wide logo — not targeted",
};

const NEVER_PREFIXES: { prefix: string; reason: string }[] = [
  { prefix: "$scroll.custom", reason: "Scroll Documents app — not integrated" },
  { prefix: "$scroll.metadata", reason: "Comala Metadata app — third-party" },
];

/**
 * Classify a placeholder occurrence (raw, possibly carrying a `.("format")`
 * argument) against the normative §2 table.
 */
export function classifyPlaceholder(raw: string): PlaceholderClass {
  const base = placeholderBase(raw);

  if (SUPPORTED_NONE.has(base)) return { base, status: "supported", dependency: "none" };
  if (SUPPORTED_SPACE.has(base)) return { base, status: "supported", dependency: "space" };
  if (SUPPORTED_USER.has(base)) return { base, status: "supported", dependency: "currentUser" };

  if (base in UNSUPPORTED_EXACT) {
    return { base, status: "unsupported", dependency: "none", reason: UNSUPPORTED_EXACT[base] };
  }
  if (base in NEVER_EXACT) {
    return { base, status: "never", dependency: "none", reason: NEVER_EXACT[base] };
  }
  for (const { prefix, reason } of UNSUPPORTED_PREFIXES) {
    if (base === prefix || base.startsWith(`${prefix}.`)) {
      return { base, status: "unsupported", dependency: "none", reason };
    }
  }
  for (const { prefix, reason } of NEVER_PREFIXES) {
    if (base === prefix || base.startsWith(`${prefix}.`)) {
      return { base, status: "never", dependency: "none", reason };
    }
  }

  // Any other `$scroll.*` we do not recognize: treat as unsupported (empty +
  // report) rather than leaking the literal — the pinning invariant.
  return {
    base,
    status: "unsupported",
    dependency: "none",
    reason: "unrecognized placeholder",
  };
}
