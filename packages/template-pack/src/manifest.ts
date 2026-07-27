/**
 * `.wiki-pdf-template` manifest schema + import gate (spec 007 T2.4).
 *
 * The manifest (`wiki-pdf-template.json`) is the first entry in every pack. It
 * pins the template API and, for the Typst engine, the compiler compatibility
 * range. {@link validateManifest} is therefore not merely a shape check but the
 * **import gate** (TEMPLATE-UX §9): it rejects an unknown `schemaVersion`, an
 * `engine.api` that is not a recognized `wiki.{pdf,docx}-template/v1` value, and
 * a Typst `compilerRange` the pinned compiler does not satisfy — each with a
 * typed, actionable reason so a host can render an upgrade/downgrade hint
 * instead of a raw parse error.
 *
 * The compiler check is a pure string/semver comparison against the pinned
 * version; actually invoking the compiler against the canonical feature zoo
 * stays the deferred Level-B host follow-up (TEMPLATE-UX §9).
 *
 * Browser-safe: no `node:`/`bun:` imports.
 */

import { validateBindings, type WikiPdfTemplateSettingBindingV1 } from "./bindings.js";
import {
  validateTemplateVisualManifestFieldsV1,
  type TemplateVisualManifestFieldsV1,
} from "./assets.js";
import { validateDesign, type WikiPdfTemplateDesignV1 } from "./design.js";
import {
  validateLocalization,
  WIKI_PDF_V1_DOCUMENT_LABELS,
  type DeclaredSettingsShape,
  type WikiPdfTemplateLocalizationV1,
} from "./localization.js";
import { ManifestValidationError, type ManifestErrorReason } from "./manifest-error.js";

export { ManifestValidationError, type ManifestErrorReason };

/** Manifest file name; always the first entry in a pack. */
export const TEMPLATE_PACK_MANIFEST_NAME = "wiki-pdf-template.json";

/** The only schema version recognized at ship time. */
export const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Pinned Typst compiler version used to gate `engine.compilerRange`. Mirrors
 * the Typst version inside `PDF_BROWSER_COMPILER_VERSION`
 * (`@atlcli/pdf-compiler-browser`, currently `"… / Typst 0.14.2"`). Kept as a
 * local constant so this pure package need not depend on the WASM compiler; a
 * host may pass the authoritative value via {@link ValidateManifestOptions}.
 */
export const PINNED_TYPST_VERSION = "0.14.2";

/** Recognized `engine.api` values, keyed by `engine.kind`. */
export const KNOWN_ENGINE_API = {
  typst: "wiki.pdf-template/v1",
  docx: "wiki.docx-template/v1",
} as const;

export type TemplateEngineKind = keyof typeof KNOWN_ENGINE_API;

/** The bounded Level-A setting type set (TEMPLATE-UX §5.1). */
export const SETTING_TYPES = ["text", "boolean", "choice", "color", "number", "asset"] as const;
export type TemplateSettingType = (typeof SETTING_TYPES)[number];

export interface TemplateEngineSpec {
  kind: TemplateEngineKind;
  api: string;
  entry: string;
  /** Typst only; semver range like `">=0.14 <0.15"`. */
  compilerRange?: string;
}

/** Declarative required-font record (shape mirrors `FontAsset` sans hash/license). */
export interface RequiredFont {
  family: string;
  style: string;
  weight: number;
}

export interface ManifestSetting {
  type: TemplateSettingType;
  default?: unknown;
  /** Additional per-type descriptors (e.g. `choice` options); not gated here. */
  [key: string]: unknown;
}

export interface TemplateProvenance {
  /**
   * Digest of the pack's *payload members* (never the archive bytes) — see
   * `pack.ts` for the exact canonicalization. Distinct from a
   * `TemplateLibraryEntry.sha256`, which hashes the delivered archive bytes.
   */
  payloadSha256: string;
  createdWith: string;
}

/** Renderer-owned capability catalog used to generate canonical source. */
export interface TemplateCapabilityCatalogReferenceV1 {
  id: string;
  version: number;
  digest: string;
}

