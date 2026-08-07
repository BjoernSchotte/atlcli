/**
 * Capability catalog schema V2.
 *
 * V2 intentionally lives beside, rather than inside, the V1 canonicalizer.
 * Historical V1 catalog bytes and digests must never change when V2 grows.
 * This module is browser-safe and contains no host or renderer dependencies.
 */
import { sha256Hex } from "@atlcli/core";
import {
  CapabilityValidationError,
  canonicalCapabilityJson,
  flattenDesign,
  unflattenDesign,
  type CapabilityRuntimeWriterV1,
  type CapabilityValueKindV1,
  type FlatDesignV1,
  type TemplateCapabilityPresentationRegistryV1
} from "./capabilities.js";
import { satisfiesRange } from "./manifest.js";

export const TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V2 =
  "atlcli.template-capability-catalog/2" as const;

export type CapabilityValueKindV2 = CapabilityValueKindV1 | "array" | "object";
export type CapabilityOwnerV2 = "template" | "export" | "source" | "renderer";
export type CapabilityStabilityV2 = "experimental" | "stable" | "deprecated";
export type CapabilityProofV2 =
  | "contract"
  | "canonical-source"
  | "compile"
  | "semantic-pdf"
  | "visual-pdf"
  | "browser"
  | "live";

export interface TemplateCapabilityDescriptorV2 {
  path: string;
  valueKind: CapabilityValueKindV2;
  required: boolean;
  owner: CapabilityOwnerV2;
  consumers: readonly string[];
  compilerRange?: string;
  stability: CapabilityStabilityV2;
  proofs: readonly CapabilityProofV2[];
  runtimeWriters?: readonly CapabilityRuntimeWriterV1[];
  writeOrder?: readonly string[];
  enumValues?: readonly string[];
  minimum?: number;
  maximum?: number;
}

export interface CapabilityPredicateV2 {
  path: string;
  equals: string | number | boolean;
}

export interface CapabilityRequirementV2 {
  kind: "path" | "asset" | "label";
  id: string;
}

export interface CapabilityConstraintV2 {
  /** Predicates inside one constraint are an AND. */
  when: readonly CapabilityPredicateV2[];
  require?: readonly CapabilityRequirementV2[];
  forbid?: readonly CapabilityRequirementV2[];
}

export interface TemplateCapabilityCatalogV2 {
  schema: typeof TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V2;
  id: string;
  version: number;
  descriptors: readonly TemplateCapabilityDescriptorV2[];
  /** Closed requirement namespaces used by asset/label constraints. */
  assets?: readonly string[];
  labels?: readonly string[];
  constraints: readonly CapabilityConstraintV2[];
}

export interface DesignOverlayValidationV2 {
  flat: FlatDesignV1;
  suppliedCapabilities: readonly string[];
}

export interface CapabilityConstraintContextV2 {
  assets?: readonly string[];
  labels?: readonly string[];
  compilerVersion?: string;
}

export interface CapabilityConstraintViolationV2 {
  constraint: number;
  effect: "required" | "forbidden" | "compiler-unavailable";
  target: CapabilityRequirementV2 | { kind: "path"; id: string };
}

const PATH_RE = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/;
const STABLE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const LENGTH_RE = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:pt|mm|em)$/;
const MESSAGE_CODE_RE = /^[A-Z][A-Z0-9_]{2,127}$/;
const MAX_DESCRIPTORS = 4_096;
const MAX_CONSTRAINTS = 1_024;
const MAX_PREDICATES = 16;
const MAX_EFFECTS = 32;

const VALUE_KINDS: readonly CapabilityValueKindV2[] = [
  "array",
  "boolean",
  "color",
  "enum",
  "font-family",
  "font-role",
  "length",
  "number",
  "object",
  "string",
  "weight"
];
const OWNERS: readonly CapabilityOwnerV2[] = ["template", "export", "source", "renderer"];
const STABILITIES: readonly CapabilityStabilityV2[] = ["experimental", "stable", "deprecated"];
const PROOFS: readonly CapabilityProofV2[] = [
  "contract",
  "canonical-source",
  "compile",
  "semantic-pdf",
  "visual-pdf",
  "browser",
  "live"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string | undefined, message: string): never {
  throw new CapabilityValidationError(
    "catalog-invalid",
    path ? `${path}: ${message}` : message,
    path
  );
}

