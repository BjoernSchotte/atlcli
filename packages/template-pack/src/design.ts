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

// ---------------------------------------------------------------------------
// Catalog-V3 page and running-region model (canonical revision 5).
// Kept parallel to V1 so historical manifests and their normalized values do
// not change when the new authoring generation is added.
// ---------------------------------------------------------------------------

export type DesignPageFormatV3 =
  | { kind: "preset"; name: "a4" | "letter" }
  | { kind: "custom"; width: DesignLength; height: DesignLength };

export type DesignPageMarginV3 =
  | {
      mode: "physical";
      top: DesignLength;
      bottom: DesignLength;
      left: DesignLength;
      right: DesignLength;
    }
  | {
      mode: "logical";
      top: DesignLength;
      bottom: DesignLength;
      inside: DesignLength;
      outside: DesignLength;
    };

export interface DesignPageBleedV3 {
  top: DesignLength;
  bottom: DesignLength;
  inside: DesignLength;
  outside: DesignLength;
}

export interface DesignPageV3 {
  format: DesignPageFormatV3;
  orientation: "portrait" | "landscape";
  binding: "left" | "right";
  margin: DesignPageMarginV3;
  bleed?: DesignPageBleedV3;
}

export const DESIGN_RUNNING_LAYOUTS_V3 = [
  "single",
  "split",
  "three-column",
] as const;
export type DesignRunningLayoutV3 = (typeof DESIGN_RUNNING_LAYOUTS_V3)[number];

export const DESIGN_RUNNING_FIELDS_V3 = [
  "documentTitle",
  "chapterTitle",
  "spaceName",
  "spaceKey",
  "organizationName",
  "version",
  "exportDate",
  "classification",
  "literal",
  "pageNumber",
] as const;
export type DesignRunningFieldV3 = (typeof DESIGN_RUNNING_FIELDS_V3)[number];

export interface DesignRunningSlotV3 {
  field: DesignRunningFieldV3;
  value?: string;
  numbering?: "current" | "current-of-total";
}

export interface DesignRunningVariantV3 {
  start?: DesignRunningSlotV3;
  center?: DesignRunningSlotV3;
  end?: DesignRunningSlotV3;
}

export interface DesignRunningRegionV3 {
  enabled: boolean;
  layout: DesignRunningLayoutV3;
  first: "hide" | DesignRunningVariantV3;
  odd: DesignRunningVariantV3;
  even: DesignRunningVariantV3;
}

export interface DesignPageCompositionsV3 extends DesignPageCompositionsV1 {
  running: {
    header: DesignRunningRegionV3;
    footer: DesignRunningRegionV3;
  };
}

export const DESIGN_NAVIGATION_DEPTH_MIN_V3 = 1;
export const DESIGN_NAVIGATION_DEPTH_MAX_V3 = 6;

export const DESIGN_OUTLINE_PAGE_NUMBER_MODES_V3 = ["show", "hide"] as const;
export type DesignOutlinePageNumberModeV3 =
  (typeof DESIGN_OUTLINE_PAGE_NUMBER_MODES_V3)[number];

export const DESIGN_OUTLINE_LEADERS_V3 = ["dots", "line", "none"] as const;
export type DesignOutlineLeaderV3 = (typeof DESIGN_OUTLINE_LEADERS_V3)[number];

export const DESIGN_HEADING_NUMBERING_PRESETS_V3 = [
  "decimal",
  "decimal-dot",
  "decimal-alpha",
  "decimal-alpha-roman",
] as const;
export type DesignHeadingNumberingPresetV3 =
  (typeof DESIGN_HEADING_NUMBERING_PRESETS_V3)[number];

export const DESIGN_PAGE_NUMBERING_PRESETS_V3 = [
  "arabic",
  "roman-lower",
  "roman-upper",
] as const;
export type DesignPageNumberingPresetV3 =
  (typeof DESIGN_PAGE_NUMBERING_PRESETS_V3)[number];

export interface DesignContentsNavigationV3 {
  enabled: boolean;
  depth: number;
  /** Optional presentation overrides; component defaults remain independently reusable. */
  pageNumbers?: DesignOutlinePageNumberModeV3;
  leader?: DesignOutlineLeaderV3;
}

export interface DesignBookmarkNavigationV3 {
  enabled: boolean;
  depth: number;
  includeHeadingNumbers: boolean;
}

