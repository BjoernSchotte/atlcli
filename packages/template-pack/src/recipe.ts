/**
 * Browser-safe source contract for declarative PDF template recipes.
 *
 * A recipe contains author-owned data and relative asset references only. It
 * deliberately cannot carry renderer-generated hashes, catalog references,
 * provenance, archive paths, engine entries, canonical Typst, or raw code.
 * Filesystem containment, YAML syntax limits, and duplicate YAML keys remain
 * host-adapter responsibilities because those facts no longer exist in a
 * parsed JavaScript object.
 */
import type { WikiPdfTemplateImageDecorationV1 } from "./assets.js";
import {
  assertSafeIdentifier,
  validateDesign,
  validateSafeString,
  type WikiPdfTemplateDesignV1,
} from "./design.js";
import {
  validateLocalization,
  WIKI_PDF_SUPPORTED_DOCUMENT_LABELS,
  WIKI_PDF_V1_DOCUMENT_LABELS,
  type WikiPdfTemplateLocalizationV1,
} from "./localization.js";
import { ManifestValidationError } from "./manifest-error.js";
import { satisfiesRange } from "./manifest.js";

export const WIKI_PDF_TEMPLATE_RECIPE_SCHEMA_V1 = "wiki.pdf-template-recipe/v1";
export const TYPST_0151_RECIPE_COMPILER_RANGE = ">=0.15.1 <0.16";

export interface PdfTemplateRecipeTemplateV1 {
  id: string;
  name: string;
  version: string;
  compilerRange: string;
}

export type PdfTemplateRecipePlacementV1 =
  WikiPdfTemplateImageDecorationV1["placement"];

export interface PdfTemplateRecipeAssetV1 {
  source: string;
  decorative: boolean;
  alt?: string;
  placement?: PdfTemplateRecipePlacementV1;
}

export interface WikiPdfTemplateRecipeV1 {
  schema: typeof WIKI_PDF_TEMPLATE_RECIPE_SCHEMA_V1;
  template: PdfTemplateRecipeTemplateV1;
  design: WikiPdfTemplateDesignV1;
  localization: WikiPdfTemplateLocalizationV1;
  assets: Readonly<Record<string, PdfTemplateRecipeAssetV1>>;
}

/**
 * Return a distinct, validated recipe object for the 0.15.1 runtime without
 * mutating the author's source object, design, localization, or assets.
 */
export function migratePdfTemplateRecipeToTypst0151V1(
  value: unknown
): WikiPdfTemplateRecipeV1 {
  const recipe = validatePdfTemplateRecipeV1(value);
  if (satisfiesRange("0.15.1", recipe.template.compilerRange)) {
    fail(
      "recipe.template.compilerRange",
      `already accepts Typst 0.15.1 (${recipe.template.compilerRange})`
    );
  }
  return validatePdfTemplateRecipeV1({
    ...structuredClone(recipe),
    template: {
      ...structuredClone(recipe.template),
      compilerRange: TYPST_0151_RECIPE_COMPILER_RANGE,
    },
  });
}

const STABLE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const COMPILER_RANGE_RE = /^(?:(?:>=|<=|>|<|=)?\d+\.\d+(?:\.\d+)?)(?:\s+(?:(?:>=|<=|>|<|=)?\d+\.\d+(?:\.\d+)?))*$/u;
const LENGTH_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:pt|mm|cm|in)$/u;
const MAX_ASSETS = 64;
const MAX_DYNAMIC_ENTRIES = 256;
const MAX_PATH_CODE_POINTS = 512;
const MAX_ABSOLUTE_LENGTH = 1_000_000;

function fail(path: string, message: string): never {
  throw new ManifestValidationError("shape-error", `${path}: ${message}`, path);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !known.has(key));
  if (unknown) fail(`${path}.${unknown}`, "is not recognized");
}

function boundedEntries(value: Record<string, unknown>, path: string, maximum: number): void {
  if (Object.keys(value).length > maximum) {
    fail(path, `must contain at most ${maximum} entries`);
  }
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function finite(value: unknown, path: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(path, `must be a finite number in [${minimum}, ${maximum}]`);
  }
  return value;
}