function failValue(path: string, message: string): never {
  throw new CapabilityValidationError("invalid-capability-value", `${path}: ${message}`, path);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !known.has(key));
  if (unknown) fail(path ? `${path}.${unknown}` : unknown, "is not allowed");
}

function assertPath(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !PATH_RE.test(value)) {
    fail(path, "must be a dot-separated capability path");
  }
}

function assertStableId(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !STABLE_ID_RE.test(value)) {
    fail(path, "must be a stable identifier");
  }
}

function assertUniqueStrings(
  value: unknown,
  path: string,
  options: { nonEmpty?: boolean; stableIds?: boolean } = {}
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    (options.nonEmpty === true && value.length === 0) ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        (options.stableIds === true && !STABLE_ID_RE.test(entry))
    ) ||
    new Set(value).size !== value.length
  ) {
    fail(path, "must contain unique valid strings");
  }
}

function validateDescriptorValue(
  descriptor: TemplateCapabilityDescriptorV2,
  value: unknown,
  error: (message: string) => never
): void {
  switch (descriptor.valueKind) {
    case "array":
      if (!Array.isArray(value)) error("must be an array");
      return;
    case "object":
      if (!isRecord(value)) error("must be an object");
      return;
    case "boolean":
      if (typeof value !== "boolean") error("must be a boolean");
      return;
    case "color":
      if (typeof value !== "string" || !COLOR_RE.test(value)) {
        error("must be a canonical #RRGGBB color");
      }
      return;
    case "length":
      if (typeof value !== "string" || !LENGTH_RE.test(value)) {
        error("must be a pt/mm/em length");
      }
      return;
    case "number":
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (descriptor.minimum !== undefined && value < descriptor.minimum) ||
        (descriptor.maximum !== undefined && value > descriptor.maximum)
      ) {
        error("must be a finite number within the declared bounds");
      }
      return;
    case "enum":
    case "font-role":
    case "weight":
      if (typeof value !== "string" || !descriptor.enumValues?.includes(value)) {
        error(`must be one of ${(descriptor.enumValues ?? []).join(", ")}`);
      }
      return;
    case "font-family":
    case "string":
      if (typeof value !== "string" || value.length === 0 || value.length > 200) {
        error("must be a non-empty string of at most 200 characters");
      }
      return;
  }
}

function validateWriter(
  writer: unknown,
  path: string
): asserts writer is CapabilityRuntimeWriterV1 {
  if (!isRecord(writer)) fail(path, "must be an object");
  assertExactKeys(writer, ["kind", "id"], path);
  if (writer.kind !== "engine-policy" && writer.kind !== "runtime-binding") {
    fail(`${path}.kind`, "is unknown");
  }
  assertStableId(writer.id, `${path}.id`);
}

