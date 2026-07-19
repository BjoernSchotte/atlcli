/**
 * Level-A PDF template settings: validation, defaulting, and Typst emission.
 *
 * `resolvePdfSettings` mirrors `resolvePdfTheme`'s throw-on-invalid style: it
 * rejects (never silently clamps) out-of-range or malformed values, naming the
 * offending field through a structured `PdfSettingsError`. `typstSettingsDict`
 * emits the resolved values as a Typst dictionary literal — every host-supplied
 * string passes through `typstString` from `escape.ts`, so a settings value can
 * never inject Typst source (007 PLAN "Settings become code injection" STOP
 * condition).
 *
 * The logo asset is validated here (PNG magic bytes / sanitized SVG / size cap /
 * required alt) but is intentionally *not* emitted into the settings dictionary
 * yet: threading its bytes through the asset pipeline and placing the image is
 * the template-rendering task (T2.2), a strictly additive follow-up.
 */
import { normalizeExportColor } from "@atlcli/confluence";
import { typstString } from "./escape.js";
import type { PdfLogoAsset, PdfTemplateSettings, PdfWatermarkSettings } from "./types.js";

/** Structured validation failure naming the exact offending settings field. */
export class PdfSettingsError extends Error {
  readonly path: string;
  readonly value: unknown;
  readonly constraint: string;

  constructor(options: { path: string; value: unknown; constraint: string }) {
    super(`Invalid PDF setting at ${options.path}: ${options.constraint}`);
    this.name = "PdfSettingsError";
    this.path = options.path;
    this.value = options.value;
    this.constraint = options.constraint;
  }
}

export interface ResolvedPdfWatermark {
  text: string;
  color: string;
  opacity: number;
  angle: number;
  size: number;
}

export interface ResolvedPdfLogo {
  bytes: Uint8Array;
  mediaType: "image/png" | "image/svg+xml";
  alt: string;
}

/** Fully-defaulted internal settings ready for Typst emission. */
export interface ResolvedPdfSettings {
  page: "a4" | "letter";
  orientation: "portrait" | "landscape";
  cover: boolean;
  outline: boolean;
  headerText?: string;
  footerText?: string;
  accentColor: string;
  organizationName?: string;
  logo?: ResolvedPdfLogo;
  watermark?: ResolvedPdfWatermark;
}

export const DEFAULT_PDF_ACCENT_COLOR = "#4B57A3";
export const DEFAULT_PDF_WATERMARK_COLOR = "#DE350B";
export const DEFAULT_PDF_WATERMARK_OPACITY = 0.08;
export const DEFAULT_PDF_WATERMARK_ANGLE = -54;
export const DEFAULT_PDF_WATERMARK_SIZE = 96;

const TEXT_MAX_LENGTH = 200;
const LOGO_MAX_BYTES = 5 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function reject(path: string, value: unknown, constraint: string): never {
  throw new PdfSettingsError({ path, value, constraint });
}

function resolveEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  path: string
): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    reject(path, value, `must be one of ${allowed.map((entry) => `"${entry}"`).join(", ")}`);
  }
  return value as T;
}

function resolveBoolean(value: boolean | undefined, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") reject(path, value, "must be a boolean");
  return value;
}

function resolveText(value: string | undefined, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") reject(path, value, "must be a string");
  if (value.length > TEXT_MAX_LENGTH) {
    reject(path, value, `must be at most ${TEXT_MAX_LENGTH} characters`);
  }
  return value;
}

function resolveColor(value: string | undefined, fallback: string, path: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") reject(path, value, "must be a color string");
  const normalized = normalizeExportColor(value);
  if (!normalized) reject(path, value, "must be a valid color");
  return normalized;
}

function resolveBoundedNumber(
  value: number | undefined,
  fallback: number,
  bounds: { min: number; minInclusive: boolean; max: number },
  path: string
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    reject(path, value, "must be a finite number");
  }
  const aboveMin = bounds.minInclusive ? value >= bounds.min : value > bounds.min;
  if (!aboveMin || value > bounds.max) {
    const lower = bounds.minInclusive ? `[${bounds.min}` : `(${bounds.min}`;
    reject(path, value, `must be within ${lower}, ${bounds.max}]`);
  }
  return value;
}

function resolveWatermark(watermark: PdfWatermarkSettings): ResolvedPdfWatermark {
  if (typeof watermark.text !== "string" || watermark.text.trim() === "") {
    reject("watermark.text", watermark.text, "must be a non-empty string");
  }
  return {
    text: watermark.text,
    color: resolveColor(watermark.color, DEFAULT_PDF_WATERMARK_COLOR, "watermark.color"),
    opacity: resolveBoundedNumber(
      watermark.opacity,
      DEFAULT_PDF_WATERMARK_OPACITY,
      { min: 0, minInclusive: false, max: 1 },
      "watermark.opacity"
    ),
    angle: resolveBoundedNumber(
      watermark.angle,
      DEFAULT_PDF_WATERMARK_ANGLE,
      { min: -180, minInclusive: true, max: 180 },
      "watermark.angle"
    ),
    size: resolveBoundedNumber(
      watermark.size,
      DEFAULT_PDF_WATERMARK_SIZE,
      { min: 8, minInclusive: true, max: 400 },
      "watermark.size"
    ),
  };
}

function hasPngMagic(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_MAGIC.length && PNG_MAGIC.every((byte, index) => bytes[index] === byte);
}