export interface TemplateManifest extends TemplateVisualManifestFieldsV1 {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  engine: TemplateEngineSpec;
  requiredFonts?: RequiredFont[];
  settings?: Record<string, ManifestSetting>;
  provenance?: TemplateProvenance;
  /** Presentation model (spec 012): typography, tokens, palettes, components. */
  design?: WikiPdfTemplateDesignV1;
  /** Exact catalog identity required by canonical generated packs. */
  capabilityCatalog?: TemplateCapabilityCatalogReferenceV1;
  /** Setting → design-field bindings (spec 012). */
  bindings?: WikiPdfTemplateSettingBindingV1[];
  /** Document + UI copy per locale (spec 012). */
  localization?: WikiPdfTemplateLocalizationV1;
}

export interface ValidateManifestOptions {
  /**
   * Pinned Typst version to gate `engine.compilerRange` against. Accepts a bare
   * semver (`"0.14.2"`) or the descriptive `PDF_BROWSER_COMPILER_VERSION` form
   * (`"typst.ts 0.7.0 / Typst 0.14.2"`, the last version token is used).
   * Defaults to {@link PINNED_TYPST_VERSION}.
   */
  pinnedTypstVersion?: string;
  /**
   * Bundled runtime font inventory to cross-check `requiredFonts` against (spec
   * 012 T6.1). When provided, an unsatisfiable required font (no matching
   * family+style+weight) is rejected at import; when omitted, `requiredFonts`
   * is shape-checked only (007's behavior).
   */
  availableFonts?: ReadonlyArray<{ family: string; style: string; weight: number }>;
  /** Sink for non-fatal localization warnings (partial non-fallback locales). */
  collectWarnings?: (warning: string) => void;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ManifestValidationError("shape-error", `${path} must be a non-empty string`, path);
  }
  return v;
}

function validateCapabilityCatalogReference(
  value: unknown
): TemplateCapabilityCatalogReferenceV1 | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new ManifestValidationError(
      "shape-error",
      "capabilityCatalog must be an object",
      "capabilityCatalog"
    );
  }
  const id = requireString(value, "id", "capabilityCatalog.id");
  const version = value.version;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new ManifestValidationError(
      "shape-error",
      "capabilityCatalog.version must be a positive safe integer",
      "capabilityCatalog.version"
    );
  }
  const digest = requireString(value, "digest", "capabilityCatalog.digest");
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new ManifestValidationError(
      "shape-error",
      "capabilityCatalog.digest must be a lowercase SHA-256 digest",
      "capabilityCatalog.digest"
    );
  }
  return { id, version: version as number, digest };
}

/** Extract the last `x.y[.z]` token from a version string. */
export function extractTypstVersion(raw: string): string {
  const matches = raw.match(/\d+\.\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) {
    throw new ManifestValidationError("shape-error", `Unparseable pinned version "${raw}"`);
  }
  return matches[matches.length - 1];
}

/** Parse `x.y[.z]` into a 3-tuple, missing segments defaulting to 0. */
function parseVersion(v: string): [number, number, number] {
  const parts = v.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) {
    throw new ManifestValidationError("shape-error", `Unparseable version "${v}"`);
  }
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Minimal semver range check for the documented supported forms only:
 * whitespace-separated conjuncts, each `(>=|<=|>|<|=)?x.y[.z]` (a bare version
 * is exact). Everything must hold for the range to be satisfied. An
 * unparseable range is a shape error, not a compiler mismatch.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  const tokens = range.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new ManifestValidationError("shape-error", `Empty compilerRange`);
  }
  for (const token of tokens) {
    const m = token.match(/^(>=|<=|>|<|=)?(\d+\.\d+(?:\.\d+)?)$/);
    if (!m) {
      throw new ManifestValidationError(
        "shape-error",
        `Unsupported compilerRange form "${token}" (supported: >=x.y <x.z, >x.y, <=x.y, =x.y)`,
        "engine.compilerRange"
      );
    }
    const op = m[1] ?? "=";
    const cmp = compareVersions(v, parseVersion(m[2]));
    const ok =
      op === "="
        ? cmp === 0
        : op === ">="
          ? cmp >= 0
          : op === "<="
            ? cmp <= 0
            : op === ">"
              ? cmp > 0
              : /* "<" */ cmp < 0;
    if (!ok) return false;
  }
  return true;
}

