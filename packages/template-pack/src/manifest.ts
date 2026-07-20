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

export interface TemplateManifest {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  engine: TemplateEngineSpec;
  requiredFonts?: RequiredFont[];
  settings?: Record<string, ManifestSetting>;
  provenance?: TemplateProvenance;
}

/** Typed rejection reasons carried by {@link ManifestValidationError}. */
export type ManifestErrorReason =
  | "unknown-schema-version"
  | "unknown-api"
  | "compiler-range-mismatch"
  | "shape-error";

/** Thrown by {@link validateManifest} on any rejection, with a typed reason. */
export class ManifestValidationError extends Error {
  constructor(
    readonly reason: ManifestErrorReason,
    message: string,
    /** Offending manifest field path, when applicable. */
    readonly path?: string
  ) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

export interface ValidateManifestOptions {
  /**
   * Pinned Typst version to gate `engine.compilerRange` against. Accepts a bare
   * semver (`"0.14.2"`) or the descriptive `PDF_BROWSER_COMPILER_VERSION` form
   * (`"typst.ts 0.7.0 / Typst 0.14.2"`, the last version token is used).
   * Defaults to {@link PINNED_TYPST_VERSION}.
   */
  pinnedTypstVersion?: string;
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
  const settings = validateSettings(json.settings);
  const provenance = validateProvenance(json.provenance);

  const manifest: TemplateManifest = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    id,
    name,
    version,
    engine: { kind, api, entry, ...(compilerRange !== undefined ? { compilerRange } : {}) },
    ...(requiredFonts ? { requiredFonts } : {}),
    ...(settings ? { settings } : {}),
    ...(provenance ? { provenance } : {}),
  };
  return manifest;
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
