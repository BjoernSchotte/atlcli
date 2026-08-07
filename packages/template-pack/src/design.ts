/**
 * `wiki.pdf-template/v1` design model (spec 012 T6.1).
 *
 * The design block is the presentation half of a template manifest: every
 * typography role, color token, semantic palette, and component spacing/layout
 * value the built-in Typst template used to hardcode now lives here as **typed,
 * bounded data**. `validateDesign` is the import gate for that data.
 *
 * ## "typed and bounded", not an untyped dumping ground
 *
 * The schema mixes two representations, both strictly validated:
 *
 * - **Structured named sections** — `page`, `features`, `branding`,
 *   `tokens.contrast`, `semanticPalettes` (callouts by kind, statuses by name).
 * - **Typed token tables** — `typography.roles`, `tokens.colors`,
 *   `tokens.layout`, `tokens.ratios`. The *keys* are open (validated safe
 *   identifiers) but every *value* is a bounded typed leaf (a `pt`/`mm`/`em`
 *   length, a canonical `#RRGGBB` color, a named weight, or a bounded finite
 *   number). This is a design-token table, the opposite of the risk the plan
 *   warns about: no arbitrary object, no raw Typst source fragment, and no
 *   number without bounds is ever accepted.
 *
 * Browser-safe: no `node:`/`bun:` imports.
 */

import { ManifestValidationError } from "./manifest-error.js";

/** A CSS length restricted to the three units the Typst engine consumes. */
export type DesignLength = string;
/** A canonical `#RRGGBB` color (uppercase or lowercase hex digits). */
export type DesignColor = string;
/** Typst named font weights the templates use. */
export type DesignWeight = "regular" | "medium" | "semibold" | "bold";
/** A key into {@link DesignTypography.fonts}. */
export type FontRole = "body" | "heading" | "mono";

/**
 * How the running head ("Kolumnentitel") names each body page.
 *
 * - `"title"` — the document title on the left, the space key on the right.
 *   The historical, and still the **default**, behavior.
 * - `"chapter"` — the level-1 heading that owns the page on the left, the space
 *   key on the right. Book-like documents want this: on a 57-page tree export
 *   `"title"` repeats the root page title on every page, which carries no
 *   information. Pages before the first level-1 heading (front matter) fall
 *   back to the document title, never to an empty head.
 * - `"custom"` — the head is driven by the Level-A `headerText` setting. This
 *   is declarative: an explicit `headerText` wins in *every* mode (the 007
 *   behavior is unchanged), so `"custom"` states the template's intent and
 *   resolves like `"title"` when no `headerText` is supplied.
 *
 * Adding a mode is non-breaking; the field is optional and an absent value
 * means {@link DEFAULT_DESIGN_HEADER_MODE}, so every manifest written before
 * this field existed keeps rendering byte-identically.
 */
export type DesignHeaderMode = "title" | "chapter" | "custom";

/** The bounded set of running-head modes, in declaration order. */
export const DESIGN_HEADER_MODES: readonly DesignHeaderMode[] = ["title", "chapter", "custom"];

/** The mode an absent `features.header.mode` resolves to. */
export const DEFAULT_DESIGN_HEADER_MODE: DesignHeaderMode = "title";

/** The bounded cover-composition kinds understood by the portable design model. */
export const DESIGN_COVER_COMPOSITION_KINDS = ["standard", "type-cut"] as const;
export type DesignCoverCompositionKind = (typeof DESIGN_COVER_COMPOSITION_KINDS)[number];

/** Where the cover rule and metadata grid are anchored. */
export const DESIGN_COVER_METADATA_POSITIONS = ["flow", "bottom"] as const;
export type DesignCoverMetadataPosition =
  (typeof DESIGN_COVER_METADATA_POSITIONS)[number];

/** The bounded closing-page kinds understood by the portable design model. */
export const DESIGN_CLOSING_COMPOSITION_KINDS = [
  "document-summary",
  "brand-lockup",
] as const;
export type DesignClosingCompositionKind =
  (typeof DESIGN_CLOSING_COMPOSITION_KINDS)[number];

