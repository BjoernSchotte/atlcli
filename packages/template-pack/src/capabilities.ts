/**
 * Engine-neutral capability catalog contracts for template authoring.
 *
 * A renderer owns the concrete catalog. This package owns only the portable
 * descriptors, deterministic projections, validators, and digests that every
 * host (CLI, browser studio, extension) must interpret identically.
 *
 * Browser-safe: no `node:` or `bun:` imports.
 */
import { sha256Hex } from "@atlcli/core";

export const TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V1 =
  "atlcli.template-capability-catalog/1" as const;
export const TEMPLATE_CAPABILITY_PRESENTATION_SCHEMA_V1 =
  "atlcli.template-capability-presentation/1" as const;

export type CapabilityValueKindV1 =
  | "boolean"
  | "color"
  | "enum"
  | "font-family"
  | "font-role"
  | "length"
  | "number"
  | "string"
  | "weight";

export type CapabilityRuntimeWriterKindV1 = "engine-policy" | "runtime-binding";

export interface CapabilityRuntimeWriterV1 {
  kind: CapabilityRuntimeWriterKindV1;
  /** Stable owner, for example `theme.colors.ink` or `setting.accentColor`. */
  id: string;
}

export interface TemplateCapabilityDescriptorV1 {
  /** Exact dot-separated path in the engine's design snapshot. */
  path: string;
  valueKind: CapabilityValueKindV1;
  /** Required for a canonical executable authoring snapshot. */
  required: boolean;
  /** Stable renderer consumers; never localized presentation metadata. */
  consumers: readonly string[];
  /** Runtime writers in addition to baseline and explicit authoring decisions. */
  runtimeWriters?: readonly CapabilityRuntimeWriterV1[];
  /**
   * Required when more than one runtime writer intentionally targets this
   * path. Contains every writer id exactly once, in application order.
   */
  writeOrder?: readonly string[];
  /** Bounded values for `enum`, `font-role`, and `weight` descriptors. */
  enumValues?: readonly string[];
  /** Bounds for number-valued capabilities. */
  minimum?: number;
  maximum?: number;
}

export interface TemplateCapabilityCatalogV1 {
  schema: typeof TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V1;
  id: string;
  version: number;
  descriptors: readonly TemplateCapabilityDescriptorV1[];
}

export type CapabilityValueFormatV1 =
  | "boolean"
  | "color"
  | "font"
  | "length"
  | "number"
  | "text";
export type CapabilityComparisonKindV1 = "exact" | "numeric" | "visual";
export type CapabilityEditKindV1 =
  | "choice"
  | "color"
  | "font"
  | "number"
  | "text"
  | "toggle";

export interface TemplateCapabilityPresentationDescriptorV1 {
  target: string;
  section: string;
  order: number;
  messageCode: string;
  valueFormat: CapabilityValueFormatV1;
  comparisonKind: CapabilityComparisonKindV1;
  editKind: CapabilityEditKindV1;
}

export interface TemplateCapabilityPresentationRegistryV1 {
  schema: typeof TEMPLATE_CAPABILITY_PRESENTATION_SCHEMA_V1;
  id: string;
  version: number;
  descriptors: readonly TemplateCapabilityPresentationDescriptorV1[];
}

export type CapabilityValidationReasonV1 =
  | "catalog-invalid"
  | "incomplete-baseline"
  | "invalid-capability-value"
  | "presentation-invalid"
  | "unknown-capability";

export class CapabilityValidationError extends Error {
  constructor(
    readonly reason: CapabilityValidationReasonV1,
    message: string,
    readonly path?: string
  ) {
    super(message);
    this.name = "CapabilityValidationError";
  }
}

export type FlatDesignV1 = Readonly<Record<string, unknown>>;

export interface DesignCatalogValidationV1 {
  status: "canonical-executable" | "legacy-readable";
  flat: FlatDesignV1;
  ignoredCapabilities: readonly string[];
  missingCapabilities: readonly string[];
}