function length(value: unknown, path: string, allowNegative: boolean): string {
  if (typeof value !== "string" || !LENGTH_RE.test(value)) {
    fail(path, "must be a finite pt/mm/cm/in length");
  }
  const numeric = Number.parseFloat(value);
  if (
    !Number.isFinite(numeric) ||
    Math.abs(numeric) > MAX_ABSOLUTE_LENGTH ||
    (!allowNegative && numeric < 0)
  ) {
    fail(path, `must be ${allowNegative ? "bounded" : "non-negative"}`);
  }
  return value;
}

function portableSourcePath(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length > MAX_PATH_CODE_POINTS ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(path, "must be a safe relative portable path without dot segments");
  }
  return value;
}

function stableId(value: unknown, path: string): string {
  if (typeof value !== "string" || !STABLE_ID_RE.test(value)) {
    fail(path, "must be a stable identifier");
  }
  return value;
}

function validateTemplate(value: unknown, path: string): PdfTemplateRecipeTemplateV1 {
  const template = object(value, path);
  exactKeys(template, ["id", "name", "version", "compilerRange"], path);
  const name = validateSafeString(template.name, `${path}.name`);
  if (typeof template.version !== "string" || !VERSION_RE.test(template.version)) {
    fail(`${path}.version`, "must be a semantic version");
  }
  if (
    typeof template.compilerRange !== "string" ||
    !COMPILER_RANGE_RE.test(template.compilerRange)
  ) {
    fail(`${path}.compilerRange`, "must be a bounded Typst version range");
  }
  return {
    id: stableId(template.id, `${path}.id`),
    name,
    version: template.version,
    compilerRange: template.compilerRange,
  };
}

function validatePlacement(value: unknown, path: string): PdfTemplateRecipePlacementV1 {
  const placement = object(value, path);
  exactKeys(
    placement,
    ["relativeTo", "fit", "x", "y", "width", "height", "opacity", "rotation", "crop"],
    path
  );
  if (placement.relativeTo !== "page" && placement.relativeTo !== "margin") {
    fail(`${path}.relativeTo`, 'must be "page" or "margin"');
  }
  if (
    placement.fit !== undefined &&
    placement.fit !== "contain" &&
    placement.fit !== "cover" &&
    placement.fit !== "stretch"
  ) {
    fail(`${path}.fit`, "is not recognized");
  }
  let crop: PdfTemplateRecipePlacementV1["crop"];
  if (placement.crop !== undefined) {
    const source = object(placement.crop, `${path}.crop`);
    exactKeys(source, ["left", "top", "right", "bottom"], `${path}.crop`);
    crop = {
      left: finite(source.left, `${path}.crop.left`, 0, 1),
      top: finite(source.top, `${path}.crop.top`, 0, 1),
      right: finite(source.right, `${path}.crop.right`, 0, 1),
      bottom: finite(source.bottom, `${path}.crop.bottom`, 0, 1),
    };
    if (crop.left + crop.right >= 1 || crop.top + crop.bottom >= 1) {
      fail(`${path}.crop`, "must leave a positive visible area");
    }
  }
  return {
    relativeTo: placement.relativeTo,
    ...(placement.fit === undefined
      ? {}
      : { fit: placement.fit as PdfTemplateRecipePlacementV1["fit"] }),
    x: length(placement.x, `${path}.x`, true),
    y: length(placement.y, `${path}.y`, true),
    width: length(placement.width, `${path}.width`, false),
    height: length(placement.height, `${path}.height`, false),
    ...(placement.opacity === undefined
      ? {}
      : { opacity: finite(placement.opacity, `${path}.opacity`, 0, 1) }),
    ...(placement.rotation === undefined
      ? {}
      : { rotation: finite(placement.rotation, `${path}.rotation`, -180, 180) }),
    ...(crop === undefined ? {} : { crop }),
  };
}