export interface DesignHeadingNumberNavigationV3 {
  enabled: boolean;
  preset: DesignHeadingNumberingPresetV3;
}

export interface DesignPageNumberPhaseV3 {
  preset: DesignPageNumberingPresetV3;
  start: number;
}

export interface DesignPageNumberNavigationV3 extends DesignPageNumberPhaseV3 {
  enabled: boolean;
  /** When present, switch numbering and reset the counter immediately before body content. */
  body?: DesignPageNumberPhaseV3;
}

export interface DesignNavigationV3 {
  contents: DesignContentsNavigationV3;
  bookmarks: DesignBookmarkNavigationV3;
  headingNumbers: DesignHeadingNumberNavigationV3;
  pageNumbers: DesignPageNumberNavigationV3;
}

export const DESIGN_PARAGRAPH_ALIGNMENTS_V3 = [
  "left",
  "center",
  "right",
  "justify",
] as const;
export type DesignParagraphAlignmentV3 =
  (typeof DESIGN_PARAGRAPH_ALIGNMENTS_V3)[number];

export const DESIGN_HYPHENATION_MODES_V3 = ["auto", "off"] as const;
export type DesignHyphenationModeV3 =
  (typeof DESIGN_HYPHENATION_MODES_V3)[number];

export const DESIGN_LIST_MARKER_ALIGNMENTS_V3 = [
  "start",
  "end",
  "horizon",
] as const;
export type DesignListMarkerAlignmentV3 =
  (typeof DESIGN_LIST_MARKER_ALIGNMENTS_V3)[number];

export const DESIGN_BULLET_PRESETS_V3 = [
  "disc-circle-square",
  "compact",
  "dash",
] as const;
export type DesignBulletPresetV3 = (typeof DESIGN_BULLET_PRESETS_V3)[number];

export const DESIGN_ENUMERATION_PRESETS_V3 = [
  "decimal-alpha-roman",
  "decimal",
  "alpha-lower",
  "roman-lower",
] as const;
export type DesignEnumerationPresetV3 =
  (typeof DESIGN_ENUMERATION_PRESETS_V3)[number];

export const DESIGN_TABLE_BANDING_MODES_V3 = ["none", "rows", "columns"] as const;
export type DesignTableBandingModeV3 =
  (typeof DESIGN_TABLE_BANDING_MODES_V3)[number];

export const DESIGN_TABLE_BORDER_MODES_V3 = [
  "all",
  "horizontal",
  "outer",
  "none",
] as const;
export type DesignTableBorderModeV3 =
  (typeof DESIGN_TABLE_BORDER_MODES_V3)[number];

export const DESIGN_CALLOUT_PRESETS_V3 = ["accent-bar", "filled", "outline"] as const;
export type DesignCalloutPresetV3 = (typeof DESIGN_CALLOUT_PRESETS_V3)[number];

export const DESIGN_CODE_WRAP_MODES_V3 = ["soft", "none"] as const;
export type DesignCodeWrapModeV3 = (typeof DESIGN_CODE_WRAP_MODES_V3)[number];

export interface DesignParagraphComponentV3 {
  align: DesignParagraphAlignmentV3;
  hyphenation: DesignHyphenationModeV3;
}

export interface DesignListComponentV3 {
  bulletPreset: DesignBulletPresetV3;
  markerAlign: DesignListMarkerAlignmentV3;
  markerColor?: string;
}

export interface DesignEnumerationComponentV3 {
  numberingPreset: DesignEnumerationPresetV3;
  markerAlign: DesignListMarkerAlignmentV3;
  markerColor?: string;
}

export interface DesignTableComponentV3 {
  repeatHeader: boolean;
  banding: DesignTableBandingModeV3;
  borders: DesignTableBorderModeV3;
  bandColor?: string;
  borderColor?: string;
}

export interface DesignOutlineComponentV3 {
  leader: DesignOutlineLeaderV3;
  pageNumbers: DesignOutlinePageNumberModeV3;
  leaderColor?: string;
}

export interface DesignCalloutComponentV3 {
  preset: DesignCalloutPresetV3;
  icon: DesignVisibility;
  accentColor?: string;
}