const PATH_RE = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/;
const STABLE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const MESSAGE_CODE_RE = /^[A-Z][A-Z0-9_]{2,127}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const LENGTH_RE = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:pt|mm|em)$/;

function fail(
  reason: CapabilityValidationReasonV1,
  path: string | undefined,
  message: string
): never {
  throw new CapabilityValidationError(reason, path ? `${path}: ${message}` : message, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStableId(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !STABLE_ID_RE.test(value)) {
    fail("catalog-invalid", path, "must be a stable identifier");
  }
}

function assertPath(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !PATH_RE.test(value)) {
    fail("catalog-invalid", path, "must be a dot-separated capability path");
  }
}

/** Validate and freeze the portable catalog shape. */
export function validateCapabilityCatalogV1(
  value: unknown
): TemplateCapabilityCatalogV1 {
  if (!isRecord(value)) fail("catalog-invalid", undefined, "catalog must be an object");
  const catalog = value as unknown as TemplateCapabilityCatalogV1;
  if (catalog.schema !== TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V1) {
    fail("catalog-invalid", "schema", `must be ${TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V1}`);
  }
  assertStableId(catalog.id, "id");
  if (!Number.isSafeInteger(catalog.version) || catalog.version < 1) {
    fail("catalog-invalid", "version", "must be a positive integer");
  }
  if (!Array.isArray(catalog.descriptors) || catalog.descriptors.length === 0) {
    fail("catalog-invalid", "descriptors", "must be a non-empty array");
  }

  const paths = new Set<string>();
  for (const [index, candidate] of catalog.descriptors.entries()) {
    const base = `descriptors[${index}]`;
    const rawDescriptor: unknown = candidate;
    if (!isRecord(rawDescriptor)) fail("catalog-invalid", base, "must be an object");
    const descriptor = rawDescriptor as unknown as TemplateCapabilityDescriptorV1;
    assertPath(descriptor.path, `${base}.path`);
    if (paths.has(descriptor.path)) {
      fail("catalog-invalid", descriptor.path, "has more than one descriptor");
    }
    paths.add(descriptor.path);
    if (
      ![
        "boolean",
        "color",
        "enum",
        "font-family",
        "font-role",
        "length",
        "number",
        "string",
        "weight",
      ].includes(descriptor.valueKind)
    ) {
      fail("catalog-invalid", `${base}.valueKind`, "is unknown");
    }
    if (typeof descriptor.required !== "boolean") {
      fail("catalog-invalid", `${base}.required`, "must be boolean");
    }
    if (
      !Array.isArray(descriptor.consumers) ||
      descriptor.consumers.length === 0 ||
      descriptor.consumers.some((consumer) => typeof consumer !== "string" || consumer.length === 0)
    ) {
      fail("catalog-invalid", `${base}.consumers`, "must contain stable consumer names");
    }
    if (new Set(descriptor.consumers).size !== descriptor.consumers.length) {
      fail("catalog-invalid", `${base}.consumers`, "must not contain duplicates");
    }

    const writers = descriptor.runtimeWriters ?? [];
    const writerIds = new Set<string>();
    for (const [writerIndex, writer] of writers.entries()) {
      const writerPath = `${base}.runtimeWriters[${writerIndex}]`;
      if (
        writer.kind !== "engine-policy" &&
        writer.kind !== "runtime-binding"
      ) {
        fail("catalog-invalid", `${writerPath}.kind`, "is unknown");
      }
      assertStableId(writer.id, `${writerPath}.id`);
      if (writerIds.has(writer.id)) {
        fail("catalog-invalid", `${writerPath}.id`, "duplicates a runtime writer");
      }
      writerIds.add(writer.id);
    }
    if (writers.length > 1) {
      const order = descriptor.writeOrder;
      if (
        !Array.isArray(order) ||
        order.length !== writers.length ||
        new Set(order).size !== order.length ||
        order.some((writer) => !writerIds.has(writer))
      ) {
        fail(
          "catalog-invalid",
          `${base}.writeOrder`,
          "must declare every runtime writer exactly once"
        );
      }
    } else if (descriptor.writeOrder !== undefined) {
      fail(
        "catalog-invalid",
        `${base}.writeOrder`,
        "is only valid for an intentional multiple-writer capability"
      );
    }

    const enumValues = descriptor.enumValues;
    const enumKind =
      descriptor.valueKind === "enum" ||
      descriptor.valueKind === "font-role" ||
      descriptor.valueKind === "weight";
    if (
      enumKind &&
      (!Array.isArray(enumValues) ||
        enumValues.length === 0 ||
        enumValues.some((entry) => typeof entry !== "string" || entry.length === 0) ||
        new Set(enumValues).size !== enumValues.length)
    ) {
      fail("catalog-invalid", `${base}.enumValues`, "must be a non-empty unique string array");
    }
    if (!enumKind && enumValues !== undefined) {
      fail("catalog-invalid", `${base}.enumValues`, "is not valid for this value kind");
    }
    if (
      descriptor.minimum !== undefined &&
      (!Number.isFinite(descriptor.minimum) || descriptor.valueKind !== "number")
    ) {
      fail("catalog-invalid", `${base}.minimum`, "is only valid as a finite number bound");
    }
    if (
      descriptor.maximum !== undefined &&
      (!Number.isFinite(descriptor.maximum) || descriptor.valueKind !== "number")
    ) {
      fail("catalog-invalid", `${base}.maximum`, "is only valid as a finite number bound");
    }
    if (
      descriptor.minimum !== undefined &&
      descriptor.maximum !== undefined &&
      descriptor.minimum > descriptor.maximum
    ) {
      fail("catalog-invalid", base, "minimum must not exceed maximum");
    }
  }
  return catalog;
}