/**
 * Validate an untrusted manifest object and return it typed. Runs the import
 * gate in a fixed order: schema version → basic shape → engine api →
 * (typst) compiler range → declarative field shapes.
 *
 * @throws {ManifestValidationError} with a typed {@link ManifestErrorReason}.
 */
export function validateManifest(
  json: unknown,
  options: ValidateManifestOptions = {}
): TemplateManifest {
  if (!isObject(json)) {
    throw new ManifestValidationError("shape-error", "Manifest must be a JSON object");
  }

  // 1. Schema version gate (before any other check).
  if (json.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new ManifestValidationError(
      "unknown-schema-version",
      `Unsupported schemaVersion ${JSON.stringify(json.schemaVersion)} (only ${SUPPORTED_SCHEMA_VERSION} is recognized)`,
      "schemaVersion"
    );
  }

  // 2. Basic string fields.
  const id = requireString(json, "id", "id");
  const name = requireString(json, "name", "name");
  const version = requireString(json, "version", "version");

  // 3. Engine shape.
  if (!isObject(json.engine)) {
    throw new ManifestValidationError("shape-error", "engine must be an object", "engine");
  }
  const engine = json.engine;
  const kind = engine.kind;
  if (kind !== "typst" && kind !== "docx") {
    throw new ManifestValidationError(
      "shape-error",
      `engine.kind must be "typst" or "docx"`,
      "engine.kind"
    );
  }
  const entry = requireString(engine, "entry", "engine.entry");
  const api = requireString(engine, "api", "engine.api");

  // 4. API gate.
  const expectedApi = KNOWN_ENGINE_API[kind];
  if (api !== expectedApi) {
    throw new ManifestValidationError(
      "unknown-api",
      `Unknown engine.api "${api}" for kind "${kind}" (expected "${expectedApi}")`,
      "engine.api"
    );
  }

  // 5. Compiler range gate (typst only).
  let compilerRange: string | undefined;
  if (engine.compilerRange !== undefined) {
    if (typeof engine.compilerRange !== "string") {
      throw new ManifestValidationError(
        "shape-error",
        "engine.compilerRange must be a string",
        "engine.compilerRange"
      );
    }
    compilerRange = engine.compilerRange;
    if (kind === "typst") {
      const pinned = extractTypstVersion(options.pinnedTypstVersion ?? PINNED_TYPST_VERSION);
      if (!satisfiesRange(pinned, compilerRange)) {
        throw new ManifestValidationError(
          "compiler-range-mismatch",
          `Pinned Typst ${pinned} does not satisfy engine.compilerRange "${compilerRange}"`,
          "engine.compilerRange"
        );
      }
    }
  }

  // 6. Declarative field shapes.
  const requiredFonts = validateRequiredFonts(json.requiredFonts);
  crossCheckRequiredFonts(requiredFonts, options.availableFonts);
  const settings = validateSettings(json.settings);
  const provenance = validateProvenance(json.provenance);

  // 7. Presentation model (spec 012): design / bindings / localization.
  const design = json.design !== undefined ? validateDesign(json.design) : undefined;
  const capabilityCatalog = validateCapabilityCatalogReference(
    json.capabilityCatalog
  );
  const bindings = json.bindings !== undefined ? validateBindings(json.bindings) : undefined;
  const localization =
    json.localization !== undefined
      ? validateLocalization(json.localization, {
          requiredDocumentLabels: kind === "typst" ? WIKI_PDF_V1_DOCUMENT_LABELS : [],
          declared: declaredSettingsShape(settings),
          ...(options.collectWarnings ? { onWarning: options.collectWarnings } : {}),
        })
      : undefined;
  const visual = validateTemplateVisualManifestFieldsV1(json);

  const manifest: TemplateManifest = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    id,
    name,
    version,
    engine: { kind, api, entry, ...(compilerRange !== undefined ? { compilerRange } : {}) },
    ...(requiredFonts ? { requiredFonts } : {}),
    ...(settings ? { settings } : {}),
    ...(provenance ? { provenance } : {}),
    ...(design ? { design } : {}),
    ...(capabilityCatalog ? { capabilityCatalog } : {}),
    ...(bindings ? { bindings } : {}),
    ...(localization ? { localization } : {}),
    ...visual,
  };
  return manifest;
}