export interface DesignCodeBlockComponentV3 {
  wrap: DesignCodeWrapModeV3;
  lineNumbers: DesignVisibility;
  backgroundColor?: string;
}

export interface DesignComponentsV3 {
  paragraph: DesignParagraphComponentV3;
  list: DesignListComponentV3;
  enumeration: DesignEnumerationComponentV3;
  table: DesignTableComponentV3;
  outline: DesignOutlineComponentV3;
  callout: DesignCalloutComponentV3;
  codeBlock: DesignCodeBlockComponentV3;
}

export interface WikiPdfTemplateDesignV3 {
  page: DesignPageV3;
  branding: DesignBranding;
  typography: DesignTypography;
  tokens: DesignTokens;
  semanticPalettes: DesignSemanticPalettes;
  compositions: DesignPageCompositionsV3;
  navigation: DesignNavigationV3;
  components: DesignComponentsV3;
  /** T5 replaces these bounded opaque values with exact paint/shape types. */
  paints?: Readonly<Record<string, unknown>>;
  decorations?: readonly unknown[];
}

const PAGE_LENGTH_RE_V3 = /^(?:0|[1-9]\d*)(?:\.\d+)?(pt|mm)$/u;
const PAGE_UNITS_IN_MM_V3: Readonly<Record<string, number>> = {
  pt: 25.4 / 72,
  mm: 1,
};
const PAGE_MIN_MM_V3 = 25;
const PAGE_MAX_MM_V3 = 2_000;
const PAGE_MARGIN_MAX_MM_V3 = 500;
const PAGE_BLEED_MAX_MM_V3 = 50;
const V3_JSON_MAX_DEPTH = 24;
const V3_JSON_MAX_NODES = 8_192;
const V3_JSON_MAX_ARRAY = 1_024;

function pageLengthV3(
  value: unknown,
  path: string,
  bounds: { min: number; max: number }
): { source: DesignLength; mm: number } {
  if (typeof value !== "string") fail(path, "must be a bounded pt/mm length");
  const match = PAGE_LENGTH_RE_V3.exec(value);
  if (!match) fail(path, "must be a non-negative bounded pt/mm length");
  const mm = Number.parseFloat(value) * PAGE_UNITS_IN_MM_V3[match[1]!]!;
  if (!Number.isFinite(mm) || mm < bounds.min || mm > bounds.max) {
    fail(path, `must be within [${bounds.min}mm, ${bounds.max}mm]`);
  }
  return { source: value, mm };
}

function validatePageFormatV3(value: unknown, path: string): {
  format: DesignPageFormatV3;
  widthMm: number;
  heightMm: number;
} {
  if (!isObject(value)) fail(path, "must be an object");
  const kind = validateEnum(value.kind, ["preset", "custom"] as const, `${path}.kind`);
  if (kind === "preset") {
    exactKeys(value, ["kind", "name"], path);
    const name = validateEnum(value.name, ["a4", "letter"] as const, `${path}.name`);
    return {
      format: { kind, name },
      widthMm: name === "a4" ? 210 : 215.9,
      heightMm: name === "a4" ? 297 : 279.4,
    };
  }
  exactKeys(value, ["kind", "width", "height"], path);
  const width = pageLengthV3(value.width, `${path}.width`, {
    min: PAGE_MIN_MM_V3,
    max: PAGE_MAX_MM_V3,
  });
  const height = pageLengthV3(value.height, `${path}.height`, {
    min: PAGE_MIN_MM_V3,
    max: PAGE_MAX_MM_V3,
  });
  return {
    format: { kind, width: width.source, height: height.source },
    widthMm: width.mm,
    heightMm: height.mm,
  };
}