function validateDescriptor(candidate: unknown, index: number): TemplateCapabilityDescriptorV2 {
  const base = `descriptors[${index}]`;
  if (!isRecord(candidate)) fail(base, "must be an object");
  assertExactKeys(
    candidate,
    [
      "path",
      "valueKind",
      "required",
      "owner",
      "consumers",
      "compilerRange",
      "stability",
      "proofs",
      "runtimeWriters",
      "writeOrder",
      "enumValues",
      "minimum",
      "maximum"
    ],
    base
  );
  assertPath(candidate.path, `${base}.path`);
  if (!VALUE_KINDS.includes(candidate.valueKind as CapabilityValueKindV2)) {
    fail(`${base}.valueKind`, "is unknown");
  }
  if (typeof candidate.required !== "boolean") {
    fail(`${base}.required`, "must be boolean");
  }
  if (!OWNERS.includes(candidate.owner as CapabilityOwnerV2)) {
    fail(`${base}.owner`, "is unknown");
  }
  assertUniqueStrings(candidate.consumers, `${base}.consumers`, {
    nonEmpty: true
  });
  if (!STABILITIES.includes(candidate.stability as CapabilityStabilityV2)) {
    fail(`${base}.stability`, "is unknown");
  }
  assertUniqueStrings(candidate.proofs, `${base}.proofs`, { nonEmpty: true });
  if (
    (candidate.proofs as readonly string[]).some(
      (proof) => !PROOFS.includes(proof as CapabilityProofV2)
    )
  ) {
    fail(`${base}.proofs`, "contains an unknown proof obligation");
  }
  if (candidate.compilerRange !== undefined) {
    if (typeof candidate.compilerRange !== "string") {
      fail(`${base}.compilerRange`, "must be a supported semver range");
    }
    try {
      satisfiesRange("0.15.1", candidate.compilerRange);
    } catch {
      fail(`${base}.compilerRange`, "must be a supported semver range");
    }
  }

  const writers = candidate.runtimeWriters ?? [];
  if (!Array.isArray(writers)) fail(`${base}.runtimeWriters`, "must be an array");
  const writerIds = new Set<string>();
  for (const [writerIndex, writer] of writers.entries()) {
    validateWriter(writer, `${base}.runtimeWriters[${writerIndex}]`);
    if (writerIds.has(writer.id)) {
      fail(`${base}.runtimeWriters[${writerIndex}].id`, "duplicates a runtime writer");
    }
    writerIds.add(writer.id);
  }
  if (writers.length > 1) {
    const order = candidate.writeOrder;
    if (
      !Array.isArray(order) ||
      order.length !== writers.length ||
      new Set(order).size !== order.length ||
      order.some((writer) => typeof writer !== "string" || !writerIds.has(writer))
    ) {
      fail(`${base}.writeOrder`, "must declare every runtime writer exactly once");
    }
  } else if (candidate.writeOrder !== undefined) {
    fail(`${base}.writeOrder`, "is only valid with multiple runtime writers");
  }

  const enumKind = ["enum", "font-role", "weight"].includes(candidate.valueKind as string);
  if (enumKind) {
    assertUniqueStrings(candidate.enumValues, `${base}.enumValues`, {
      nonEmpty: true
    });
  } else if (candidate.enumValues !== undefined) {
    fail(`${base}.enumValues`, "is not valid for this value kind");
  }
  for (const bound of ["minimum", "maximum"] as const) {
    const value = candidate[bound];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value) || candidate.valueKind !== "number")
    ) {
      fail(`${base}.${bound}`, "is only valid as a finite number bound");
    }
  }
  if (
    typeof candidate.minimum === "number" &&
    typeof candidate.maximum === "number" &&
    candidate.minimum > candidate.maximum
  ) {
    fail(base, "minimum must not exceed maximum");
  }
  return candidate as unknown as TemplateCapabilityDescriptorV2;
}

function requirementKey(requirement: CapabilityRequirementV2): string {
  return `${requirement.kind}:${requirement.id}`;
}

function validateRequirement(
  candidate: unknown,
  path: string,
  catalogPaths: ReadonlySet<string>,
  assets: ReadonlySet<string>,
  labels: ReadonlySet<string>
): CapabilityRequirementV2 {
  if (!isRecord(candidate)) fail(path, "must be an object");
  assertExactKeys(candidate, ["kind", "id"], path);
  if (candidate.kind !== "path" && candidate.kind !== "asset" && candidate.kind !== "label") {
    fail(`${path}.kind`, "is unknown");
  }
  if (candidate.kind === "path") {
    assertPath(candidate.id, `${path}.id`);
    if (!catalogPaths.has(candidate.id)) fail(`${path}.id`, "references an unknown path");
  } else {
    assertStableId(candidate.id, `${path}.id`);
    const known = candidate.kind === "asset" ? assets : labels;
    if (!known.has(candidate.id)) {
      fail(`${path}.id`, `references an unknown ${candidate.kind}`);
    }
  }
  return candidate as unknown as CapabilityRequirementV2;
}