/**
 * Validate presentation metadata independently from renderer capability
 * validation. Every catalog target must be either presented exactly once or
 * explicitly classified as details-only.
 */
export function validateCapabilityPresentationRegistryV1(
  catalog: TemplateCapabilityCatalogV1,
  value: unknown,
  detailsOnlyTargets: readonly string[]
): TemplateCapabilityPresentationRegistryV1 {
  validateCapabilityCatalogV1(catalog);
  if (!isRecord(value)) {
    fail("presentation-invalid", undefined, "presentation registry must be an object");
  }
  const registry = value as unknown as TemplateCapabilityPresentationRegistryV1;
  if (registry.schema !== TEMPLATE_CAPABILITY_PRESENTATION_SCHEMA_V1) {
    fail(
      "presentation-invalid",
      "schema",
      `must be ${TEMPLATE_CAPABILITY_PRESENTATION_SCHEMA_V1}`
    );
  }
  assertStableId(registry.id, "id");
  if (!Number.isSafeInteger(registry.version) || registry.version < 1) {
    fail("presentation-invalid", "version", "must be a positive integer");
  }
  if (!Array.isArray(registry.descriptors)) {
    fail("presentation-invalid", "descriptors", "must be an array");
  }

  const catalogPaths = new Set(catalog.descriptors.map(({ path }) => path));
  const details = new Set<string>();
  for (const target of detailsOnlyTargets) {
    if (!catalogPaths.has(target)) {
      fail("presentation-invalid", target, "details-only target is unknown");
    }
    if (details.has(target)) {
      fail("presentation-invalid", target, "details-only target is duplicated");
    }
    details.add(target);
  }

  const presented = new Set<string>();
  for (const [index, candidate] of registry.descriptors.entries()) {
    const base = `descriptors[${index}]`;
    const rawDescriptor: unknown = candidate;
    if (!isRecord(rawDescriptor)) {
      fail("presentation-invalid", base, "must be an object");
    }
    const descriptor =
      rawDescriptor as unknown as TemplateCapabilityPresentationDescriptorV1;
    if (typeof descriptor.target !== "string") {
      fail("presentation-invalid", `${base}.target`, "must be a capability path");
    }
    if (!catalogPaths.has(descriptor.target)) {
      fail("presentation-invalid", descriptor.target, "presentation target is unknown");
    }
    if (presented.has(descriptor.target)) {
      fail("presentation-invalid", descriptor.target, "has more than one presentation descriptor");
    }
    if (details.has(descriptor.target)) {
      fail("presentation-invalid", descriptor.target, "cannot be both primary and details-only");
    }
    presented.add(descriptor.target);
    assertStableId(descriptor.section, `${base}.section`);
    if (!Number.isSafeInteger(descriptor.order) || descriptor.order < 0) {
      fail("presentation-invalid", `${base}.order`, "must be a non-negative integer");
    }
    if (
      typeof descriptor.messageCode !== "string" ||
      !MESSAGE_CODE_RE.test(descriptor.messageCode)
    ) {
      fail("presentation-invalid", `${base}.messageCode`, "must be a stable message code");
    }
    if (!["boolean", "color", "font", "length", "number", "text"].includes(descriptor.valueFormat)) {
      fail("presentation-invalid", `${base}.valueFormat`, "is unknown");
    }
    if (!["exact", "numeric", "visual"].includes(descriptor.comparisonKind)) {
      fail("presentation-invalid", `${base}.comparisonKind`, "is unknown");
    }
    if (!["choice", "color", "font", "number", "text", "toggle"].includes(descriptor.editKind)) {
      fail("presentation-invalid", `${base}.editKind`, "is unknown");
    }
  }

  for (const path of catalogPaths) {
    if (!presented.has(path) && !details.has(path)) {
      fail(
        "presentation-invalid",
        path,
        "must have exactly one presentation descriptor or be explicitly details-only"
      );
    }
  }
  return registry;
}