function validatePageMarginV3(
  value: unknown,
  path: string
): { margin: DesignPageMarginV3; horizontalMm: number; verticalMm: number } {
  if (!isObject(value)) fail(path, "must be an object");
  const mode = validateEnum(value.mode, ["physical", "logical"] as const, `${path}.mode`);
  const top = pageLengthV3(value.top, `${path}.top`, {
    min: 0,
    max: PAGE_MARGIN_MAX_MM_V3,
  });
  const bottom = pageLengthV3(value.bottom, `${path}.bottom`, {
    min: 0,
    max: PAGE_MARGIN_MAX_MM_V3,
  });
  if (mode === "physical") {
    exactKeys(value, ["mode", "top", "bottom", "left", "right"], path);
    const left = pageLengthV3(value.left, `${path}.left`, {
      min: 0,
      max: PAGE_MARGIN_MAX_MM_V3,
    });
    const right = pageLengthV3(value.right, `${path}.right`, {
      min: 0,
      max: PAGE_MARGIN_MAX_MM_V3,
    });
    return {
      margin: {
        mode,
        top: top.source,
        bottom: bottom.source,
        left: left.source,
        right: right.source,
      },
      horizontalMm: left.mm + right.mm,
      verticalMm: top.mm + bottom.mm,
    };
  }
  exactKeys(value, ["mode", "top", "bottom", "inside", "outside"], path);
  const inside = pageLengthV3(value.inside, `${path}.inside`, {
    min: 0,
    max: PAGE_MARGIN_MAX_MM_V3,
  });
  const outside = pageLengthV3(value.outside, `${path}.outside`, {
    min: 0,
    max: PAGE_MARGIN_MAX_MM_V3,
  });
  return {
    margin: {
      mode,
      top: top.source,
      bottom: bottom.source,
      inside: inside.source,
      outside: outside.source,
    },
    horizontalMm: inside.mm + outside.mm,
    verticalMm: top.mm + bottom.mm,
  };
}

function validatePageBleedV3(value: unknown, path: string): DesignPageBleedV3 {
  if (!isObject(value)) fail(path, "must be an object");
  exactKeys(value, ["top", "bottom", "inside", "outside"], path);
  const side = (name: keyof DesignPageBleedV3): DesignLength =>
    pageLengthV3(value[name], `${path}.${name}`, {
      min: 0,
      max: PAGE_BLEED_MAX_MM_V3,
    }).source;
  return {
    top: side("top"),
    bottom: side("bottom"),
    inside: side("inside"),
    outside: side("outside"),
  };
}

function validatePageV3(value: unknown, path: string): DesignPageV3 {
  if (!isObject(value)) fail(path, "must be an object");
  exactKeys(value, ["format", "orientation", "binding", "margin", "bleed"], path);
  const { format, widthMm, heightMm } = validatePageFormatV3(value.format, `${path}.format`);
  const orientation = validateEnum(
    value.orientation,
    ["portrait", "landscape"] as const,
    `${path}.orientation`
  );
  const binding = validateEnum(value.binding, ["left", "right"] as const, `${path}.binding`);
  const validatedMargin = validatePageMarginV3(value.margin, `${path}.margin`);
  const bodyWidth = (orientation === "landscape" ? heightMm : widthMm) - validatedMargin.horizontalMm;
  const bodyHeight = (orientation === "landscape" ? widthMm : heightMm) - validatedMargin.verticalMm;
  if (bodyWidth <= 0 || bodyHeight <= 0) {
    fail(`${path}.margin`, "must leave a positive page body area");
  }
  return {
    format,
    orientation,
    binding,
    margin: validatedMargin.margin,
    ...(value.bleed === undefined
      ? {}
      : { bleed: validatePageBleedV3(value.bleed, `${path}.bleed`) }),
  };
}

function validateRunningSlotV3(value: unknown, path: string): DesignRunningSlotV3 {
  if (!isObject(value)) fail(path, "must be an object");
  exactKeys(value, ["field", "value", "numbering"], path);
  const field = validateEnum(value.field, DESIGN_RUNNING_FIELDS_V3, `${path}.field`);
  if (field === "literal") {
    if (value.value === undefined) fail(`${path}.value`, 'is required for field "literal"');
    if (value.numbering !== undefined) fail(`${path}.numbering`, 'is not valid for field "literal"');
    return { field, value: validateSafeString(value.value, `${path}.value`) };
  }
  if (value.value !== undefined) fail(`${path}.value`, `is not valid for field "${field}"`);
  if (field === "pageNumber") {
    return {
      field,
      numbering:
        value.numbering === undefined
          ? "current"
          : validateEnum(
              value.numbering,
              ["current", "current-of-total"] as const,
              `${path}.numbering`
            ),
    };
  }
  if (value.numbering !== undefined) fail(`${path}.numbering`, `is not valid for field "${field}"`);
  return { field };
}

