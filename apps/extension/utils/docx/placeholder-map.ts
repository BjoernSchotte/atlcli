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
 *    (the §2 `unsupported (v1)` rows: DC usernames, space logo, page properties,
 *    JSON content properties) plus the derivable-but-out-of-v1-scope
 *    `$scroll.includepage.*` family (cross-page include is a Phase-2 non-goal,
 *    PLAN §Non-goals). Rendered ⚠ "will be empty"; resolves to `""` + report line.
 *  - **never** — depends on a third-party app or a system asset atlcli does not
 *    target (Comala `$adhocState`/`$scroll.metadata.*`, Scroll Documents
 *    `$scroll.custom.*`, `$scroll.globallogo`). Rendered ✗; resolves to `""`.
 *
 * Each `reason` is surfaced verbatim per row in the panel, so it must say WHY
 * this particular placeholder is empty — the causes differ sharply and a generic
 * "will be empty" would flatten them. Three distinct kinds live here: genuinely
 * impossible on Cloud (`.name` — Atlassian removed usernames), blocked on
 * another spec (the logos need 005's image module), and simply not modelled yet
 * (page properties). `$scroll.pageowner.fullName` used to sit in the first group
 * by implication; it does not — Cloud's v2 API exposes `ownerId`, so it is now
 * supported via {@link SUPPORTED_OWNER} (gap G1 closed).
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
export type PlaceholderDependency =
  | "none"
  | "space"
  | "currentUser"
  | "owner"
  | "spaceHomepage";

/**
 * Parsed argument list of `$scroll.pageproperty.(…)` (spec 001 gap **G4**).
 *
 * Scroll documents three forms — `(key)`, `(key,fallback-enabled)` and
 * `(key,macro-id,true,alternate-text)` — but not how to tell a 2-arg
 * `(key,macroId)` from `(key,fallback)`. We disambiguate on shape: a second
 * argument that reads as a boolean is the fallback flag, anything else is a
 * macro id. That covers both documented forms; the inference is recorded in
 * `scroll-placeholder-mapping.md` so a future contradiction is traceable rather
 * than mysterious.
 */
export interface PagePropertyArgs {
  key: string;
  macroId?: string;
  /** Fall back to the space homepage's macro when the page lacks the key. */
  fallbackEnabled: boolean;
  /** Rendered when the key resolves to nothing. */
  alternateText?: string;
}

function isBool(s: string | undefined): boolean {
  return s === "true" || s === "false";
}

/** Parse the raw `$scroll.pageproperty.(…)` argument group. */
export function parsePagePropertyArgs(raw: string): PagePropertyArgs {
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open === -1 || close <= open) return { key: "", fallbackEnabled: false };

  const parts = raw
    .slice(open + 1, close)
    .split(",")
    .map((p) => p.trim().replace(/^["']|["']$/g, ""));

  const key = parts[0] ?? "";
  if (parts.length < 2) return { key, fallbackEnabled: false };
  if (isBool(parts[1])) return { key, fallbackEnabled: parts[1] === "true" };

  return {
    key,
    macroId: parts[1] || undefined,
    fallbackEnabled: parts[2] === "true",
    alternateText: parts[3] || undefined,
  };
}

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
  // `.name` is Scroll's DATA CENTER username. Cloud has none, so the choice is
  // not "wrong value vs. right value" but "display name vs. nothing" — see
  // resolveDcName(). Resolved with a report note, never silently.
  "$scroll.creator.name",
  "$scroll.modifier",
  "$scroll.modifier.fullName",
  "$scroll.modifier.email",
  "$scroll.modifier.name",
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
  "$scroll.exporter.name",
]);

/**
 * Supported placeholders requiring a `getPageOwner()` round-trip (G6-style lazy
 * fetch; closes gap **G1**). Cloud page ownership is transferable and therefore
 * distinct from `createdBy`, and only the v2 API exposes `ownerId` — hence its
 * own dependency rather than a field on `ConfluencePageDetails`.
 *
 * Only the `.fullName` form is listed because that is the sole row the normative
 * §2 table carries for the owner (Cloud). A bare `$scroll.pageowner` therefore
 * falls through to the unrecognized→unsupported branch, which is the documented
 * contract rather than an oversight.
 */
const SUPPORTED_OWNER = new Set<string>(["$scroll.pageowner.fullName"]);

/**
 * `unsupported (v1)` bases (§2) — Confluence has it, atlcli does not model it.
 * `$scroll.includepage.*` and the parameterized `$scroll.pageproperty.*` /
 * `$scroll.jsoncontentproperty.*` families match by prefix (see classifier).
 */
const UNSUPPORTED_EXACT: Record<string, string> = {
  "$scroll.spacelogo": "the space logo is an image — needs the image module (spec 005, Gap G3)",
};

const UNSUPPORTED_PREFIXES: { prefix: string; reason: string }[] = [
  { prefix: "$scroll.includepage", reason: "cross-page include is out of scope in v1 (Phase 2)" },
  {
    prefix: "$scroll.jsoncontentproperty",
    reason: "content properties are not fetched (Gap G5)",
  },
];

/**
 * `$adhocState` is deliberately absent (Björn, 2026-07-16: "bauen wir aus").
 *
 * It is still MATCHED by the scan regex on purpose — dropping it from detection
 * would mean the resolver never sees it, so it would never be blanked and the
 * literal `$adhocState` would survive into the exported document, breaking the
 * never-a-literal invariant. Without a curated entry it falls through to the
 * unrecognized→unsupported branch below: empty value + report line, just with a
 * generic reason instead of a Comala-specific one.
 */
const NEVER_EXACT: Record<string, string> = {
  "$scroll.globallogo": "the global logo is an image — needs the image module (spec 005)",
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
  if (SUPPORTED_OWNER.has(base)) return { base, status: "supported", dependency: "owner" };

  // Page Properties (G4). The dependency varies by ARGUMENT, not by base: only
  // the fallback form needs the space homepage. Classification sees the raw, and
  // the resolver iterates raw occurrences, so a `(key)` on the same page never
  // triggers the homepage round-trip that a `(key,true)` next to it does.
  if (base === "$scroll.pageproperty") {
    return {
      base,
      status: "supported",
      dependency: parsePagePropertyArgs(raw).fallbackEnabled ? "spaceHomepage" : "none",
    };
  }

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