/** Flatten a design into sorted leaf paths. Arrays are treated as leaf values. */
export function flattenDesign(value: unknown): FlatDesignV1 {
  if (!isRecord(value)) {
    fail("invalid-capability-value", undefined, "design must be an object");
  }
  const flat: Record<string, unknown> = {};
  const visit = (record: Record<string, unknown>, prefix: string): void => {
    for (const key of Object.keys(record).sort()) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
        fail("invalid-capability-value", prefix ? `${prefix}.${key}` : key, "invalid key");
      }
      const path = prefix ? `${prefix}.${key}` : key;
      const child = record[key];
      if (isRecord(child)) visit(child, path);
      else flat[path] = child;
    }
  };
  visit(value, "");
  return flat;
}

/** Rebuild a nested design from sorted, conflict-free leaf paths. */
export function unflattenDesign(flat: FlatDesignV1): Record<string, unknown> {
  if (!isRecord(flat)) {
    fail("invalid-capability-value", undefined, "flat design must be an object");
  }
  const result: Record<string, unknown> = {};
  for (const path of Object.keys(flat).sort()) {
    assertPath(path, path);
    const segments = path.split(".");
    let cursor = result;
    for (const [index, segment] of segments.entries()) {
      const terminal = index === segments.length - 1;
      const existing = cursor[segment];
      if (terminal) {
        if (isRecord(existing)) {
          fail("invalid-capability-value", path, "conflicts with a parent capability");
        }
        cursor[segment] = flat[path];
      } else {
        if (existing !== undefined && !isRecord(existing)) {
          fail("invalid-capability-value", path, "conflicts with a leaf capability");
        }
        if (existing === undefined) cursor[segment] = {};
        cursor = cursor[segment] as Record<string, unknown>;
      }
    }
  }
  return result;
}