function validateRunningVariantV3(
  value: unknown,
  layout: DesignRunningLayoutV3,
  path: string
): DesignRunningVariantV3 {
  if (!isObject(value)) fail(path, "must be an object");
  const allowed =
    layout === "single"
      ? ["center"]
      : layout === "split"
        ? ["start", "end"]
        : ["start", "center", "end"];
  exactKeys(value, allowed, path);
  if (Object.keys(value).length === 0) fail(path, "must contain at least one running slot");
  if (layout === "single" && value.center === undefined) fail(`${path}.center`, "is required");
  if (layout === "split" && (value.start === undefined || value.end === undefined)) {
    fail(path, "split layout requires start and end slots");
  }
  const result: DesignRunningVariantV3 = {};
  for (const key of allowed as Array<"start" | "center" | "end">) {
    if (value[key] !== undefined) {
      result[key] = validateRunningSlotV3(value[key], `${path}.${key}`);
    }
  }
  return result;
}

function validateRunningRegionV3(value: unknown, path: string): DesignRunningRegionV3 {
  if (!isObject(value)) fail(path, "must be an object");
  exactKeys(value, ["enabled", "layout", "first", "odd", "even"], path);
  const layout = validateEnum(value.layout, DESIGN_RUNNING_LAYOUTS_V3, `${path}.layout`);
  return {
    enabled: validateBoolean(value.enabled, `${path}.enabled`),
    layout,
    first:
      value.first === "hide"
        ? "hide"
        : validateRunningVariantV3(value.first, layout, `${path}.first`),
    odd: validateRunningVariantV3(value.odd, layout, `${path}.odd`),
    even: validateRunningVariantV3(value.even, layout, `${path}.even`),
  };
}

function validatePageCompositionsV3(value: unknown, path: string): DesignPageCompositionsV3 {
  if (!isObject(value)) fail(path, "must be an object");
  exactKeys(value, ["cover", "closingPage", "running"], path);
  if (!isObject(value.running)) fail(`${path}.running`, "must be an object");
  exactKeys(value.running, ["header", "footer"], `${path}.running`);
  return {
    cover: validateCoverComposition(value.cover, `${path}.cover`),
    closingPage: validateClosingPageComposition(value.closingPage, `${path}.closingPage`),
    running: {
      header: validateRunningRegionV3(value.running.header, `${path}.running.header`),
      footer: validateRunningRegionV3(value.running.footer, `${path}.running.footer`),
    },
  };
}

function validateNavigationDepthV3(value: unknown, path: string): number {
  return validateBoundedNumber(value, path, {
    min: DESIGN_NAVIGATION_DEPTH_MIN_V3,
    max: DESIGN_NAVIGATION_DEPTH_MAX_V3,
    integer: true,
  });
}

function validatePageNumberPhaseV3(
  value: unknown,
  path: string,
): DesignPageNumberPhaseV3 {
  if (!isObject(value)) fail(path, "must be an object");
  exactKeys(value, ["preset", "start"], path);
  return {
    preset: validateEnum(
      value.preset,
      DESIGN_PAGE_NUMBERING_PRESETS_V3,
      `${path}.preset`,
    ),
    start: validateBoundedNumber(value.start, `${path}.start`, {
      min: 1,
      max: 99_999,
      integer: true,
    }),
  };
}