export const DESIGN_VISIBILITIES = ["show", "hide"] as const;
export type DesignVisibility = (typeof DESIGN_VISIBILITIES)[number];

export const DESIGN_HORIZONTAL_ALIGNMENTS = ["left", "center", "right"] as const;
export type DesignHorizontalAlignment = (typeof DESIGN_HORIZONTAL_ALIGNMENTS)[number];

export interface DesignCoverCompositionV1 {
  kind: DesignCoverCompositionKind;
  logo: DesignVisibility;
  /** Absent preserves the historical flow layout. */
  metadataPosition?: DesignCoverMetadataPosition;
  typeCut?: {
    angle: number;
    stop: number;
  };
}

export interface DesignClosingPageCompositionV1 {
  kind: DesignClosingCompositionKind;
  logo: DesignVisibility;
  website: DesignVisibility;
  legalNotice: DesignVisibility;
  align: DesignHorizontalAlignment;
}

export interface DesignPageCompositionsV1 {
  cover: DesignCoverCompositionV1;
  closingPage: DesignClosingPageCompositionV1;
}

/** Back-compatible composition defaults; absence remains distinguishable. */
export const DEFAULT_DESIGN_COVER_COMPOSITION: Readonly<DesignCoverCompositionV1> =
  Object.freeze({ kind: "standard", logo: "show" });

/** The historical summary page contains none of the new brand-lockup fields. */
export const DEFAULT_DESIGN_CLOSING_PAGE_COMPOSITION: Readonly<DesignClosingPageCompositionV1> =
  Object.freeze({
    kind: "document-summary",
    logo: "hide",
    website: "hide",
    legalNotice: "hide",
    align: "left",
  });

export const DEFAULT_DESIGN_PAGE_COMPOSITIONS: Readonly<DesignPageCompositionsV1> =
  Object.freeze({
    cover: DEFAULT_DESIGN_COVER_COMPOSITION,
    closingPage: DEFAULT_DESIGN_CLOSING_PAGE_COMPOSITION,
  });

export interface TypographyRole {
  /** Which of the three font families this role renders in. */
  font?: FontRole;
  size: DesignLength;
  weight?: DesignWeight;
  /** Letter-spacing (`em`), e.g. cover-eyebrow tracking. */
  tracking?: DesignLength;
}

export interface CalloutPalette {
  background: DesignColor;
  foreground: DesignColor;
}

export interface DesignPage {
  size: "a4" | "letter";
  orientation: "portrait" | "landscape";
  margin: { top: DesignLength; bottom: DesignLength; left: DesignLength; right: DesignLength };
}

export interface DesignFeatures {
  cover: { enabled: boolean };
  outline: { enabled: boolean; depth: number };
  /**
   * The running head. `mode` lives here rather than in a new top-level `header`
   * section because `features` already owns the header as a named section, and
   * `features.outline` already carries bounded configuration beyond `enabled`
   * (`depth`) — so "a feature section holds its own bounded options" is the
   * established convention, not a new one.
   */
  header: { enabled: boolean; mode?: DesignHeaderMode };
  footer: { enabled: boolean };
  closingPage: { enabled: boolean };
}

export interface DesignBranding {
  accent: DesignColor;
  organizationName?: string;
  websiteLabel?: string;
  websiteUrl?: string;
  legalNotice?: string;
}

export interface DesignTypography {
  fonts: Record<FontRole, string>;
  roles: Record<string, TypographyRole>;
}

export interface DesignTokens {
  colors: Record<string, DesignColor>;
  layout: Record<string, DesignLength>;
  ratios: Record<string, number>;
  contrast: { minimum: number };
}

export interface DesignSemanticPalettes {
  callouts: Record<string, CalloutPalette>;
  statuses: Record<string, DesignColor>;
}