/** Reject any required font the bundled inventory cannot satisfy (spec 012). */
function crossCheckRequiredFonts(
  requiredFonts: RequiredFont[] | undefined,
  availableFonts: ValidateManifestOptions["availableFonts"]
): void {
  if (!requiredFonts || !availableFonts) return;
  requiredFonts.forEach((font, i) => {
    const satisfiable = availableFonts.some(
      (a) => a.family === font.family && a.style === font.style && a.weight === font.weight
    );
    if (!satisfiable) {
      throw new ManifestValidationError(
        "shape-error",
        `requiredFonts[${i}] (${font.family} ${font.style} ${font.weight}) is not in the bundled font inventory`,
        `requiredFonts[${i}]`
      );
    }
  });
}

/** Project declared `settings` into the shape the localization check needs. */
function declaredSettingsShape(
  settings: Record<string, ManifestSetting> | undefined
): DeclaredSettingsShape {
  const shape: DeclaredSettingsShape = { settings: {}, groups: [] };
  if (!settings) return shape;
  for (const [key, setting] of Object.entries(settings)) {
    const options = choiceOptionValues(setting);
    shape.settings[key] = options ? { options } : {};
    const group = setting.group;
    if (typeof group === "string" && !shape.groups.includes(group)) shape.groups.push(group);
  }
  return shape;
}

function choiceOptionValues(setting: ManifestSetting): string[] | undefined {
  if (setting.type !== "choice" || !Array.isArray(setting.options)) return undefined;
  const values: string[] = [];
  for (const option of setting.options) {
    if (typeof option === "string") values.push(option);
    else if (option && typeof option === "object" && typeof (option as { value?: unknown }).value === "string") {
      values.push((option as { value: string }).value);
    }
  }
  return values.length > 0 ? values : undefined;
}

function validateRequiredFonts(value: unknown): RequiredFont[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ManifestValidationError("shape-error", "requiredFonts must be an array", "requiredFonts");
  }
  return value.map((f, i) => {
    const path = `requiredFonts[${i}]`;
    if (!isObject(f)) throw new ManifestValidationError("shape-error", `${path} must be an object`, path);
    const family = requireString(f, "family", `${path}.family`);
    const style = requireString(f, "style", `${path}.style`);
    if (typeof f.weight !== "number") {
      throw new ManifestValidationError("shape-error", `${path}.weight must be a number`, `${path}.weight`);
    }
    return { family, style, weight: f.weight };
  });
}

function validateSettings(value: unknown): Record<string, ManifestSetting> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new ManifestValidationError("shape-error", "settings must be an object", "settings");
  }
  const out: Record<string, ManifestSetting> = {};
  for (const [key, raw] of Object.entries(value)) {
    const path = `settings.${key}`;
    if (!isObject(raw)) throw new ManifestValidationError("shape-error", `${path} must be an object`, path);
    const type = raw.type;
    if (typeof type !== "string" || !(SETTING_TYPES as readonly string[]).includes(type)) {
      throw new ManifestValidationError(
        "shape-error",
        `${path}.type must be one of ${SETTING_TYPES.join(", ")}`,
        `${path}.type`
      );
    }
    out[key] = { ...raw, type: type as TemplateSettingType };
  }
  return out;
}

function validateProvenance(value: unknown): TemplateProvenance | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new ManifestValidationError("shape-error", "provenance must be an object", "provenance");
  }
  const payloadSha256 = requireString(value, "payloadSha256", "provenance.payloadSha256");
  const createdWith = requireString(value, "createdWith", "provenance.createdWith");
  return { payloadSha256, createdWith };
}