function validateConstraints(
  constraints: readonly unknown[],
  descriptors: readonly TemplateCapabilityDescriptorV2[],
  assets: ReadonlySet<string>,
  labels: ReadonlySet<string>
): readonly CapabilityConstraintV2[] {
  const descriptorByPath = new Map(descriptors.map((descriptor) => [descriptor.path, descriptor]));
  const catalogPaths = new Set(descriptorByPath.keys());
  const graph = new Map<string, Set<string>>();
  const constraintKeys = new Set<string>();
  const effectsByPredicateSet = new Map<string, Map<string, "forbid" | "require">>();
  const validated: CapabilityConstraintV2[] = [];

  for (const [index, candidate] of constraints.entries()) {
    const base = `constraints[${index}]`;
    if (!isRecord(candidate)) fail(base, "must be an object");
    assertExactKeys(candidate, ["when", "require", "forbid"], base);
    if (
      !Array.isArray(candidate.when) ||
      candidate.when.length === 0 ||
      candidate.when.length > MAX_PREDICATES
    ) {
      fail(`${base}.when`, `must contain 1-${MAX_PREDICATES} predicates`);
    }
    const predicates: CapabilityPredicateV2[] = [];
    const predicatePaths = new Set<string>();
    for (const [predicateIndex, rawPredicate] of candidate.when.entries()) {
      const path = `${base}.when[${predicateIndex}]`;
      if (!isRecord(rawPredicate)) fail(path, "must be an object");
      assertExactKeys(rawPredicate, ["path", "equals"], path);
      assertPath(rawPredicate.path, `${path}.path`);
      const descriptor = descriptorByPath.get(rawPredicate.path);
      if (!descriptor) fail(`${path}.path`, "references an unknown predicate path");
      if (predicatePaths.has(rawPredicate.path)) {
        fail(`${path}.path`, "duplicates a predicate path in the same constraint");
      }
      predicatePaths.add(rawPredicate.path);
      if (!["string", "number", "boolean"].includes(typeof rawPredicate.equals)) {
        fail(`${path}.equals`, "must be a string, number, or boolean");
      }
      try {
        validateDescriptorValue(descriptor, rawPredicate.equals, (message) => {
          throw new Error(message);
        });
      } catch {
        fail(`${path}.equals`, "is incompatible with the predicate capability");
      }
      predicates.push(rawPredicate as unknown as CapabilityPredicateV2);
    }

    const readEffects = (key: "require" | "forbid"): readonly CapabilityRequirementV2[] => {
      const raw = candidate[key];
      if (raw === undefined) return [];
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EFFECTS) {
        fail(`${base}.${key}`, `must contain 1-${MAX_EFFECTS} requirements`);
      }
      return raw.map((entry, effectIndex) =>
        validateRequirement(entry, `${base}.${key}[${effectIndex}]`, catalogPaths, assets, labels)
      );
    };
    const require = readEffects("require");
    const forbid = readEffects("forbid");
    if (require.length === 0 && forbid.length === 0) {
      fail(base, "must require or forbid at least one target");
    }
    const requiredKeys = require.map(requirementKey);
    const forbiddenKeys = forbid.map(requirementKey);
    if (new Set(requiredKeys).size !== requiredKeys.length) {
      fail(`${base}.require`, "contains a duplicate target");
    }
    if (new Set(forbiddenKeys).size !== forbiddenKeys.length) {
      fail(`${base}.forbid`, "contains a duplicate target");
    }
    const contradiction = requiredKeys.find((key) => forbiddenKeys.includes(key));
    if (contradiction) fail(base, `both requires and forbids ${contradiction}`);

    const pathEffects = [...require, ...forbid].filter(
      (effect): effect is CapabilityRequirementV2 & { kind: "path" } => effect.kind === "path"
    );
    for (const predicate of predicates) {
      const edges = graph.get(predicate.path) ?? new Set<string>();
      graph.set(predicate.path, edges);
      for (const effect of pathEffects) {
        if (effect.id === predicate.path) {
          fail(base, `contains a self-dependency on ${effect.id}`);
        }
      }
      for (const effect of require) {
        if (effect.kind === "path") edges.add(effect.id);
      }
    }
    const constraint: CapabilityConstraintV2 = {
      when: predicates,
      ...(require.length > 0 ? { require } : {}),
      ...(forbid.length > 0 ? { forbid } : {})
    };
    const constraintKey = canonicalCapabilityJson(canonicalConstraint(constraint));
    if (constraintKeys.has(constraintKey)) fail(base, "duplicates another constraint");
    constraintKeys.add(constraintKey);

    const predicateKey = canonicalCapabilityJson(
      [...predicates].sort((left, right) =>
        canonicalCapabilityJson(left).localeCompare(canonicalCapabilityJson(right))
      )
    );
    const knownEffects = effectsByPredicateSet.get(predicateKey) ?? new Map();
    effectsByPredicateSet.set(predicateKey, knownEffects);
    for (const [effect, requirements] of [
      ["require", require],
      ["forbid", forbid]
    ] as const) {
      for (const requirement of requirements) {
        const key = requirementKey(requirement);
        const known = knownEffects.get(key);
        if (known === effect) fail(base, `duplicates ${effect} target ${key}`);
        if (known !== undefined) fail(base, `contradicts ${known} target ${key}`);
        knownEffects.set(key, effect);
      }
    }
    validated.push(constraint);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (path: string): void => {
    if (visiting.has(path)) fail("constraints", `contains a dependency cycle at ${path}`);
    if (visited.has(path)) return;
    visiting.add(path);
    for (const target of graph.get(path) ?? []) visit(target);
    visiting.delete(path);
    visited.add(path);
  };
  for (const path of graph.keys()) visit(path);
  return validated;
}