export interface WikiPdfTemplateDesignV1 {
  page: DesignPage;
  features: DesignFeatures;
  branding: DesignBranding;
  typography: DesignTypography;
  tokens: DesignTokens;
  semanticPalettes: DesignSemanticPalettes;
  compositions?: DesignPageCompositionsV1;
}

// ---------------------------------------------------------------------------
// Leaf validators — every one rejects (never coerces) an invalid value.
// ---------------------------------------------------------------------------

const LENGTH_RE = /^-?(?:\d+(?:\.\d+)?|\.\d+)(pt|mm|em)$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const WEIGHTS: readonly DesignWeight[] = ["regular", "medium", "semibold", "bold"];
const FONT_ROLES: readonly FontRole[] = ["body", "heading", "mono"];
/** Typst source metacharacters forbidden in every non-color design string. */
// eslint-disable-next-line no-control-regex
const UNSAFE_STRING_RE = /[\u0000-\u001f\u007f#{}\\"`$]/;
const LENGTH_MAGNITUDE_MAX = 1000;
const SAFE_STRING_MAX = 200;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(path: string, message: string): never {
  throw new ManifestValidationError("shape-error", `${path}: ${message}`, path);
}

export function validateDesignLength(value: unknown, path: string): DesignLength {
  if (typeof value !== "string" || !LENGTH_RE.test(value)) {
    fail(path, "must be a length with a pt/mm/em unit (e.g. \"10pt\")");
  }
  const magnitude = Math.abs(Number.parseFloat(value));
  if (!Number.isFinite(magnitude) || magnitude > LENGTH_MAGNITUDE_MAX) {
    fail(path, `length magnitude must be at most ${LENGTH_MAGNITUDE_MAX}`);
  }
  return value;
}

export function validateDesignColor(value: unknown, path: string): DesignColor {
  if (typeof value !== "string" || !COLOR_RE.test(value)) {
    fail(path, "must be a canonical #RRGGBB color");
  }
  return value;
}

export function validateSafeString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
  if ([...value].length > SAFE_STRING_MAX) {
    fail(path, `must be at most ${SAFE_STRING_MAX} Unicode code points`);
  }
  if (UNSAFE_STRING_RE.test(value)) fail(path, "must not contain Typst source metacharacters");
  return value;
}

function validateHttpsUrl(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "must be an absolute HTTPS URL");
  }
  const url = value;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(path, "must be an absolute HTTPS URL");
  }
  if (parsed.protocol !== "https:") fail(path, "must use the HTTPS scheme");
  if (parsed.username !== "" || parsed.password !== "") {
    fail(path, "must not contain credentials");
  }
  if (parsed.hash !== "") fail(path, "must not contain a fragment");
  return validateSafeString(url, path);
}

function validateWeight(value: unknown, path: string): DesignWeight {
  if (typeof value !== "string" || !WEIGHTS.includes(value as DesignWeight)) {
    fail(path, `must be one of ${WEIGHTS.join(", ")}`);
  }
  return value as DesignWeight;
}

export function validateBoundedNumber(
  value: unknown,
  path: string,
  bounds: { min: number; max: number; integer?: boolean }
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  if (bounds.integer && !Number.isInteger(value)) fail(path, "must be an integer");
  if (value < bounds.min || value > bounds.max) {
    fail(path, `must be within [${bounds.min}, ${bounds.max}]`);
  }
  return value;
}

function validateEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(path, `must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`);
  }
  return value as T;
}

function validateBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

/**
 * Assert a map KEY is a safe, Typst-identifier-shaped string.
 *
 * Keys matter as much as values: a manifest key is interpolated into generated
 * Typst source as a dictionary key, so an unvalidated key like
 * `x: panic("pwned"), y` would escape the key position and execute as code.
 * Every manifest map that can reach code generation must run its keys through
 * this guard.
 */
export function assertSafeIdentifier(key: string, path: string): string {
  if (typeof key !== "string" || !IDENTIFIER_RE.test(key)) {
    fail(path, "key must be a safe identifier ([A-Za-z][A-Za-z0-9]*)");
  }
  return key;
}