function validateNavigationV3(value: unknown, path: string): DesignNavigationV3 {
  if (!isObject(value)) fail(path, "must be an object");
  exactKeys(value, ["contents", "bookmarks", "headingNumbers", "pageNumbers"], path);

  if (!isObject(value.contents)) fail(`${path}.contents`, "must be an object");
  exactKeys(value.contents, ["enabled", "depth", "pageNumbers", "leader"], `${path}.contents`);
  const contents: DesignContentsNavigationV3 = {
    enabled: validateBoolean(value.contents.enabled, `${path}.contents.enabled`),
    depth: validateNavigationDepthV3(value.contents.depth, `${path}.contents.depth`),
    ...(value.contents.pageNumbers === undefined
      ? {}
      : {
          pageNumbers: validateEnum(
            value.contents.pageNumbers,
            DESIGN_OUTLINE_PAGE_NUMBER_MODES_V3,
            `${path}.contents.pageNumbers`,
          ),
        }),
    ...(value.contents.leader === undefined
      ? {}
      : {
          leader: validateEnum(
            value.contents.leader,
            DESIGN_OUTLINE_LEADERS_V3,
            `${path}.contents.leader`,
          ),
        }),
  };

  if (!isObject(value.bookmarks)) fail(`${path}.bookmarks`, "must be an object");
  exactKeys(value.bookmarks, ["enabled", "depth", "includeHeadingNumbers"], `${path}.bookmarks`);
  const bookmarks: DesignBookmarkNavigationV3 = {
    enabled: validateBoolean(value.bookmarks.enabled, `${path}.bookmarks.enabled`),
    depth: validateNavigationDepthV3(value.bookmarks.depth, `${path}.bookmarks.depth`),
    includeHeadingNumbers: validateBoolean(
      value.bookmarks.includeHeadingNumbers,
      `${path}.bookmarks.includeHeadingNumbers`,
    ),
  };

  if (!isObject(value.headingNumbers)) {
    fail(`${path}.headingNumbers`, "must be an object");
  }
  exactKeys(value.headingNumbers, ["enabled", "preset"], `${path}.headingNumbers`);
  const headingNumbers: DesignHeadingNumberNavigationV3 = {
    enabled: validateBoolean(
      value.headingNumbers.enabled,
      `${path}.headingNumbers.enabled`,
    ),
    preset: validateEnum(
      value.headingNumbers.preset,
      DESIGN_HEADING_NUMBERING_PRESETS_V3,
      `${path}.headingNumbers.preset`,
    ),
  };

  if (!isObject(value.pageNumbers)) fail(`${path}.pageNumbers`, "must be an object");
  exactKeys(value.pageNumbers, ["enabled", "preset", "start", "body"], `${path}.pageNumbers`);
  const firstPhase: DesignPageNumberPhaseV3 = {
    preset: validateEnum(
      value.pageNumbers.preset,
      DESIGN_PAGE_NUMBERING_PRESETS_V3,
      `${path}.pageNumbers.preset`,
    ),
    start: validateBoundedNumber(value.pageNumbers.start, `${path}.pageNumbers.start`, {
      min: 1,
      max: 99_999,
      integer: true,
    }),
  };
  const pageNumbers: DesignPageNumberNavigationV3 = {
    enabled: validateBoolean(value.pageNumbers.enabled, `${path}.pageNumbers.enabled`),
    ...firstPhase,
    ...(value.pageNumbers.body === undefined
      ? {}
      : {
          body: validatePageNumberPhaseV3(
            value.pageNumbers.body,
            `${path}.pageNumbers.body`,
          ),
        }),
  };

  if (
    bookmarks.enabled &&
    headingNumbers.enabled &&
    !bookmarks.includeHeadingNumbers
  ) {
    fail(
      `${path}.bookmarks.includeHeadingNumbers`,
      "must be true while viewer bookmarks and native heading numbering are both enabled on Typst 0.15.1",
    );
  }

  return { contents, bookmarks, headingNumbers, pageNumbers };
}

function validateColorTokenReferenceV3(
  value: unknown,
  path: string,
  colors: Readonly<Record<string, DesignColor>>,
): string {
  if (typeof value !== "string") fail(path, "must name a color token");
  const token = assertSafeIdentifier(value, path);
  if (!Object.prototype.hasOwnProperty.call(colors, token)) {
    fail(path, `must reference an existing design.tokens.colors entry (received "${token}")`);
  }
  return token;
}