function assertSafeSvg(bytes: Uint8Array): void {
  const source = new TextDecoder().decode(bytes);
  if (!/<svg(?:\s|>)/i.test(source.replace(/^﻿/, "").trimStart())) {
    reject("logo.bytes", undefined, "SVG bytes do not contain an <svg> root element");
  }
  // Mirrors the export asset sanitizer in prepare.ts: reject scripts, embedded
  // HTML, event handlers, and externally loaded (http/data) references.
  if (
    /<\s*(?:script|foreignObject)\b/i.test(source) ||
    /\son[a-z]+\s*=/i.test(source) ||
    /(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|data:)/i.test(source)
  ) {
    reject("logo.bytes", undefined, "SVG contains active or externally loaded content");
  }
}

function resolveLogo(logo: PdfLogoAsset): ResolvedPdfLogo {
  if (!(logo.bytes instanceof Uint8Array) || logo.bytes.byteLength === 0) {
    reject("logo.bytes", logo.bytes, "must be non-empty bytes");
  }
  if (logo.bytes.byteLength > LOGO_MAX_BYTES) {
    reject("logo.bytes", logo.bytes.byteLength, "must be at most 5 MiB");
  }
  if (logo.mediaType !== "image/png" && logo.mediaType !== "image/svg+xml") {
    reject("logo.mediaType", logo.mediaType, 'must be "image/png" or "image/svg+xml"');
  }
  if (logo.mediaType === "image/png") {
    if (!hasPngMagic(logo.bytes)) {
      reject("logo.bytes", logo.mediaType, "bytes do not match the declared PNG media type");
    }
  } else {
    assertSafeSvg(logo.bytes);
  }
  if (logo.alt === undefined || (typeof logo.alt === "string" && logo.alt.trim() === "")) {
    reject("logo.alt", logo.alt, "a present logo requires a non-empty alt text");
  }
  if (typeof logo.alt !== "string") reject("logo.alt", logo.alt, "must be a string");
  return { bytes: logo.bytes, mediaType: logo.mediaType, alt: logo.alt };
}

/**
 * Validate and default a partial public settings object into the complete
 * internal render settings. Throws {@link PdfSettingsError} on any invalid
 * value — this function never clamps.
 */
export function resolvePdfSettings(options: PdfTemplateSettings = {}): ResolvedPdfSettings {
  const resolved: ResolvedPdfSettings = {
    page: resolveEnum(options.page, ["a4", "letter"] as const, "a4", "page"),
    orientation: resolveEnum(
      options.orientation,
      ["portrait", "landscape"] as const,
      "portrait",
      "orientation"
    ),
    cover: resolveBoolean(options.cover, true, "cover"),
    outline: resolveBoolean(options.outline, true, "outline"),
    accentColor: resolveColor(options.accentColor, DEFAULT_PDF_ACCENT_COLOR, "accentColor"),
  };

  const headerText = resolveText(options.headerText, "headerText");
  if (headerText !== undefined) resolved.headerText = headerText;
  const footerText = resolveText(options.footerText, "footerText");
  if (footerText !== undefined) resolved.footerText = footerText;
  const organizationName = resolveText(options.organizationName, "organizationName");
  if (organizationName !== undefined) resolved.organizationName = organizationName;
  if (options.logo !== undefined) resolved.logo = resolveLogo(options.logo);
  if (options.watermark !== undefined) resolved.watermark = resolveWatermark(options.watermark);

  return resolved;
}

function numberLiteral(value: number): string {
  // Validated finite; avoid exponential/`Infinity` forms in Typst source.
  return Object.is(value, -0) ? "0" : String(value);
}

/**
 * Emit the resolved settings as a Typst dictionary literal. Every host-supplied
 * string is escaped through `typstString`; kebab-case keys match the template's
 * defensive `settings.at("...")` reads (e.g. `headerText` → `header-text`).
 *
 * The logo is emitted as a virtual-filesystem *path* (plus its alt text), not
 * as bytes: `serializePdfDocument` adds the validated bytes to the bundle's
 * assets under that path and passes the path in via `options.logoPath`. Without
 * a `logoPath` the logo entry is omitted entirely.
 */
export function typstSettingsDict(
  resolved: ResolvedPdfSettings,
  options: { logoPath?: string } = {}
): string {
  const lines: string[] = [
    `  page: ${typstString(resolved.page)},`,
    `  orientation: ${typstString(resolved.orientation)},`,
    `  cover: ${resolved.cover ? "true" : "false"},`,
    `  outline: ${resolved.outline ? "true" : "false"},`,
    `  accent-color: ${typstString(resolved.accentColor)},`,
  ];
  if (resolved.headerText !== undefined) {
    lines.push(`  header-text: ${typstString(resolved.headerText)},`);
  }
  if (resolved.footerText !== undefined) {
    lines.push(`  footer-text: ${typstString(resolved.footerText)},`);
  }
  if (resolved.organizationName !== undefined) {
    lines.push(`  organization-name: ${typstString(resolved.organizationName)},`);
  }
  if (resolved.logo && options.logoPath !== undefined) {
    lines.push(
      `  logo: ${typstString(options.logoPath)},`,
      `  logo-alt: ${typstString(resolved.logo.alt)},`
    );
  }
  if (resolved.watermark) {
    const watermark = resolved.watermark;
    lines.push(
      "  watermark: (",
      `    text: ${typstString(watermark.text)},`,
      `    color: ${typstString(watermark.color)},`,
      `    opacity: ${numberLiteral(watermark.opacity)},`,
      `    angle: ${numberLiteral(watermark.angle)},`,
      `    size: ${numberLiteral(watermark.size)},`,
      "  ),"
    );
  }
  return `(\n${lines.join("\n")}\n)`;
}