function validateIdentifierMap<T>(
  value: unknown,
  path: string,
  each: (v: unknown, p: string) => T
): Record<string, T> {
  if (!isObject(value)) fail(path, "must be an object");
  const out: Record<string, T> = {};
  for (const [key, raw] of Object.entries(value)) {
    assertSafeIdentifier(key, `${path}.${key}`);
    out[key] = each(raw, `${path}.${key}`);
  }
  return out;
}

function validateTypographyRole(value: unknown, path: string): TypographyRole {
  if (!isObject(value)) fail(path, "must be an object");
  const role: TypographyRole = { size: validateDesignLength(value.size, `${path}.size`) };
  if (value.font !== undefined) role.font = validateEnum(value.font, FONT_ROLES, `${path}.font`);
  if (value.weight !== undefined) role.weight = validateWeight(value.weight, `${path}.weight`);
  if (value.tracking !== undefined) {
    role.tracking = validateDesignLength(value.tracking, `${path}.tracking`);
  }
  return role;
}

function validateCalloutPalette(value: unknown, path: string): CalloutPalette {
  if (!isObject(value)) fail(path, "must be an object");
  return {
    background: validateDesignColor(value.background, `${path}.background`),
    foreground: validateDesignColor(value.foreground, `${path}.foreground`),
  };
}

/**
 * Validate an untrusted `design` block and return it typed. Rejects
 * out-of-bounds lengths/ratios, non-canonical colors, unknown weights, and any
 * Typst-source-shaped string — the same "data, not code" rule the Level-A
 * settings surface enforces, extended to the full presentation model.
 */
export function validateDesign(value: unknown, path = "design"): WikiPdfTemplateDesignV1 {
  if (!isObject(value)) fail(path, "must be an object");

  // page
  const page = value.page;
  if (!isObject(page)) fail(`${path}.page`, "must be an object");
  if (!isObject(page.margin)) fail(`${path}.page.margin`, "must be an object");
  const design: WikiPdfTemplateDesignV1 = {
    page: {
      size: validateEnum(page.size, ["a4", "letter"] as const, `${path}.page.size`),
      orientation: validateEnum(
        page.orientation,
        ["portrait", "landscape"] as const,
        `${path}.page.orientation`
      ),
      margin: {
        top: validateDesignLength(page.margin.top, `${path}.page.margin.top`),
        bottom: validateDesignLength(page.margin.bottom, `${path}.page.margin.bottom`),
        left: validateDesignLength(page.margin.left, `${path}.page.margin.left`),
        right: validateDesignLength(page.margin.right, `${path}.page.margin.right`),
      },
    },
    features: validateFeatures(value.features, `${path}.features`),
    branding: validateBranding(value.branding, `${path}.branding`),
    typography: validateTypography(value.typography, `${path}.typography`),
    tokens: validateTokens(value.tokens, `${path}.tokens`),
    semanticPalettes: validateSemanticPalettes(value.semanticPalettes, `${path}.semanticPalettes`),
    ...(value.compositions === undefined
      ? {}
      : { compositions: validatePageCompositions(value.compositions, `${path}.compositions`) }),
  };
  validateCompositionBranding(design, path);
  return design;
}

function validateFeatures(value: unknown, path: string): DesignFeatures {
  if (!isObject(value)) fail(path, "must be an object");
  const section = (key: string): Record<string, unknown> => {
    const v = value[key];
    if (!isObject(v)) fail(`${path}.${key}`, "must be an object");
    return v;
  };
  const cover = section("cover");
  const outline = section("outline");
  const header = section("header");
  const footer = section("footer");
  const closingPage = section("closingPage");
  return {
    cover: { enabled: validateBoolean(cover.enabled, `${path}.cover.enabled`) },
    outline: {
      enabled: validateBoolean(outline.enabled, `${path}.outline.enabled`),
      depth: validateBoundedNumber(outline.depth, `${path}.outline.depth`, {
        min: 1,
        max: 6,
        integer: true,
      }),
    },
    header: validateHeaderFeature(header, `${path}.header`),
    footer: { enabled: validateBoolean(footer.enabled, `${path}.footer.enabled`) },
    closingPage: { enabled: validateBoolean(closingPage.enabled, `${path}.closingPage.enabled`) },
  };
}