function validateAssets(
  value: unknown,
  path: string
): Readonly<Record<string, PdfTemplateRecipeAssetV1>> {
  const assets = object(value, path);
  boundedEntries(assets, path, MAX_ASSETS);
  const validated: Record<string, PdfTemplateRecipeAssetV1> = {};
  for (const [slot, unknownAsset] of Object.entries(assets)) {
    stableId(slot, `${path}.${slot}`);
    const asset = object(unknownAsset, `${path}.${slot}`);
    exactKeys(asset, ["source", "decorative", "alt", "placement"], `${path}.${slot}`);
    const decorative = boolean(asset.decorative, `${path}.${slot}.decorative`);
    if (!decorative && asset.alt === undefined) {
      fail(`${path}.${slot}.alt`, "is required for a meaning-bearing asset");
    }
    const alt =
      asset.alt === undefined
        ? undefined
        : validateSafeString(asset.alt, `${path}.${slot}.alt`);
    validated[slot] = {
      source: portableSourcePath(asset.source, `${path}.${slot}.source`),
      decorative,
      ...(alt === undefined ? {} : { alt }),
      ...(asset.placement === undefined
        ? {}
        : { placement: validatePlacement(asset.placement, `${path}.${slot}.placement`) }),
    };
  }
  return validated;
}

function exactDynamicMap(
  value: unknown,
  path: string,
  each: (entry: Record<string, unknown>, entryPath: string) => void
): void {
  const record = object(value, path);
  boundedEntries(record, path, MAX_DYNAMIC_ENTRIES);
  for (const [key, raw] of Object.entries(record)) {
    assertSafeIdentifier(key, `${path}.${key}`);
    each(object(raw, `${path}.${key}`), `${path}.${key}`);
  }
}

/** Enforce exact recipe-owned structure before permissive portable validators normalize it. */
function assertExactDesignShape(value: unknown, path: string): void {
  const design = object(value, path);
  exactKeys(
    design,
    ["page", "features", "branding", "typography", "tokens", "semanticPalettes", "compositions"],
    path
  );
  const page = object(design.page, `${path}.page`);
  exactKeys(page, ["size", "orientation", "margin"], `${path}.page`);
  exactKeys(
    object(page.margin, `${path}.page.margin`),
    ["top", "right", "bottom", "left"],
    `${path}.page.margin`
  );

  const features = object(design.features, `${path}.features`);
  exactKeys(features, ["cover", "outline", "header", "footer", "closingPage"], `${path}.features`);
  exactKeys(object(features.cover, `${path}.features.cover`), ["enabled"], `${path}.features.cover`);
  exactKeys(
    object(features.outline, `${path}.features.outline`),
    ["enabled", "depth"],
    `${path}.features.outline`
  );
  exactKeys(
    object(features.header, `${path}.features.header`),
    ["enabled", "mode"],
    `${path}.features.header`
  );
  exactKeys(object(features.footer, `${path}.features.footer`), ["enabled"], `${path}.features.footer`);
  exactKeys(
    object(features.closingPage, `${path}.features.closingPage`),
    ["enabled"],
    `${path}.features.closingPage`
  );

  const branding = object(design.branding, `${path}.branding`);
  exactKeys(
    branding,
    ["accent", "organizationName", "websiteLabel", "websiteUrl", "legalNotice"],
    `${path}.branding`
  );

  const typography = object(design.typography, `${path}.typography`);
  exactKeys(typography, ["fonts", "roles"], `${path}.typography`);
  exactKeys(
    object(typography.fonts, `${path}.typography.fonts`),
    ["body", "heading", "mono"],
    `${path}.typography.fonts`
  );
  exactDynamicMap(typography.roles, `${path}.typography.roles`, (role, rolePath) => {
    exactKeys(role, ["font", "size", "weight", "tracking"], rolePath);
  });

  const tokens = object(design.tokens, `${path}.tokens`);
  exactKeys(tokens, ["colors", "layout", "ratios", "contrast"], `${path}.tokens`);
  for (const key of ["colors", "layout", "ratios"] as const) {
    const values = object(tokens[key], `${path}.tokens.${key}`);
    boundedEntries(values, `${path}.tokens.${key}`, MAX_DYNAMIC_ENTRIES);
    for (const name of Object.keys(values)) assertSafeIdentifier(name, `${path}.tokens.${key}.${name}`);
  }
  exactKeys(
    object(tokens.contrast, `${path}.tokens.contrast`),
    ["minimum"],
    `${path}.tokens.contrast`
  );

  const palettes = object(design.semanticPalettes, `${path}.semanticPalettes`);
  exactKeys(palettes, ["callouts", "statuses"], `${path}.semanticPalettes`);
  exactDynamicMap(palettes.callouts, `${path}.semanticPalettes.callouts`, (palette, palettePath) => {
    exactKeys(palette, ["background", "foreground"], palettePath);
  });
  const statuses = object(palettes.statuses, `${path}.semanticPalettes.statuses`);
  boundedEntries(statuses, `${path}.semanticPalettes.statuses`, MAX_DYNAMIC_ENTRIES);
  for (const name of Object.keys(statuses)) {
    assertSafeIdentifier(name, `${path}.semanticPalettes.statuses.${name}`);
  }

  if (design.compositions !== undefined) {
    const compositions = object(design.compositions, `${path}.compositions`);
    exactKeys(compositions, ["cover", "closingPage"], `${path}.compositions`);
    const cover = object(compositions.cover, `${path}.compositions.cover`);
    exactKeys(
      cover,
      ["kind", "logo", "metadataPosition", "typeCut"],
      `${path}.compositions.cover`
    );
    if (cover.typeCut !== undefined) {
      exactKeys(
        object(cover.typeCut, `${path}.compositions.cover.typeCut`),
        ["angle", "stop"],
        `${path}.compositions.cover.typeCut`
      );
    }
    exactKeys(
      object(compositions.closingPage, `${path}.compositions.closingPage`),
      ["kind", "logo", "website", "legalNotice", "align"],
      `${path}.compositions.closingPage`
    );
  }
}