/** Validate a schema-V2 catalog without touching V1 canonicalization. */
export function validateCapabilityCatalogV2(value: unknown): TemplateCapabilityCatalogV2 {
  if (!isRecord(value)) fail(undefined, "catalog must be an object");
  assertExactKeys(
    value,
    ["schema", "id", "version", "descriptors", "assets", "labels", "constraints"],
    ""
  );
  if (value.schema !== TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V2) {
    fail("schema", `must be ${TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V2}`);
  }
  assertStableId(value.id, "id");
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
    fail("version", "must be a positive integer");
  }
  if (
    !Array.isArray(value.descriptors) ||
    value.descriptors.length === 0 ||
    value.descriptors.length > MAX_DESCRIPTORS
  ) {
    fail("descriptors", `must contain 1-${MAX_DESCRIPTORS} descriptors`);
  }
  const descriptors = value.descriptors.map(validateDescriptor);
  const paths = new Set<string>();
  for (const descriptor of descriptors) {
    if (paths.has(descriptor.path)) fail(descriptor.path, "has more than one descriptor");
    paths.add(descriptor.path);
  }
  const assets = value.assets ?? [];
  const labels = value.labels ?? [];
  assertUniqueStrings(assets, "assets", { stableIds: true });
  assertUniqueStrings(labels, "labels", { stableIds: true });
  if (!Array.isArray(value.constraints) || value.constraints.length > MAX_CONSTRAINTS) {
    fail("constraints", `must contain at most ${MAX_CONSTRAINTS} constraints`);
  }
  const constraints = validateConstraints(
    value.constraints,
    descriptors,
    new Set(assets),
    new Set(labels)
  );
  return {
    schema: TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V2,
    id: value.id,
    version: value.version as number,
    descriptors,
    ...(assets.length > 0 ? { assets } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    constraints
  };
}

/** Presentation validation for a schema-V2 runtime catalog. */
export function validateCapabilityPresentationRegistryV2(
  catalogValue: unknown,
  value: unknown,
  detailsOnlyTargets: readonly string[]
): TemplateCapabilityPresentationRegistryV1 {
  const catalog = validateCapabilityCatalogV2(catalogValue);
  if (!isRecord(value)) fail(undefined, "presentation registry must be an object");
  assertExactKeys(value, ["schema", "id", "version", "descriptors"], "presentation");
  if (value.schema !== "atlcli.template-capability-presentation/1") {
    fail("presentation.schema", "must be atlcli.template-capability-presentation/1");
  }
  assertStableId(value.id, "presentation.id");
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
    fail("presentation.version", "must be a positive integer");
  }
  if (!Array.isArray(value.descriptors)) {
    fail("presentation.descriptors", "must be an array");
  }
  const catalogPaths = new Set(catalog.descriptors.map(({ path }) => path));
  const details = new Set<string>();
  for (const target of detailsOnlyTargets) {
    if (!catalogPaths.has(target)) fail(target, "details-only target is unknown");
    if (details.has(target)) fail(target, "details-only target is duplicated");
    details.add(target);
  }
  const presented = new Set<string>();
  for (const [index, candidate] of value.descriptors.entries()) {
    const base = `presentation.descriptors[${index}]`;
    if (!isRecord(candidate)) fail(base, "must be an object");
    assertExactKeys(
      candidate,
      ["target", "section", "order", "messageCode", "valueFormat", "comparisonKind", "editKind"],
      base
    );
    assertPath(candidate.target, `${base}.target`);
    if (!catalogPaths.has(candidate.target))
      fail(candidate.target, "presentation target is unknown");
    if (presented.has(candidate.target))
      fail(candidate.target, "has more than one presentation descriptor");
    if (details.has(candidate.target))
      fail(candidate.target, "cannot be both primary and details-only");
    presented.add(candidate.target);
    assertStableId(candidate.section, `${base}.section`);
    if (!Number.isSafeInteger(candidate.order) || (candidate.order as number) < 0) {
      fail(`${base}.order`, "must be a non-negative integer");
    }
    if (typeof candidate.messageCode !== "string" || !MESSAGE_CODE_RE.test(candidate.messageCode)) {
      fail(`${base}.messageCode`, "must be a stable message code");
    }
    if (
      !["boolean", "color", "font", "length", "number", "text"].includes(
        candidate.valueFormat as string
      )
    ) {
      fail(`${base}.valueFormat`, "is unknown");
    }
    if (!["exact", "numeric", "visual"].includes(candidate.comparisonKind as string)) {
      fail(`${base}.comparisonKind`, "is unknown");
    }
    if (
      !["choice", "color", "font", "number", "text", "toggle"].includes(
        candidate.editKind as string
      )
    ) {
      fail(`${base}.editKind`, "is unknown");
    }
  }
  for (const path of catalogPaths) {
    if (!presented.has(path) && !details.has(path)) {
      fail(path, "must have exactly one presentation descriptor or be explicitly details-only");
    }
  }
  return value as unknown as TemplateCapabilityPresentationRegistryV1;
}