/**
 * Validate the `features.header` section. `mode` is **optional** and, when
 * present, must be one of the bounded {@link DESIGN_HEADER_MODES} — the same
 * reject-never-coerce discipline every other enum in this model uses. An absent
 * `mode` stays `undefined` (matching `branding.organizationName` /
 * `TypographyRole.font`); consumers resolve it with
 * {@link DEFAULT_DESIGN_HEADER_MODE}.
 */
function validateHeaderFeature(value: Record<string, unknown>, path: string): DesignFeatures["header"] {
  const header: DesignFeatures["header"] = {
    enabled: validateBoolean(value.enabled, `${path}.enabled`),
  };
  if (value.mode !== undefined) {
    header.mode = validateEnum(value.mode, DESIGN_HEADER_MODES, `${path}.mode`);
  }
  return header;
}

function validateBranding(value: unknown, path: string): DesignBranding {
  if (!isObject(value)) fail(path, "must be an object");
  const branding: DesignBranding = { accent: validateDesignColor(value.accent, `${path}.accent`) };
  if (value.organizationName !== undefined) {
    branding.organizationName = validateSafeString(value.organizationName, `${path}.organizationName`);
  }
  if (value.websiteLabel !== undefined) {
    branding.websiteLabel = validateSafeString(value.websiteLabel, `${path}.websiteLabel`);
  }
  if (value.websiteUrl !== undefined) {
    branding.websiteUrl = validateHttpsUrl(value.websiteUrl, `${path}.websiteUrl`);
  }
  if (value.legalNotice !== undefined) {
    branding.legalNotice = validateSafeString(value.legalNotice, `${path}.legalNotice`);
  }
  return branding;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !known.has(key));
  if (unknown) fail(`${path}.${unknown}`, "is not recognized");
}

function validatePageCompositions(value: unknown, path: string): DesignPageCompositionsV1 {
  if (!isObject(value)) fail(path, "must be an object");
  exactKeys(value, ["cover", "closingPage"], path);
  return {
    cover: validateCoverComposition(value.cover, `${path}.cover`),
    closingPage: validateClosingPageComposition(value.closingPage, `${path}.closingPage`),
  };
}

function validateCoverComposition(value: unknown, path: string): DesignCoverCompositionV1 {
  if (!isObject(value)) fail(path, "must be an object");
  exactKeys(value, ["kind", "logo", "metadataPosition", "typeCut"], path);
  const kind = validateEnum(value.kind, DESIGN_COVER_COMPOSITION_KINDS, `${path}.kind`);
  const logo = validateEnum(value.logo, DESIGN_VISIBILITIES, `${path}.logo`);
  const metadataPosition = value.metadataPosition === undefined
    ? undefined
    : validateEnum(
        value.metadataPosition,
        DESIGN_COVER_METADATA_POSITIONS,
        `${path}.metadataPosition`
      );
  if (kind === "standard") {
    if (value.typeCut !== undefined) {
      fail(`${path}.typeCut`, 'is not valid when kind is "standard"');
    }
    if (metadataPosition === "bottom") {
      fail(`${path}.metadataPosition`, 'is not valid when kind is "standard"');
    }
    return {
      kind,
      logo,
      ...(metadataPosition === undefined ? {} : { metadataPosition }),
    };
  }
  if (!isObject(value.typeCut)) fail(`${path}.typeCut`, 'is required when kind is "type-cut"');
  exactKeys(value.typeCut, ["angle", "stop"], `${path}.typeCut`);
  return {
    kind,
    logo,
    ...(metadataPosition === undefined ? {} : { metadataPosition }),
    typeCut: {
      angle: validateBoundedNumber(value.typeCut.angle, `${path}.typeCut.angle`, {
        min: -180,
        max: 180,
      }),
      stop: validateBoundedNumber(value.typeCut.stop, `${path}.typeCut.stop`, {
        min: 0,
        max: 100,
      }),
    },
  };
}

