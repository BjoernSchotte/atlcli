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
  header: { enabled: boolean };
  footer: { enabled: boolean };
  closingPage: { enabled: boolean };
}

export interface DesignBranding {
  accent: DesignColor;
  organizationName?: string;
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
const UNSAFE_STRING_RE = /[\u0000-\u001f#{}\\"`$]/;
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
  if (value.length > SAFE_STRING_MAX) fail(path, `must be at most ${SAFE_STRING_MAX} characters`);
  if (UNSAFE_STRING_RE.test(value)) fail(path, "must not contain Typst source metacharacters");
  return value;
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

function validateIdentifierMap<T>(
  value: unknown,
  path: string,
  each: (v: unknown, p: string) => T
): Record<string, T> {
  if (!isObject(value)) fail(path, "must be an object");
  const out: Record<string, T> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!IDENTIFIER_RE.test(key)) fail(`${path}.${key}`, "key must be a safe identifier");
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
  };
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
    header: { enabled: validateBoolean(header.enabled, `${path}.header.enabled`) },
    footer: { enabled: validateBoolean(footer.enabled, `${path}.footer.enabled`) },
    closingPage: { enabled: validateBoolean(closingPage.enabled, `${path}.closingPage.enabled`) },
  };
}

function validateBranding(value: unknown, path: string): DesignBranding {
  if (!isObject(value)) fail(path, "must be an object");
  const branding: DesignBranding = { accent: validateDesignColor(value.accent, `${path}.accent`) };
  if (value.organizationName !== undefined) {
    branding.organizationName = validateSafeString(value.organizationName, `${path}.organizationName`);
  }
  return branding;
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