function validateComponentsV3(
  value: unknown,
  path: string,
  colors: Readonly<Record<string, DesignColor>>,
): DesignComponentsV3 {
  if (!isObject(value)) fail(path, "must be an object");
  exactKeys(
    value,
    ["paragraph", "list", "enumeration", "table", "outline", "callout", "codeBlock"],
    path,
  );

  if (!isObject(value.paragraph)) fail(`${path}.paragraph`, "must be an object");
  exactKeys(value.paragraph, ["align", "hyphenation"], `${path}.paragraph`);
  const paragraph: DesignParagraphComponentV3 = {
    align: validateEnum(
      value.paragraph.align,
      DESIGN_PARAGRAPH_ALIGNMENTS_V3,
      `${path}.paragraph.align`,
    ),
    hyphenation: validateEnum(
      value.paragraph.hyphenation,
      DESIGN_HYPHENATION_MODES_V3,
      `${path}.paragraph.hyphenation`,
    ),
  };

  if (!isObject(value.list)) fail(`${path}.list`, "must be an object");
  exactKeys(value.list, ["bulletPreset", "markerAlign", "markerColor"], `${path}.list`);
  const list: DesignListComponentV3 = {
    bulletPreset: validateEnum(
      value.list.bulletPreset,
      DESIGN_BULLET_PRESETS_V3,
      `${path}.list.bulletPreset`,
    ),
    markerAlign: validateEnum(
      value.list.markerAlign,
      DESIGN_LIST_MARKER_ALIGNMENTS_V3,
      `${path}.list.markerAlign`,
    ),
    ...(value.list.markerColor === undefined
      ? {}
      : {
          markerColor: validateColorTokenReferenceV3(
            value.list.markerColor,
            `${path}.list.markerColor`,
            colors,
          ),
        }),
  };

  if (!isObject(value.enumeration)) fail(`${path}.enumeration`, "must be an object");
  exactKeys(
    value.enumeration,
    ["numberingPreset", "markerAlign", "markerColor"],
    `${path}.enumeration`,
  );
  const enumeration: DesignEnumerationComponentV3 = {
    numberingPreset: validateEnum(
      value.enumeration.numberingPreset,
      DESIGN_ENUMERATION_PRESETS_V3,
      `${path}.enumeration.numberingPreset`,
    ),
    markerAlign: validateEnum(
      value.enumeration.markerAlign,
      DESIGN_LIST_MARKER_ALIGNMENTS_V3,
      `${path}.enumeration.markerAlign`,
    ),
    ...(value.enumeration.markerColor === undefined
      ? {}
      : {
          markerColor: validateColorTokenReferenceV3(
            value.enumeration.markerColor,
            `${path}.enumeration.markerColor`,
            colors,
          ),
        }),
  };

  if (!isObject(value.table)) fail(`${path}.table`, "must be an object");
  exactKeys(
    value.table,
    ["repeatHeader", "banding", "borders", "bandColor", "borderColor"],
    `${path}.table`,
  );
  const table: DesignTableComponentV3 = {
    repeatHeader: validateBoolean(value.table.repeatHeader, `${path}.table.repeatHeader`),
    banding: validateEnum(
      value.table.banding,
      DESIGN_TABLE_BANDING_MODES_V3,
      `${path}.table.banding`,
    ),
    borders: validateEnum(
      value.table.borders,
      DESIGN_TABLE_BORDER_MODES_V3,
      `${path}.table.borders`,
    ),
    ...(value.table.bandColor === undefined
      ? {}
      : {
          bandColor: validateColorTokenReferenceV3(
            value.table.bandColor,
            `${path}.table.bandColor`,
            colors,
          ),
        }),
    ...(value.table.borderColor === undefined
      ? {}
      : {
          borderColor: validateColorTokenReferenceV3(
            value.table.borderColor,
            `${path}.table.borderColor`,
            colors,
          ),
        }),
  };

  if (!isObject(value.outline)) fail(`${path}.outline`, "must be an object");
  exactKeys(value.outline, ["leader", "pageNumbers", "leaderColor"], `${path}.outline`);
  const outline: DesignOutlineComponentV3 = {
    leader: validateEnum(
      value.outline.leader,
      DESIGN_OUTLINE_LEADERS_V3,
      `${path}.outline.leader`,
    ),
    pageNumbers: validateEnum(
      value.outline.pageNumbers,
      DESIGN_OUTLINE_PAGE_NUMBER_MODES_V3,
      `${path}.outline.pageNumbers`,
    ),
    ...(value.outline.leaderColor === undefined
      ? {}
      : {
          leaderColor: validateColorTokenReferenceV3(
            value.outline.leaderColor,
            `${path}.outline.leaderColor`,
            colors,
          ),
        }),
  };

  if (!isObject(value.callout)) fail(`${path}.callout`, "must be an object");
  exactKeys(value.callout, ["preset", "icon", "accentColor"], `${path}.callout`);
  const callout: DesignCalloutComponentV3 = {
    preset: validateEnum(
      value.callout.preset,
      DESIGN_CALLOUT_PRESETS_V3,
      `${path}.callout.preset`,
    ),
    icon: validateEnum(value.callout.icon, DESIGN_VISIBILITIES, `${path}.callout.icon`),
    ...(value.callout.accentColor === undefined
      ? {}
      : {
          accentColor: validateColorTokenReferenceV3(
            value.callout.accentColor,
            `${path}.callout.accentColor`,
            colors,
          ),
        }),
  };

  if (!isObject(value.codeBlock)) fail(`${path}.codeBlock`, "must be an object");
  exactKeys(
    value.codeBlock,
    ["wrap", "lineNumbers", "backgroundColor"],
    `${path}.codeBlock`,
  );
  const codeBlock: DesignCodeBlockComponentV3 = {
    wrap: validateEnum(
      value.codeBlock.wrap,
      DESIGN_CODE_WRAP_MODES_V3,
      `${path}.codeBlock.wrap`,
    ),
    lineNumbers: validateEnum(
      value.codeBlock.lineNumbers,
      DESIGN_VISIBILITIES,
      `${path}.codeBlock.lineNumbers`,
    ),
    ...(value.codeBlock.backgroundColor === undefined
      ? {}
      : {
          backgroundColor: validateColorTokenReferenceV3(
            value.codeBlock.backgroundColor,
            `${path}.codeBlock.backgroundColor`,
            colors,
          ),
        }),
  };

  return { paragraph, list, enumeration, table, outline, callout, codeBlock };
}

