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
import { decodeSvgSource, normalizeExportColor } from "@atlcli/confluence";
import {
  flattenDesign,
  localeChain,
  ManifestValidationError,
  unflattenDesign,
  validateDesignAgainstCatalog,
  WIKI_PDF_SUPPORTED_DOCUMENT_LABELS,
  WIKI_PDF_V1_DOCUMENT_LABELS,
  type TemplateManifest,
  type TemplateCapabilityCatalogReferenceV1,
  type WikiPdfTemplateDesignV1,
  type WikiPdfTemplateSettingBindingV1,
} from "@atlcli/template-pack";
import { BUILTIN_PDF_TEMPLATE_MANIFEST } from "./builtin-template.js";
import { getBuiltinPdfTemplate } from "./curated-templates.js";
import {
  PDF_TEMPLATE_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
  PDF_TEMPLATE_LEGACY_FALLBACK_ALIASES_V1,
  materializeLegacyPdfDesign,
  projectPdfDesignThroughCatalog,
  writePdfDesignCapability,
} from "./design-catalog.js";
import {
  pdfCatalogRuntimeReference,
  resolvePdfCatalogRuntime,
  type PdfCatalogRuntime,
} from "./catalog-runtime.js";
import { typstString } from "./escape.js";
import { findSvgSafetyViolation } from "./svg-safety.js";
import { resolvePdfTheme } from "./theme.js";
import type {
  PdfLogoAsset,
  PdfTemplateSettings,
  PdfThemeOptions,
  PdfWatermarkSettings,
} from "./types.js";
import type {
  PdfTemplateVisualsV1,
  ValidatedPdfTemplatePackV1,
} from "./template-pack.js";

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

/** The document-facing labels resolved for the export's locale (spec 012). */
export type ResolvedPdfLabels = Record<string, string>;

/** The fully resolved, bound design (spec 012) — same shape as the manifest's. */
export type ResolvedPdfDesign = WikiPdfTemplateDesignV1;

export const PDF_BINDABLE_LEVEL_A_SETTINGS = [
  "accentColor",
  "organizationName",
  "page",
  "orientation",
  "cover",
  "outline",
] as const;
export type PdfBindableLevelASetting = (typeof PDF_BINDABLE_LEVEL_A_SETTINGS)[number];
export type PdfSettingPresenceMask = Readonly<Record<PdfBindableLevelASetting, boolean>>;

export interface PdfDesignResolutionTraceEntry {
  target: string;
  source: "baseline" | "engine-policy" | "runtime-binding";
  sourceId: string;
  sequence: number;
  value: unknown;
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
  /**
   * The resolved presentation model (spec 012 T6.2): the manifest's `design`
   * with declared bindings applied and the theme's ink/paper injected. The
   * template consumes this — static tokens interpolated when the template
   * string is generated, the settings-driven subset read from the emitted
   * `settings.design` dict at Typst runtime.
   */
  design: ResolvedPdfDesign;
  /** Raw Level-A key presence; normalized defaults never masquerade as input. */
  settingPresence: PdfSettingPresenceMask;
  /** Ordered writes for every effective catalog target. */
  designTrace: readonly PdfDesignResolutionTraceEntry[];
  /** Unknown legacy leaves that were structurally readable but not executed. */
  ignoredDesignCapabilities: readonly string[];
  /** Catalog contract pinned into future authoring snapshots/projects. */
  capabilityCatalogDigest: string;
  /** Exact closed runtime identity; digest alone is never a dispatch key. */
  capabilityCatalog: TemplateCapabilityCatalogReferenceV1;
  /** Document-facing labels for the export locale (spec 012 T6.2). */
  labels: ResolvedPdfLabels;
  /** Validated visual slots and decorations, with compiler-owned VFS paths. */
  templateVisuals?: PdfTemplateVisualsV1;
}