function validateCapabilityValue(
  descriptor: TemplateCapabilityDescriptorV1,
  value: unknown
): void {
  const invalid = (message: string): never =>
    fail("invalid-capability-value", descriptor.path, message);
  switch (descriptor.valueKind) {
    case "boolean":
      if (typeof value !== "boolean") invalid("must be a boolean");
      return;
    case "color":
      if (typeof value !== "string" || !COLOR_RE.test(value)) {
        invalid("must be a canonical #RRGGBB color");
      }
      return;
    case "length":
      if (typeof value !== "string" || !LENGTH_RE.test(value)) {
        invalid("must be a pt/mm/em length");
      }
      return;
    case "number":
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (descriptor.minimum !== undefined && value < descriptor.minimum) ||
        (descriptor.maximum !== undefined && value > descriptor.maximum)
      ) {
        invalid("must be a finite number within the declared bounds");
      }
      return;
    case "enum":
    case "font-role":
    case "weight":
      if (typeof value !== "string" || !descriptor.enumValues?.includes(value)) {
        invalid(`must be one of ${(descriptor.enumValues ?? []).join(", ")}`);
      }
      return;
    case "font-family":
    case "string":
      if (typeof value !== "string" || value.length === 0 || value.length > 200) {
        invalid("must be a non-empty string of at most 200 characters");
      }
      return;
  }
}

/**
 * Validate a design against exactly one catalog.
 *
 * Authoring rejects an unknown leaf. Legacy mode reports and drops unknown
 * leaves, and reports missing required leaves without manufacturing values.
 */
export function validateDesignAgainstCatalog(
  design: unknown,
  catalog: TemplateCapabilityCatalogV1,
  mode: "authoring" | "legacy"
): DesignCatalogValidationV1 {
  validateCapabilityCatalogV1(catalog);
  const source = flattenDesign(design);
  const descriptors = new Map(catalog.descriptors.map((descriptor) => [descriptor.path, descriptor]));
  const flat: Record<string, unknown> = {};
  const ignoredCapabilities: string[] = [];
  for (const path of Object.keys(source).sort()) {
    const descriptor = descriptors.get(path);
    if (!descriptor) {
      if (mode === "authoring") {
        fail("unknown-capability", path, "is not declared by the active capability catalog");
      }
      ignoredCapabilities.push(path);
      continue;
    }
    validateCapabilityValue(descriptor, source[path]);
    flat[path] = source[path];
  }
  const missingCapabilities = catalog.descriptors
    .filter(({ path, required }) => required && !(path in flat))
    .map(({ path }) => path)
    .sort();
  return {
    status:
      ignoredCapabilities.length === 0 && missingCapabilities.length === 0
        ? "canonical-executable"
        : "legacy-readable",
    flat,
    ignoredCapabilities,
    missingCapabilities,
  };
}

/** Require a complete, unknown-free authoring baseline and return its projection. */
export function validateCompleteBaseline(
  design: unknown,
  catalog: TemplateCapabilityCatalogV1
): Record<string, unknown> {
  const result = validateDesignAgainstCatalog(design, catalog, "authoring");
  const missing = result.missingCapabilities[0];
  if (missing) {
    fail("incomplete-baseline", missing, "required capability is missing");
  }
  return unflattenDesign(result.flat);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)])
    );
  }
  return value;
}

export function canonicalCapabilityJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

/** SHA-256 of canonical runtime capability JSON; presentation is not an input. */
export async function computeCapabilityCatalogDigest(
  catalog: TemplateCapabilityCatalogV1
): Promise<string> {
  validateCapabilityCatalogV1(catalog);
  return sha256Hex(new TextEncoder().encode(canonicalCapabilityJson(catalog)));
}

/** SHA-256 of presentation metadata only; it cannot affect runtime validation. */
export async function computeCapabilityPresentationRevision(
  catalog: TemplateCapabilityCatalogV1,
  registry: TemplateCapabilityPresentationRegistryV1,
  detailsOnlyTargets: readonly string[]
): Promise<string> {
  validateCapabilityPresentationRegistryV1(catalog, registry, detailsOnlyTargets);
  return sha256Hex(
    new TextEncoder().encode(
      canonicalCapabilityJson({
        registry,
        detailsOnlyTargets: [...detailsOnlyTargets].sort(),
      })
    )
  );
}
