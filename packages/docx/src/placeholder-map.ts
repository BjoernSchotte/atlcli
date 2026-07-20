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
 *    (the §2 `unsupported (v1)` rows: JSON content properties) plus Comala
 *    `$scroll.metadata.*` (spec 005 D2: reclassified from `never`, since the
 *    mapping to a content property IS a supported remedy). Rendered ⚠ "will be
 *    empty"; resolves to `""` + report line.
 *  - **never** — depends on a third-party app atlcli does not target (Comala
 *    `$adhocState`, Scroll Documents `$scroll.custom.*`).
 *    Rendered ✗; resolves to `""`.
 *
 * `$scroll.includepage.*` (cross-page include) is **supported** (spec 005 D1):
 * it resolves to the included page's OOXML body via a document pass, so it is
 * classified `supported` with the `includePage` dependency rather than sitting
 * in the text resolver.
 *
 * Each `reason` is surfaced verbatim per row in the panel, so it must say WHY
 * this particular placeholder is empty — the causes differ sharply and a generic
 * "will be empty" would flatten them. `$scroll.pageowner.fullName` used to sit
 * in an "impossible on Cloud" group by implication; it does not — Cloud's v2
 * API exposes `ownerId`, so it is supported via {@link SUPPORTED_OWNER} (gap G1
 * closed). The logo placeholders were unblocked the same way once spec 005's
 * image module landed (gap G3 closed, see {@link SUPPORTED_LOGO}).
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
  | "spaceHomepage"
  | "spaceLogo"
  // Cross-page include (spec 005 D1). Like `spaceLogo`, this is NOT fetched by
  // the text resolver — it marks the base as handled by a document pass
  // (`runIncludePass`), which swaps the placeholder paragraph for the included
  // page's serialized OOXML body.
  | "includePage";

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

/**
 * Parsed size argument of a logo placeholder — Scroll documents
 * `$scroll.spacelogo.(H,W)`: height first, then width, both px. A single
 * argument is the height (the width scales by the logo's aspect ratio).
 * Non-numeric arguments are ignored (intrinsic size wins).
 */
export interface LogoArgs {
  heightPx?: number;
  widthPx?: number;
}

/** Parse the raw `$scroll.spacelogo.(H,W)` / `$scroll.globallogo.(H,W)` size args. */
export function parseLogoArgs(raw: string): LogoArgs {
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open === -1 || close <= open) return {};
  const parts = raw
    .slice(open + 1, close)
    .split(",")
    .map((p) => p.trim());
  const num = (s: string | undefined): number | undefined => {
    if (!s || !/^\d+$/.test(s)) return undefined;
    const n = Number(s);
    return n > 0 ? n : undefined;
  };
  return { heightPx: num(parts[0]), widthPx: num(parts[1]) };
}

/**
 * A parsed `$scroll.includepage.(…)` reference (spec 005 D1). Exactly one of
 * `pageId` (all-digits argument) or `title` (+ optional `spaceKey`) is set on a
 * successful parse; {@link parseIncludePageArgs} returns `null` for an
 * empty/missing/malformed argument group.
 */
export interface IncludePageRef {
  spaceKey?: string;
  title?: string;
  pageId?: string;
}

/**
 * Parse the argument group of `$scroll.includepage.(…)` (spec 005 D1). Forms:
 *  - `(Title)` — a title in the exported page's space (`spaceKey` left unset;
 *    the host fills in the current space when resolving),
 *  - `(SPACE:Title)` — split on the FIRST colon; the left side is the space
 *    key, the right side the title (titles may themselves contain colons),
 *  - `(pageId)` — an all-digits argument is a page id,
 *  - `("Quoted Title")` — a fully quote-wrapped argument is always a title, so a
 *    title that itself contains a colon can be referenced without the
 *    first-colon rule splitting it,
 *  - empty / missing group / a colon form with a blank side → `null` (invalid;
 *    the include pass emits a note and the token is blanked).
 *
 * NB `PLACEHOLDER_RE` stops the argument group at the first `)`, so a title
 * containing `)` cannot be referenced by title — use the `(pageId)` form
 * (documented limitation, spec 005 Risks).
 */
export function parseIncludePageArgs(raw: string): IncludePageRef | null {
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open === -1 || close <= open) return null;
  const inner = raw.slice(open + 1, close).trim();
  if (inner === "") return null;

  const strip = (s: string): string => s.trim().replace(/^["']|["']$/g, "").trim();

  // A fully quote-wrapped argument is a title verbatim (colon-safe).
  if (
    (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) ||
    (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2)
  ) {
    const title = inner.slice(1, -1).trim();
    return title === "" ? null : { title };
  }

  const colon = inner.indexOf(":");
  if (colon !== -1) {
    const spaceKey = strip(inner.slice(0, colon));
    const title = strip(inner.slice(colon + 1));
    if (spaceKey === "" || title === "") return null;
    return { spaceKey, title };
  }

  const value = strip(inner);
  if (value === "") return null;
  if (/^\d+$/.test(value)) return { pageId: value };
  return { title: value };
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
/**
 * Logo placeholders (spec 005, Gap G3 closed): both resolve to an embedded
 * image of the space logo (`GET /space/{key}?expand=icon`), handled by the
 * export orchestrator's logo pass — NOT by the text resolver (a logo is a
 * drawing, not a string). `$scroll.globallogo` also maps to the space logo:
 * Confluence Cloud exposes no separately fetchable global logo, and the export
 * report says so per occurrence.
 */
const SUPPORTED_LOGO = new Set<string>(["$scroll.spacelogo", "$scroll.globallogo"]);

/**
 * Cross-page include (spec 005 D1, gap closed). `$scroll.includepage.(…)`
 * embeds the body of another Confluence page at the placeholder position. Like
 * the logos, it resolves to OOXML (an included page body is a document, not a
 * string), so it is handled by the export orchestrator's INCLUDE pass
 * (`runIncludePass`), NOT by the text resolver — its `includePage` dependency
 * marks that. A bare `$scroll.includepage` with no argument still classifies
 * `supported`; the include pass then emits `includepage-unresolved` because it
 * names no page, and the token blanks (never a literal).
 */
const SUPPORTED_INCLUDE = new Set<string>(["$scroll.includepage"]);

const UNSUPPORTED_EXACT: Record<string, string> = {};

const UNSUPPORTED_PREFIXES: { prefix: string; reason: string }[] = [
  {
    prefix: "$scroll.jsoncontentproperty",
    reason: "content properties are not fetched (Gap G5)",
  },
  // Comala Metadata (spec 005 D2): reclassified from `never` → `unsupported`.
  // Publicly documented placeholder conventions carry no "we will never support
  // it" caveat, so a ✗ was possibly wrong and needlessly final. The reason
  // states the REMEDY, not just the gap (it appears verbatim in the scan panel
  // and export report).
  {
    prefix: "$scroll.metadata",
    reason:
      "metadata values live in a third-party app; map the key to a content property in the export settings to resolve it",
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
const NEVER_EXACT: Record<string, string> = {};

const NEVER_PREFIXES: { prefix: string; reason: string }[] = [
  { prefix: "$scroll.custom", reason: "Scroll Documents app — not integrated" },
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
  if (SUPPORTED_LOGO.has(base)) return { base, status: "supported", dependency: "spaceLogo" };
  if (SUPPORTED_INCLUDE.has(base)) return { base, status: "supported", dependency: "includePage" };

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