/** Context that drives design binding + label resolution (spec 012 T6.2). */
export interface ResolvePdfSettingsContext {
  /** Document locale for label resolution (from `metadata.language`). */
  locale?: string;
  /** Region for locale resolution (from `metadata.region`). */
  region?: string;
  /** Theme whose ink/paper are injected into the resolved design tokens. */
  theme?: PdfThemeOptions;
  /** Template manifest driving resolution; defaults to the built-in. */
  manifest?: TemplateManifest;
  /** Validated pack supplying the manifest plus resolved visual payloads. */
  templatePack?: ValidatedPdfTemplatePackV1;
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
  // Count Unicode code points, not UTF-16 code units, so astral characters
  // (emoji, rare CJK) are not double-counted against the cap.
  if ([...value].length > TEXT_MAX_LENGTH) {
    reject(path, value, `must be at most ${TEXT_MAX_LENGTH} Unicode code points`);
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
  // BOM-aware decode so a UTF-16 logo SVG cannot hide active content (spec 011).
  const source = decodeSvgSource(bytes);
  if (!/<svg(?:\s|>)/i.test(source.replace(/^﻿/, "").trimStart())) {
    reject("logo.bytes", undefined, "SVG bytes do not contain an <svg> root element");
  }
  const violation = findSvgSafetyViolation(source);
  if (violation) {
    reject("logo.bytes", undefined, `unsafe SVG (${violation.rule}): ${violation.detail}`);
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
    reject(
      "logo.mediaType",
      logo.mediaType,
      'must be "image/png" or "image/svg+xml"'
    );
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

// Objects produced by resolvePdfSettings, so a second resolve pass (e.g.
// runPdfExport validates first, serializePdfDocument receives the result) is
// an identity no-op instead of re-running validation and the logo byte scan.
const resolvedSettings = new WeakSet<ResolvedPdfSettings>();

/**
 * Validate and default a partial public settings object into the complete
 * internal render settings. Throws {@link PdfSettingsError} on any invalid
 * value — this function never clamps. Passing an object this function already
 * returned short-circuits and returns it unchanged.
 *
 * The seven-step resolution (007 Risks "Built-in vs. manifest settings"):
 * manifest defaults → persisted host values → per-export overrides →
 * validation/normalization → **apply declared bindings to an immutable design
 * copy** → **document-locale selection + label resolution** → asset resolution.
 */
export function resolvePdfSettings(
  options: PdfTemplateSettings = {},
  context: ResolvePdfSettingsContext = {}
): ResolvedPdfSettings {
  if (resolvedSettings.has(options as ResolvedPdfSettings)) {
    return options as ResolvedPdfSettings;
  }
  const settingPresence = Object.freeze(
    Object.fromEntries(
      PDF_BINDABLE_LEVEL_A_SETTINGS.map((setting) => [
        setting,
        Object.prototype.hasOwnProperty.call(options, setting),
      ])
    ) as Record<PdfBindableLevelASetting, boolean>
  );
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
    // Placeholders; filled in below once the Level-A values exist.
    design: undefined as unknown as ResolvedPdfDesign,
    settingPresence,
    designTrace: [],
    ignoredDesignCapabilities: [],
    capabilityCatalogDigest: PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
    capabilityCatalog: pdfCatalogRuntimeReference(resolvePdfCatalogRuntime()),
    labels: {},
  };

  const headerText = resolveText(options.headerText, "headerText");
  if (headerText !== undefined) resolved.headerText = headerText;
  const footerText = resolveText(options.footerText, "footerText");
  if (footerText !== undefined) resolved.footerText = footerText;
  const organizationName = resolveText(options.organizationName, "organizationName");
  if (organizationName !== undefined) resolved.organizationName = organizationName;
  const packLogo = context.templatePack?.assets["asset.logo"];
  if (options.logo !== undefined) {
    resolved.logo = resolveLogo(options.logo);
  } else if (packLogo) {
    if (packLogo.descriptor.mediaType === "image/jpeg") {
      reject(
        "templatePack.assets.asset.logo.mediaType",
        packLogo.descriptor.mediaType,
        "logo slots support PNG or SVG"
      );
    }
    resolved.logo = resolveLogo({
      bytes: packLogo.bytes,
      mediaType: packLogo.descriptor.mediaType,
      alt: packLogo.reference.alt,
    });
  }
  if (options.watermark !== undefined) resolved.watermark = resolveWatermark(options.watermark);

  const manifest =
    context.templatePack?.manifest ??
    context.manifest ??
    BUILTIN_PDF_TEMPLATE_MANIFEST;
  const designResolution = resolveTemplateDesignWithTrace(
    manifest,
    resolved,
    context.theme
  );
  resolved.design = designResolution.design;
  resolved.designTrace = designResolution.trace;
  resolved.ignoredDesignCapabilities = designResolution.ignoredCapabilities;
  resolved.capabilityCatalogDigest = designResolution.capabilityCatalogDigest;
  resolved.capabilityCatalog = designResolution.capabilityCatalog;
  resolved.labels = resolveTemplateLabels(manifest, context.locale, context.region);
  if (context.templatePack) {
    resolved.templateVisuals = {
      assets: Object.fromEntries(
        Object.entries(context.templatePack.assets).map(([slot, asset]) => [
          slot,
          { vfsPath: asset.vfsPath, reference: asset.reference },
        ])
      ),
      decorations: context.templatePack.decorations,
    };
  }

  resolvedSettings.add(resolved);
  return resolved;
}

/**
 * Build the resolved design: the manifest's design with declared bindings
 * applied and the theme's ink/paper injected. Pure — never mutates the
 * manifest's design.
 */
export function resolveTemplateDesign(
  manifest: TemplateManifest,
  values: ResolvedPdfSettings,
  themeOptions?: PdfThemeOptions
): ResolvedPdfDesign {
  return resolveTemplateDesignWithTrace(manifest, values, themeOptions).design;
}

export interface ResolvedTemplateDesignWithTrace {
  design: ResolvedPdfDesign;
  trace: readonly PdfDesignResolutionTraceEntry[];
  ignoredCapabilities: readonly string[];
  capabilityCatalogDigest: string;
  capabilityCatalog: TemplateCapabilityCatalogReferenceV1;
}

/**
 * Resolve one executable catalog snapshot and retain every ordered writer.
 * Known curated ids may use their characterized baseline as an explicit legacy
 * compatibility adapter; a foreign sparse manifest remains readable but cannot
 * execute.
 */
export function resolveTemplateDesignWithTrace(
  manifest: TemplateManifest,
  values: ResolvedPdfSettings,
  themeOptions?: PdfThemeOptions
): ResolvedTemplateDesignWithTrace {
  if (!manifest.design) {
    throw new PdfSettingsError({
      path: "manifest.design",
      value: undefined,
      constraint: "template manifest has no design block",
    });
  }

  let runtime: PdfCatalogRuntime;
  try {
    runtime = resolvePdfCatalogRuntime(manifest.capabilityCatalog);
  } catch (error) {
    throw new PdfSettingsError({
      path: "manifest.capabilityCatalog",
      value: manifest.capabilityCatalog,
      constraint: error instanceof Error ? error.message : "unsupported PDF capability catalog",
    });
  }

  if (!runtime.allowsSparseLegacy) {
    const baseline = runtime.project(manifest.design);
    const trace: PdfDesignResolutionTraceEntry[] = Object.entries(
      flattenDesign(baseline)
    ).map(([target, value], sequence) => ({
      target,
      source: "baseline",
      sourceId: manifest.id,
      sequence,
      value,
    }));
    const bound = applyBindingsWithTraceForCatalog(
      baseline,
      manifest.bindings ?? [],
      values,
      trace,
      runtime.project,
      runtime.write
    );
    const themed = applyThemePolicy(
      bound.design,
      bound.trace,
      themeOptions,
      runtime.write
    );
    return {
      design: runtime.project(themed.design),
      trace: themed.trace,
      ignoredCapabilities: [],
      capabilityCatalogDigest: runtime.reference.digest,
      capabilityCatalog: pdfCatalogRuntimeReference(runtime),
    };
  }

  const characterizedBaseline = getBuiltinPdfTemplate(manifest.id)?.design;
  let baseline: ResolvedPdfDesign;
  let ignoredCapabilities: readonly string[];
  if (characterizedBaseline) {
    const materialized = materializeLegacyPdfDesign(
      manifest.design,
      characterizedBaseline,
      PDF_TEMPLATE_LEGACY_FALLBACK_ALIASES_V1
    );
    baseline = materialized.design;
    ignoredCapabilities = materialized.ignoredCapabilities;
  } else {
    const validation = validateDesignAgainstCatalog(
      manifest.design,
      PDF_TEMPLATE_CAPABILITIES_V1,
      "legacy"
    );
    const missing = validation.missingCapabilities[0];
    if (missing) {
      throw new PdfSettingsError({
        path: missing,
        value: undefined,
        constraint:
          "foreign sparse template is structurally readable but not canonical-executable",
      });
    }
    baseline = projectPdfDesignThroughCatalog(
      unflattenDesign(validation.flat) as unknown as WikiPdfTemplateDesignV1
    );
    ignoredCapabilities = validation.ignoredCapabilities;
  }

  const trace: PdfDesignResolutionTraceEntry[] = Object.entries(
    flattenDesign(baseline)
  ).map(([target, value], sequence) => ({
    target,
    source: "baseline",
    sourceId: manifest.id,
    sequence,
    value,
  }));
  const bound = applyBindingsWithTrace(
    baseline,
    manifest.bindings ?? [],
    values,
    trace
  );

  const themed = applyThemePolicy(
    bound.design,
    bound.trace,
    themeOptions,
    writePdfDesignCapability
  );
  return {
    design: projectPdfDesignThroughCatalog(themed.design),
    trace: themed.trace,
    ignoredCapabilities,
    capabilityCatalogDigest: PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
    capabilityCatalog: pdfCatalogRuntimeReference(runtime),
  };
}

function applyThemePolicy(
  initialDesign: WikiPdfTemplateDesignV1,
  initialTrace: readonly PdfDesignResolutionTraceEntry[],
  themeOptions: PdfThemeOptions | undefined,
  writeCapability: typeof writePdfDesignCapability
): {
  design: WikiPdfTemplateDesignV1;
  trace: readonly PdfDesignResolutionTraceEntry[];
} {
  let design = initialDesign;
  const nextTrace = [...initialTrace];
  // Resolve the complete theme to validate every supplied theme field, but
  // project only explicitly present fields into the design.
  const theme = resolvePdfTheme(themeOptions);
  const policyWrites: Array<{
    present: boolean;
    sourceId: string;
    target: string;
    value: unknown;
  }> = [
    {
      present: Object.prototype.hasOwnProperty.call(themeOptions?.colors ?? {}, "ink"),
      sourceId: "theme.colors.ink",
      target: "tokens.colors.ink",
      value: theme.colors.ink,
    },
    {
      present: Object.prototype.hasOwnProperty.call(themeOptions?.colors ?? {}, "paper"),
      sourceId: "theme.colors.paper",
      target: "tokens.colors.paper",
      value: theme.colors.paper,
    },
    {
      present: Object.prototype.hasOwnProperty.call(
        themeOptions?.table?.coloredCellText ?? {},
        "minimumContrast"
      ),
      sourceId: "theme.table.coloredCellText.minimumContrast",
      target: "tokens.contrast.minimum",
      value: theme.table.coloredCellText.minimumContrast,
    },
  ];
  for (const write of policyWrites) {
    if (!write.present) continue;
    design = writeCapability(
      design,
      write.target,
      write.value,
      write.sourceId
    );
    nextTrace.push({
      target: write.target,
      source: "engine-policy",
      sourceId: write.sourceId,
      sequence: nextTrace.length,
      value: write.value,
    });
  }
  return { design, trace: nextTrace };
}

/** The Level-A resolved value a binding's `setting` reads. */
function bindingSourceValue(setting: string, values: ResolvedPdfSettings): unknown {
  switch (setting) {
    case "accentColor":
      return values.accentColor;
    case "organizationName":
      return values.organizationName;
    case "page":
      return values.page;
    case "orientation":
      return values.orientation;
    case "cover":
      return values.cover;
    case "outline":
      return values.outline;
    default:
      return undefined;
  }
}

/**
 * Apply declared bindings to a deep copy of `design`. One allowlisted write per
 * binding target; two bindings writing the same path is a validation error, not
 * last-write-wins. An `undefined` source value leaves the manifest default in
 * place (e.g. an unset organization name).
 */
export function applyBindings(
  design: WikiPdfTemplateDesignV1,
  bindings: WikiPdfTemplateSettingBindingV1[],
  values: ResolvedPdfSettings
): WikiPdfTemplateDesignV1 {
  return applyBindingsWithTrace(design, bindings, values).design;
}

export function applyBindingsWithTrace(
  design: WikiPdfTemplateDesignV1,
  bindings: WikiPdfTemplateSettingBindingV1[],
  values: ResolvedPdfSettings,
  initialTrace: readonly PdfDesignResolutionTraceEntry[] = []
): {
  design: WikiPdfTemplateDesignV1;
  trace: readonly PdfDesignResolutionTraceEntry[];
} {
  return applyBindingsWithTraceForCatalog(
    design,
    bindings,
    values,
    initialTrace,
    projectPdfDesignThroughCatalog,
    writePdfDesignCapability
  );
}

function applyBindingsWithTraceForCatalog(
  design: WikiPdfTemplateDesignV1,
  bindings: WikiPdfTemplateSettingBindingV1[],
  values: ResolvedPdfSettings,
  initialTrace: readonly PdfDesignResolutionTraceEntry[],
  projectDesign: (design: WikiPdfTemplateDesignV1) => WikiPdfTemplateDesignV1,
  writeCapability: typeof writePdfDesignCapability
): {
  design: WikiPdfTemplateDesignV1;
  trace: readonly PdfDesignResolutionTraceEntry[];
} {
  let copy = projectDesign(design);
  const trace = [...initialTrace];
  const written = new Set<string>();
  for (const binding of bindings) {
    const setting = binding.setting as PdfBindableLevelASetting;
    if (!PDF_BINDABLE_LEVEL_A_SETTINGS.includes(setting)) continue;
    if (!values.settingPresence[setting]) continue;
    const source = bindingSourceValue(binding.setting, values);
    if (source === undefined) continue;
    const value = applyTransform(binding, source);
    for (const target of binding.targets) {
      if (written.has(target)) {
        throw new ManifestValidationError(
          "shape-error",
          `binding target "${target}" is written by more than one binding`,
          target
        );
      }
      written.add(target);
      const writerId = `setting.${binding.setting}`;
      copy = writeCapability(copy, target, value, writerId);
      trace.push({
        target,
        source: "runtime-binding",
        sourceId: writerId,
        sequence: trace.length,
        value,
      });
    }
  }
  return { design: copy, trace };
}

function applyTransform(binding: WikiPdfTemplateSettingBindingV1, source: unknown): unknown {
  const transform = binding.transform ?? { kind: "identity" };
  if (transform.kind === "identity") return source;
  const key = String(source);
  if (!(key in transform.map)) {
    throw new ManifestValidationError(
      "shape-error",
      `choice-map for setting "${binding.setting}" has no entry for value "${key}"`,
      binding.setting
    );
  }
  return transform.map[key];
}

/**
 * Resolve the document-facing labels for the export locale, merging the
 * locale-fallback chain (exact → base language → default → fallback). The
 * validated manifest guarantees a complete fallback locale, so every required
 * label resolves to a non-empty string.
 */
export function resolveTemplateLabels(
  manifest: TemplateManifest,
  locale: string | undefined,
  region: string | undefined
): ResolvedPdfLabels {
  const labels: ResolvedPdfLabels = {};
  const localization = manifest.localization;
  if (!localization) return labels;
  const requested = [locale, region].filter(Boolean).join("-") || locale;
  // Walk lowest → highest priority so higher-priority copy wins on merge.
  const chain = localeChain(localization, requested).reverse();
  // Only the declared document-label vocabulary is resolved. A manifest key
  // outside it never reaches Typst emission — defence in depth behind the
  // manifest import gate, so an unexpected key can never become a dictionary
  // key in generated source.
  // Dropped rather than rejected for forward compatibility (a manifest written
  // for a newer engine must still import); `validateLocalization` warns by name
  // at import time so the drop is diagnosable, never silent.
  const vocabulary = new Set<string>(WIKI_PDF_SUPPORTED_DOCUMENT_LABELS);
  for (const bundle of chain) {
    for (const [key, value] of Object.entries(bundle.document ?? {})) {
      if (!vocabulary.has(key)) continue;
      labels[key] = value;
    }
  }
  for (const key of WIKI_PDF_V1_DOCUMENT_LABELS) {
    if (labels[key] === undefined) labels[key] = "";
  }
  return labels;
}

function numberLiteral(value: number): string {
  // Validated finite; avoid exponential/`Infinity` forms in Typst source.
  return Object.is(value, -0) ? "0" : String(value);
}

/** Typst dictionary keys we are willing to interpolate unquoted into source. */
const EMITTABLE_KEY_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const EMITTABLE_LENGTH_RE =
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:pt|mm|cm|in)$/;

/**
 * Assert a dictionary key is safe to interpolate into Typst source unquoted.
 * Keys are the one place `typstString` cannot help: a key is emitted bare, so
 * an unvalidated key (`x: panic("pwned"), y`) would escape the key position and
 * be evaluated as code.
 */
function assertEmittableKey(key: string, namespace: string): void {
  if (!EMITTABLE_KEY_RE.test(key)) {
    throw new PdfSettingsError({
      path: `${namespace}.${key}`,
      value: key,
      constraint: "dictionary key must be a safe identifier ([A-Za-z][A-Za-z0-9]*)",
    });
  }
}

function emittableLength(value: string, path: string): string {
  if (!EMITTABLE_LENGTH_RE.test(value)) {
    throw new PdfSettingsError({
      path,
      value,
      constraint: "length must be a finite pt/mm/cm/in literal",
    });
  }
  return value;
}

/**
 * Emit the resolved settings as a Typst dictionary literal. Every host-supplied
 * string is escaped through `typstString`.
 *
 * Two namespaces carry the migrated presentation model (spec 012):
 * - `design` — the settings-driven subset the template reads at Typst runtime
 *   (accent, organization name, page size/orientation, cover/outline). Static
 *   design (typography, tokens, palettes, layout) is interpolated when the
 *   template string is generated, not emitted here.
 * - `labels` — the document-facing strings for the export locale.
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
  const runtime = resolvePdfCatalogRuntime(resolved.capabilityCatalog);
  if (resolved.capabilityCatalogDigest !== runtime.reference.digest) {
    reject(
      "capabilityCatalogDigest",
      resolved.capabilityCatalogDigest,
      "must match the exact resolved capability catalog identity"
    );
  }
  const catalogDesign = runtime.project(resolved.design);
  const designLines: string[] = [
    "  design: (",
    "    branding: (",
    `      accent: ${typstString(catalogDesign.branding.accent)},`,
  ];
  if (catalogDesign.branding.organizationName !== undefined) {
    designLines.push(
      `      organization-name: ${typstString(catalogDesign.branding.organizationName)},`
    );
  }
  designLines.push(
    "    ),",
    "    page: (",
    `      size: ${typstString(catalogDesign.page.size)},`,
    `      orientation: ${typstString(catalogDesign.page.orientation)},`,
    "    ),",
    "    features: (",
    `      cover: (enabled: ${catalogDesign.features.cover.enabled ? "true" : "false"}),`,
    `      outline: (enabled: ${catalogDesign.features.outline.enabled ? "true" : "false"}, depth: ${numberLiteral(
      catalogDesign.features.outline.depth
    )}),`,
    ...(runtime.supportsClosingPage
      ? [`      closingPage: (enabled: ${catalogDesign.features.closingPage.enabled ? "true" : "false"}),`]
      : []),
    "    ),",
    "  ),"
  );

  const labelLines: string[] = ["  labels: ("];
  for (const [key, value] of Object.entries(resolved.labels)) {
    // Emission guard (defence in depth): a dictionary KEY is interpolated into
    // Typst source unquoted, so only a safe identifier may pass. An unsafe key
    // that somehow slipped past the manifest import gate and the vocabulary
    // filter is a hard failure here, never silently emitted.
    assertEmittableKey(key, "labels");
    labelLines.push(`    ${key}: ${typstString(value)},`);
  }
  labelLines.push("  ),");

  const lines: string[] = [...designLines, ...labelLines];

  if (resolved.headerText !== undefined) {
    lines.push(`  header-text: ${typstString(resolved.headerText)},`);
  }
  if (resolved.footerText !== undefined) {
    lines.push(`  footer-text: ${typstString(resolved.footerText)},`);
  }
  if (resolved.logo && options.logoPath !== undefined) {
    lines.push(
      `  logo: ${typstString(options.logoPath)},`,
      `  logo-alt: ${typstString(resolved.logo.alt)},`
    );
    const placement =
      resolved.templateVisuals?.assets["asset.logo"]?.reference.placement;
    if (placement) {
      lines.push(
        "  logo-placement: (",
        `    relativeTo: ${typstString(placement.relativeTo)},`,
        `    fit: ${typstString(placement.fit ?? "contain")},`,
        `    x: ${emittableLength(
          placement.x,
          "templatePack.assets.asset.logo.placement.x"
        )},`,
        `    y: ${emittableLength(
          placement.y,
          "templatePack.assets.asset.logo.placement.y"
        )},`,
        `    width: ${emittableLength(
          placement.width,
          "templatePack.assets.asset.logo.placement.width"
        )},`,
        `    height: ${emittableLength(
          placement.height,
          "templatePack.assets.asset.logo.placement.height"
        )},`,
        `    rotation: ${numberLiteral(placement.rotation ?? 0)},`,
        "  ),"
      );
    }
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