function validateOpaqueJsonV3(
  value: unknown,
  path: string,
  state: { nodes: number },
  depth = 0
): unknown {
  state.nodes += 1;
  if (state.nodes > V3_JSON_MAX_NODES) fail(path, `must contain at most ${V3_JSON_MAX_NODES} nodes`);
  if (depth > V3_JSON_MAX_DEPTH) fail(path, `must be at most ${V3_JSON_MAX_DEPTH} levels deep`);
  if (value === null) fail(path, "must not be null");
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must be finite");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > V3_JSON_MAX_ARRAY) fail(path, `must contain at most ${V3_JSON_MAX_ARRAY} items`);
    return value.map((entry, index) => validateOpaqueJsonV3(entry, `${path}[${index}]`, state, depth + 1));
  }
  if (!isObject(value)) fail(path, "must be portable JSON data");
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    assertSafeIdentifier(key, `${path}.${key}`);
    result[key] = validateOpaqueJsonV3(entry, `${path}.${key}`, state, depth + 1);
  }
  return result;
}

function validateOpaqueRecordV3(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isObject(value)) fail(path, "must be an object");
  return validateOpaqueJsonV3(value, path, { nodes: 0 }) as Record<string, unknown>;
}

/** Exact Catalog-V3 page/running validation; T4-T6 tighten the remaining objects. */
export function validatePdfTemplateDesignV3(
  value: unknown,
  path = "design"
): WikiPdfTemplateDesignV3 {
  if (!isObject(value)) fail(path, "must be an object");
  exactKeys(
    value,
    [
      "page",
      "branding",
      "typography",
      "tokens",
      "semanticPalettes",
      "compositions",
      "navigation",
      "components",
      "paints",
      "decorations",
    ],
    path
  );
  const tokens = validateTokens(value.tokens, `${path}.tokens`);
  const design: WikiPdfTemplateDesignV3 = {
    page: validatePageV3(value.page, `${path}.page`),
    branding: validateBranding(value.branding, `${path}.branding`),
    typography: validateTypography(value.typography, `${path}.typography`),
    tokens,
    semanticPalettes: validateSemanticPalettes(value.semanticPalettes, `${path}.semanticPalettes`),
    compositions: validatePageCompositionsV3(value.compositions, `${path}.compositions`),
    navigation: validateNavigationV3(value.navigation, `${path}.navigation`),
    components: validateComponentsV3(
      value.components,
      `${path}.components`,
      tokens.colors,
    ),
    ...(value.paints === undefined
      ? {}
      : { paints: validateOpaqueRecordV3(value.paints, `${path}.paints`) }),
    ...(value.decorations === undefined
      ? {}
      : {
          decorations: validateOpaqueJsonV3(
            value.decorations,
            `${path}.decorations`,
            { nodes: 0 }
          ) as readonly unknown[],
        }),
  };
  validateCompositionBranding(
    design as unknown as WikiPdfTemplateDesignV1,
    path
  );
  return design;
}