function assertExactLocalizationShape(value: unknown, path: string): void {
  const localization = object(value, path);
  exactKeys(localization, ["defaultLocale", "fallbackLocale", "locales"], path);
  const locales = object(localization.locales, `${path}.locales`);
  boundedEntries(locales, `${path}.locales`, 64);
  for (const [locale, raw] of Object.entries(locales)) {
    if (locale.length === 0 || [...locale].length > 64 || /[\u0000-\u001f\u007f]/u.test(locale)) {
      fail(`${path}.locales.${locale}`, "locale key is invalid");
    }
    const bundle = object(raw, `${path}.locales.${locale}`);
    exactKeys(bundle, ["template", "document", "settingGroups", "settings"], `${path}.locales.${locale}`);
    if (bundle.template !== undefined) {
      exactKeys(
        object(bundle.template, `${path}.locales.${locale}.template`),
        ["name", "description"],
        `${path}.locales.${locale}.template`
      );
    }
    for (const mapName of ["document", "settingGroups"] as const) {
      if (bundle[mapName] !== undefined) {
        boundedEntries(
          object(bundle[mapName], `${path}.locales.${locale}.${mapName}`),
          `${path}.locales.${locale}.${mapName}`,
          MAX_DYNAMIC_ENTRIES
        );
      }
    }
    if (bundle.settings !== undefined) {
      exactDynamicMap(bundle.settings, `${path}.locales.${locale}.settings`, (setting, settingPath) => {
        exactKeys(setting, ["label", "help", "options"], settingPath);
        if (setting.options !== undefined) {
          boundedEntries(object(setting.options, `${settingPath}.options`), `${settingPath}.options`, MAX_DYNAMIC_ENTRIES);
        }
      });
    }
  }
}

/** Validate parsed recipe data without performing filesystem or YAML operations. */
export function validatePdfTemplateRecipeV1(
  value: unknown,
  path = "recipe"
): WikiPdfTemplateRecipeV1 {
  const recipe = object(value, path);
  exactKeys(recipe, ["schema", "template", "design", "localization", "assets"], path);
  if (recipe.schema !== WIKI_PDF_TEMPLATE_RECIPE_SCHEMA_V1) {
    fail(`${path}.schema`, `must be "${WIKI_PDF_TEMPLATE_RECIPE_SCHEMA_V1}"`);
  }
  assertExactDesignShape(recipe.design, `${path}.design`);
  assertExactLocalizationShape(recipe.localization, `${path}.localization`);
  return {
    schema: WIKI_PDF_TEMPLATE_RECIPE_SCHEMA_V1,
    template: validateTemplate(recipe.template, `${path}.template`),
    design: validateDesign(recipe.design, `${path}.design`),
    localization: validateLocalization(
      recipe.localization,
      {
        requiredDocumentLabels: WIKI_PDF_V1_DOCUMENT_LABELS,
        supportedDocumentLabels: WIKI_PDF_SUPPORTED_DOCUMENT_LABELS,
      },
      `${path}.localization`
    ),
    assets: validateAssets(recipe.assets, `${path}.assets`),
  };
}