function validateClosingPageComposition(
  value: unknown,
  path: string
): DesignClosingPageCompositionV1 {
  if (!isObject(value)) fail(path, "must be an object");
  exactKeys(value, ["kind", "logo", "website", "legalNotice", "align"], path);
  const closing: DesignClosingPageCompositionV1 = {
    kind: validateEnum(value.kind, DESIGN_CLOSING_COMPOSITION_KINDS, `${path}.kind`),
    logo: validateEnum(value.logo, DESIGN_VISIBILITIES, `${path}.logo`),
    website: validateEnum(value.website, DESIGN_VISIBILITIES, `${path}.website`),
    legalNotice: validateEnum(value.legalNotice, DESIGN_VISIBILITIES, `${path}.legalNotice`),
    align: validateEnum(value.align, DESIGN_HORIZONTAL_ALIGNMENTS, `${path}.align`),
  };
  if (
    closing.kind === "document-summary" &&
    (closing.logo === "show" || closing.website === "show" || closing.legalNotice === "show")
  ) {
    fail(path, 'document-summary must hide logo, website, and legalNotice');
  }
  return closing;
}

function validateCompositionBranding(design: WikiPdfTemplateDesignV1, path: string): void {
  const closing = design.compositions?.closingPage;
  if (!closing || closing.kind !== "brand-lockup") return;
  if (closing.website === "show") {
    if (!design.branding.websiteLabel) {
      fail(`${path}.branding.websiteLabel`, 'is required when brand-lockup website is "show"');
    }
    if (!design.branding.websiteUrl) {
      fail(`${path}.branding.websiteUrl`, 'is required when brand-lockup website is "show"');
    }
  }
  if (closing.legalNotice === "show" && !design.branding.legalNotice) {
    fail(`${path}.branding.legalNotice`, 'is required when brand-lockup legalNotice is "show"');
  }
}

function validateTypography(value: unknown, path: string): DesignTypography {
  if (!isObject(value)) fail(path, "must be an object");
  if (!isObject(value.fonts)) fail(`${path}.fonts`, "must be an object");
  const fonts = value.fonts;
  return {
    fonts: {
      body: validateSafeString(fonts.body, `${path}.fonts.body`),
      heading: validateSafeString(fonts.heading, `${path}.fonts.heading`),
      mono: validateSafeString(fonts.mono, `${path}.fonts.mono`),
    },
    roles: validateIdentifierMap(value.roles, `${path}.roles`, validateTypographyRole),
  };
}

function validateTokens(value: unknown, path: string): DesignTokens {
  if (!isObject(value)) fail(path, "must be an object");
  if (!isObject(value.contrast)) fail(`${path}.contrast`, "must be an object");
  return {
    colors: validateIdentifierMap(value.colors, `${path}.colors`, validateDesignColor),
    layout: validateIdentifierMap(value.layout, `${path}.layout`, validateDesignLength),
    ratios: validateIdentifierMap(value.ratios, `${path}.ratios`, (v, p) =>
      validateBoundedNumber(v, p, { min: 0, max: 100 })
    ),
    contrast: {
      minimum: validateBoundedNumber(value.contrast.minimum, `${path}.contrast.minimum`, {
        min: 1,
        max: 21,
      }),
    },
  };
}

function validateSemanticPalettes(value: unknown, path: string): DesignSemanticPalettes {
  if (!isObject(value)) fail(path, "must be an object");
  return {
    callouts: validateIdentifierMap(value.callouts, `${path}.callouts`, validateCalloutPalette),
    statuses: validateIdentifierMap(value.statuses, `${path}.statuses`, validateDesignColor),
  };
}