function readPath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const segment of path.split(".")) {
    if (!isRecord(cursor) || !(segment in cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function projectDesignV2(
  design: unknown,
  catalog: TemplateCapabilityCatalogV2,
  requireTemplateOwnership: boolean
): DesignOverlayValidationV2 {
  if (!isRecord(design)) failValue("design", "must be an object");
  const rawLeaves = flattenDesign(design);
  const descriptors = new Map(
    catalog.descriptors.map((descriptor) => [descriptor.path, descriptor])
  );
  const flat: Record<string, unknown> = {};
  const suppliedCapabilities: string[] = [];

  for (const descriptor of catalog.descriptors) {
    const value = readPath(design, descriptor.path);
    if (value === undefined) continue;
    if (requireTemplateOwnership && descriptor.owner !== "template") {
      throw new CapabilityValidationError(
        "unknown-capability",
        `${descriptor.path}: ${descriptor.owner}-owned capability cannot appear in template design`,
        descriptor.path
      );
    }
    validateDescriptorValue(descriptor, value, (message) => failValue(descriptor.path, message));
    flat[descriptor.path] = value;
    suppliedCapabilities.push(descriptor.path);
  }

  for (const path of Object.keys(rawLeaves)) {
    if (descriptors.has(path)) continue;
    const objectOwner = catalog.descriptors.find(
      (descriptor) => descriptor.valueKind === "object" && path.startsWith(`${descriptor.path}.`)
    );
    if (objectOwner) continue;
    throw new CapabilityValidationError(
      "unknown-capability",
      `${path}: is not declared by the active capability catalog`,
      path
    );
  }
  return {
    flat,
    suppliedCapabilities: suppliedCapabilities.sort()
  };
}

/** Validate only supplied template-owned leaves; omissions are intentional. */
export function validateDesignOverlayAgainstCatalogV2(
  design: unknown,
  catalogValue: unknown
): DesignOverlayValidationV2 {
  const catalog = validateCapabilityCatalogV2(catalogValue);
  return projectDesignV2(design, catalog, true);
}

/** Require every template-owned required capability after baseline merge. */
export function validateCompleteBaselineV2(
  design: unknown,
  catalogValue: unknown
): Record<string, unknown> {
  const catalog = validateCapabilityCatalogV2(catalogValue);
  const result = projectDesignV2(design, catalog, true);
  const missing = catalog.descriptors
    .filter(
      (descriptor) =>
        descriptor.owner === "template" && descriptor.required && !(descriptor.path in result.flat)
    )
    .map(({ path }) => path)
    .sort()[0];
  if (missing) {
    throw new CapabilityValidationError(
      "incomplete-baseline",
      `${missing}: required capability is missing`,
      missing
    );
  }
  return unflattenDesign(result.flat);
}

function requirementPresent(
  requirement: CapabilityRequirementV2,
  flat: FlatDesignV1,
  context: CapabilityConstraintContextV2
): boolean {
  if (requirement.kind === "path") return requirement.id in flat;
  const values = requirement.kind === "asset" ? (context.assets ?? []) : (context.labels ?? []);
  return values.includes(requirement.id);
}

/** Evaluate active conditional requirements against one projected design. */
export function evaluateCapabilityConstraintsV2(
  design: unknown,
  catalogValue: unknown,
  context: CapabilityConstraintContextV2 = {}
): readonly CapabilityConstraintViolationV2[] {
  const catalog = validateCapabilityCatalogV2(catalogValue);
  const projection = projectDesignV2(design, catalog, false);
  const violations: CapabilityConstraintViolationV2[] = [];
  for (const descriptor of catalog.descriptors) {
    if (
      descriptor.compilerRange !== undefined &&
      descriptor.path in projection.flat &&
      context.compilerVersion !== undefined &&
      !satisfiesRange(context.compilerVersion, descriptor.compilerRange)
    ) {
      violations.push({
        constraint: -1,
        effect: "compiler-unavailable",
        target: { kind: "path", id: descriptor.path }
      });
    }
  }
  for (const [constraintIndex, constraint] of catalog.constraints.entries()) {
    const active = constraint.when.every(
      (predicate) => projection.flat[predicate.path] === predicate.equals
    );
    if (!active) continue;
    for (const requirement of constraint.require ?? []) {
      if (!requirementPresent(requirement, projection.flat, context)) {
        violations.push({
          constraint: constraintIndex,
          effect: "required",
          target: requirement
        });
      }
    }
    for (const requirement of constraint.forbid ?? []) {
      if (requirementPresent(requirement, projection.flat, context)) {
        violations.push({
          constraint: constraintIndex,
          effect: "forbidden",
          target: requirement
        });
      }
    }
  }
  return violations;
}

function canonicalDescriptor(descriptor: TemplateCapabilityDescriptorV2): unknown {
  return {
    ...descriptor,
    consumers: [...descriptor.consumers].sort(),
    proofs: [...descriptor.proofs].sort(),
    ...(descriptor.enumValues ? { enumValues: [...descriptor.enumValues].sort() } : {}),
    ...(descriptor.runtimeWriters
      ? {
          runtimeWriters: [...descriptor.runtimeWriters].sort((left, right) =>
            left.id.localeCompare(right.id)
          )
        }
      : {})
  };
}

function canonicalConstraint(constraint: CapabilityConstraintV2): unknown {
  const byJson = (left: unknown, right: unknown): number =>
    canonicalCapabilityJson(left).localeCompare(canonicalCapabilityJson(right));
  return {
    when: [...constraint.when].sort(byJson),
    ...(constraint.require ? { require: [...constraint.require].sort(byJson) } : {}),
    ...(constraint.forbid ? { forbid: [...constraint.forbid].sort(byJson) } : {})
  };
}

/** Canonical V2 projection; descriptor and constraint declaration order is irrelevant. */
export function canonicalCapabilityCatalogV2(catalogValue: unknown): unknown {
  const catalog = validateCapabilityCatalogV2(catalogValue);
  const constraints = catalog.constraints
    .map(canonicalConstraint)
    .sort((left, right) =>
      canonicalCapabilityJson(left).localeCompare(canonicalCapabilityJson(right))
    );
  return {
    schema: catalog.schema,
    id: catalog.id,
    version: catalog.version,
    descriptors: [...catalog.descriptors]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(canonicalDescriptor),
    ...(catalog.assets ? { assets: [...catalog.assets].sort() } : {}),
    ...(catalog.labels ? { labels: [...catalog.labels].sort() } : {}),
    constraints
  };
}

export async function computeCapabilityCatalogDigestV2(catalog: unknown): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(canonicalCapabilityJson(canonicalCapabilityCatalogV2(catalog)))
  );
}

export async function computeCapabilityPresentationRevisionV2(
  catalog: unknown,
  registry: unknown,
  detailsOnlyTargets: readonly string[]
): Promise<string> {
  const validated = validateCapabilityPresentationRegistryV2(catalog, registry, detailsOnlyTargets);
  return sha256Hex(
    new TextEncoder().encode(
      canonicalCapabilityJson({
        registry: {
          ...validated,
          descriptors: [...validated.descriptors].sort((left, right) =>
            left.target.localeCompare(right.target)
          )
        },
        detailsOnlyTargets: [...detailsOnlyTargets].sort()
      })
    )
  );
}
