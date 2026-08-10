import {
  canonicalJsonBytesV1,
  canonicalJsonV1,
} from "./canonical-json.js";
import type {
  CanonicalJsonValue,
  ChangeConfidenceV1,
  ChangeDiagnosticCodeV1,
  ChangeMatchBasisV1,
  ChangeOperationV1,
  ChangeRiskTagV1,
  ChangeSetV1,
  ChangeSubjectV1,
  SemanticPathV1,
  SnapshotAcquisitionV1,
  SnapshotRefV1,
  SnapshotRepresentationV1,
} from "./types.js";

export const CHANGE_SET_SCHEMA_V1 = "atlcli.change-set/1" as const;

export interface ChangeSetValidationBudgetV1 {
  maxDepth: number;
  maxNodes: number;
  maxStringBytes: number;
  maxPayloadBytes: number;
  maxOperations: number;
  maxDiagnostics: number;
  maxOperationValueBytes: number;
}

export const DEFAULT_CHANGE_SET_VALIDATION_BUDGET_V1:
Readonly<ChangeSetValidationBudgetV1> = Object.freeze({
  maxDepth: 128,
  maxNodes: 250_000,
  maxStringBytes: 8 * 1024 * 1024,
  maxPayloadBytes: 16 * 1024 * 1024,
  maxOperations: 10_000,
  maxDiagnostics: 1_000,
  maxOperationValueBytes: 64 * 1024,
});

export class ChangeSetValidationErrorV1 extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ChangeSetValidationErrorV1";
  }
}

type JsonRecord = Record<string, unknown>;
type OperationCountKind = "insert" | "delete" | "modify" | "move" | "opaque";

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const REPRESENTATIONS = ["atlas_doc_format", "storage", "jira-fields"] as const;
const ACQUISITIONS = [
  "rest-v2",
  "rest-v1",
  "planned-operation",
  "synthetic-fixture",
  "local-file",
] as const;
const MATCH_BASES = ["stable-id", "exact-subtree", "sequence", "position", "opaque"] as const;
const CONFIDENCES = ["exact", "anchored", "conservative", "ambiguous"] as const;
const RISK_TAGS = [
  "content-change",
  "structure-change",
  "identity-change",
  "collection-change",
  "workflow-transition",
  "destructive",
  "opaque",
  "ambiguous",
] as const;
const DIAGNOSTIC_CODES = [
  "ambiguous-match",
  "opaque-source-change",
  "source-fallback",
  "source-incomplete",
  "limit-exceeded",
  "policy-noise",
  "unavailable-transition",
  "missing-observed-value",
] as const;

function fail(path: string, message: string): never {
  throw new ChangeSetValidationErrorV1(path, message);
}

function validateBudgets(budget: ChangeSetValidationBudgetV1): void {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      fail("$", `${name} must be a positive safe integer`);
    }
  }
}

function record(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, "expected a plain object");
  }
  return value as JsonRecord;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) return fail(path, "expected an array");
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") return fail(path, "expected a string");
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  const candidate = string(value, path);
  if (candidate.length === 0) return fail(path, "expected a non-empty string");
  return candidate;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return fail(path, "expected a boolean");
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return fail(path, "expected a non-negative safe integer");
  }
  return value as number;
}

function oneOf<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  const candidate = string(value, path);
  if (!(allowed as readonly string[]).includes(candidate)) {
    return fail(path, `expected one of ${allowed.join(", ")}`);
  }
  return candidate as T;
}

function keys(object: JsonRecord, path: string, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allow.has(key)) fail(`${path}.${key}`, "unknown field");
  }
}

function optional(
  object: JsonRecord,
  key: string,
  path: string,
  validate: (value: unknown, path: string) => unknown,
): void {
  if (object[key] !== undefined) validate(object[key], `${path}.${key}`);
}

function uniqueStrings(value: unknown, path: string): readonly string[] {
  const seen = new Set<string>();
  return array(value, path).map((entry, index) => {
    const item = nonEmptyString(entry, `${path}[${index}]`);
    if (seen.has(item)) fail(`${path}[${index}]`, "expected unique values");
    seen.add(item);
    return item;
  });
}

function semanticPath(value: unknown, path: string): SemanticPathV1 {
  return array(value, path).map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof entry === "string") {
      if (entry.length === 0) fail(itemPath, "expected a non-empty path segment");
      return entry;
    }
    return nonNegativeInteger(entry, itemPath);
  });
}

function digest(value: unknown, path: string): string {
  const candidate = string(value, path);
  if (!SHA256_HEX.test(candidate)) {
    return fail(path, "expected a lowercase SHA-256 digest");
  }
  return candidate;
}

function subject(value: unknown, path: string): ChangeSubjectV1 {
  const object = record(value, path);
  keys(object, path, ["provider", "kind", "id", "label"]);
  const provider = oneOf(object.provider, `${path}.provider`, ["confluence", "jira"]);
  const kind = oneOf(object.kind, `${path}.kind`, ["page", "issue"]);
  if (
    (provider === "confluence" && kind !== "page") ||
    (provider === "jira" && kind !== "issue")
  ) {
    fail(`${path}.kind`, `kind ${kind} is incompatible with provider ${provider}`);
  }
  nonEmptyString(object.id, `${path}.id`);
  optional(object, "label", path, string);
  return object as ChangeSubjectV1;
}

function snapshot(value: unknown, path: string): SnapshotRefV1 {
  const object = record(value, path);
  keys(object, path, ["revision", "digest", "representation", "deployment", "acquisition"]);
  nonEmptyString(object.revision, `${path}.revision`);
  digest(object.digest, `${path}.digest`);
  oneOf<SnapshotRepresentationV1>(object.representation, `${path}.representation`, REPRESENTATIONS);
  if (object.deployment !== undefined) {
    oneOf(object.deployment, `${path}.deployment`, ["cloud", "data-center"]);
  }
  oneOf<SnapshotAcquisitionV1>(object.acquisition, `${path}.acquisition`, ACQUISITIONS);
  return object as unknown as SnapshotRefV1;
}

function sourceProvenance(value: unknown, path: string): void {
  const object = record(value, path);
  keys(object, path, ["baseline", "target"]);
  oneOf<SnapshotRepresentationV1>(object.baseline, `${path}.baseline`, REPRESENTATIONS);
  oneOf<SnapshotRepresentationV1>(object.target, `${path}.target`, REPRESENTATIONS);
}

function riskTags(value: unknown, path: string): readonly ChangeRiskTagV1[] {
  const seen = new Set<string>();
  return array(value, path).map((entry, index) => {
    const tag = oneOf<ChangeRiskTagV1>(entry, `${path}[${index}]`, RISK_TAGS);
    if (seen.has(tag)) fail(`${path}[${index}]`, "expected unique risk tags");
    seen.add(tag);
    return tag;
  });
}

function boundedValue(
  value: unknown,
  path: string,
  budget: ChangeSetValidationBudgetV1,
): asserts value is CanonicalJsonValue {
  try {
    canonicalJsonBytesV1(value, {
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
      maxStringBytes: budget.maxOperationValueBytes,
      maxOutputBytes: budget.maxOperationValueBytes,
    });
  } catch (error) {
    fail(path, error instanceof Error ? error.message : "invalid bounded JSON value");
  }
}

function entityRef(value: unknown, path: string): void {
  const object = record(value, path);
  keys(object, path, ["id", "label"]);
  nonEmptyString(object.id, `${path}.id`);
  optional(object, "label", path, string);
}

interface ValidatedOperation {
  operation: ChangeOperationV1;
  countKind: OperationCountKind;
}

function operation(
  value: unknown,
  path: string,
  budget: ChangeSetValidationBudgetV1,
): ValidatedOperation {
  const object = record(value, path);
  const kind = nonEmptyString(object.kind, `${path}.kind`);
  const common = [
    "id",
    "kind",
    "path",
    "matchBasis",
    "confidence",
    "riskTags",
    "source",
    "coveredSourceChangeIds",
  ];
  digest(object.id, `${path}.id`);
  semanticPath(object.path, `${path}.path`);
  const matchBasis = oneOf<ChangeMatchBasisV1>(object.matchBasis, `${path}.matchBasis`, MATCH_BASES);
  const confidence = oneOf<ChangeConfidenceV1>(object.confidence, `${path}.confidence`, CONFIDENCES);
  riskTags(object.riskTags, `${path}.riskTags`);
  sourceProvenance(object.source, `${path}.source`);
  uniqueStrings(object.coveredSourceChangeIds, `${path}.coveredSourceChangeIds`);

  switch (kind) {
    case "insert":
      keys(object, path, [...common, "after"]);
      boundedValue(object.after, `${path}.after`, budget);
      return { operation: object as unknown as ChangeOperationV1, countKind: "insert" };
    case "delete":
      keys(object, path, [...common, "before"]);
      boundedValue(object.before, `${path}.before`, budget);
      return { operation: object as unknown as ChangeOperationV1, countKind: "delete" };
    case "modify":
      keys(object, path, [...common, "before", "after"]);
      boundedValue(object.before, `${path}.before`, budget);
      boundedValue(object.after, `${path}.after`, budget);
      return { operation: object as unknown as ChangeOperationV1, countKind: "modify" };
    case "move":
      keys(object, path, [...common, "fromPath", "value"]);
      semanticPath(object.fromPath, `${path}.fromPath`);
      boundedValue(object.value, `${path}.value`, budget);
      if (matchBasis !== "stable-id" && matchBasis !== "exact-subtree") {
        fail(`${path}.matchBasis`, "moves require stable-id or exact-subtree matching");
      }
      if (confidence !== "exact" && confidence !== "anchored") {
        fail(`${path}.confidence`, "moves require exact or anchored confidence");
      }
      return { operation: object as unknown as ChangeOperationV1, countKind: "move" };
    case "collection-add":
      keys(object, path, [...common, "item"]);
      boundedValue(object.item, `${path}.item`, budget);
      return { operation: object as unknown as ChangeOperationV1, countKind: "insert" };
    case "collection-remove":
      keys(object, path, [...common, "item"]);
      boundedValue(object.item, `${path}.item`, budget);
      return { operation: object as unknown as ChangeOperationV1, countKind: "delete" };
    case "transition":
      keys(object, path, [...common, "before", "after"]);
      entityRef(object.before, `${path}.before`);
      entityRef(object.after, `${path}.after`);
      return { operation: object as unknown as ChangeOperationV1, countKind: "modify" };
    case "opaque-change":
      keys(object, path, [...common, "reason", "before", "after"]);
      nonEmptyString(object.reason, `${path}.reason`);
      if (object.before === undefined && object.after === undefined) {
        fail(path, "opaque-change requires before or after");
      }
      if (object.before !== undefined) boundedValue(object.before, `${path}.before`, budget);
      if (object.after !== undefined) boundedValue(object.after, `${path}.after`, budget);
      if (matchBasis !== "opaque") {
        fail(`${path}.matchBasis`, "opaque-change requires opaque matching");
      }
      return { operation: object as unknown as ChangeOperationV1, countKind: "opaque" };
    default:
      return fail(`${path}.kind`, `unknown operation kind ${kind}`);
  }
}

function diagnostic(value: unknown, path: string): ChangeDiagnosticCodeV1 {
  const object = record(value, path);
  keys(object, path, ["code", "severity", "message", "path", "sourceChangeIds"]);
  const code = oneOf<ChangeDiagnosticCodeV1>(object.code, `${path}.code`, DIAGNOSTIC_CODES);
  oneOf(object.severity, `${path}.severity`, ["info", "warning", "error"]);
  nonEmptyString(object.message, `${path}.message`);
  optional(object, "path", path, semanticPath);
  optional(object, "sourceChangeIds", path, uniqueStrings);
  return code;
}

/** Validate and return the caller's exact ChangeSet object. */
export function parseChangeSetV1(
  value: unknown,
  budget: ChangeSetValidationBudgetV1 = DEFAULT_CHANGE_SET_VALIDATION_BUDGET_V1,
): ChangeSetV1 {
  validateBudgets(budget);
  try {
    canonicalJsonV1(value, {
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
      maxStringBytes: budget.maxStringBytes,
      maxOutputBytes: budget.maxPayloadBytes,
    });
  } catch (error) {
    fail("$", error instanceof Error ? error.message : "expected bounded JSON-only data");
  }

  const root = record(value, "$" );
  keys(root, "$", ["schema", "subject", "baseline", "target", "completeness", "summary", "operations", "limits"]);
  if (root.schema !== CHANGE_SET_SCHEMA_V1) {
    fail("$.schema", `expected ${CHANGE_SET_SCHEMA_V1}`);
  }
  const validatedSubject = subject(root.subject, "$.subject");
  const baseline = snapshot(root.baseline, "$.baseline");
  const target = snapshot(root.target, "$.target");
  if (baseline.representation !== target.representation) {
    fail("$.target.representation", "baseline and target representations must match");
  }
  if (
    baseline.deployment !== undefined &&
    target.deployment !== undefined &&
    baseline.deployment !== target.deployment
  ) {
    fail("$.target.deployment", "baseline and target deployments must match");
  }
  if (
    (validatedSubject.provider === "confluence" && baseline.representation === "jira-fields") ||
    (validatedSubject.provider === "jira" && baseline.representation !== "jira-fields")
  ) {
    fail("$.baseline.representation", "representation is incompatible with the subject provider");
  }

  const completeness = record(root.completeness, "$.completeness");
  keys(completeness, "$.completeness", ["status", "diagnostics"]);
  const completenessStatus = oneOf(
    completeness.status,
    "$.completeness.status",
    ["complete", "degraded"],
  );
  const diagnostics = array(completeness.diagnostics, "$.completeness.diagnostics");
  if (diagnostics.length > budget.maxDiagnostics) {
    fail("$.completeness.diagnostics", "diagnostic budget exceeded");
  }
  const diagnosticCodes = diagnostics.map((entry, index) =>
    diagnostic(entry, `$.completeness.diagnostics[${index}]`));

  const operations = array(root.operations, "$.operations");
  if (operations.length > budget.maxOperations) {
    fail("$.operations", "operation budget exceeded");
  }
  const counts: Record<OperationCountKind, number> = {
    insert: 0,
    delete: 0,
    modify: 0,
    move: 0,
    opaque: 0,
  };
  const operationIds = new Set<string>();
  for (let index = 0; index < operations.length; index += 1) {
    const validated = operation(operations[index], `$.operations[${index}]`, budget);
    counts[validated.countKind] += 1;
    if (operationIds.has(validated.operation.id)) {
      fail(`$.operations[${index}].id`, "expected unique operation IDs");
    }
    operationIds.add(validated.operation.id);
    if (
      validated.operation.source.baseline !== baseline.representation ||
      validated.operation.source.target !== target.representation
    ) {
      fail(`$.operations[${index}].source`, "operation provenance must match the snapshots");
    }
  }

  const summary = record(root.summary, "$.summary");
  keys(summary, "$.summary", ["inserts", "deletes", "modifies", "moves", "opaque", "noOp"]);
  const summaryCounts = {
    insert: nonNegativeInteger(summary.inserts, "$.summary.inserts"),
    delete: nonNegativeInteger(summary.deletes, "$.summary.deletes"),
    modify: nonNegativeInteger(summary.modifies, "$.summary.modifies"),
    move: nonNegativeInteger(summary.moves, "$.summary.moves"),
    opaque: nonNegativeInteger(summary.opaque, "$.summary.opaque"),
  };
  const noOp = boolean(summary.noOp, "$.summary.noOp");
  const summarizedTotal = Object.values(summaryCounts).reduce((sum, count) => sum + count, 0);
  if (noOp !== (summarizedTotal === 0)) {
    fail("$.summary.noOp", "noOp must agree with the summary counts");
  }

  const limits = record(root.limits, "$.limits");
  keys(limits, "$.limits", ["truncated", "emittedOperations", "totalOperations"]);
  const truncated = boolean(limits.truncated, "$.limits.truncated");
  const emittedOperations = nonNegativeInteger(limits.emittedOperations, "$.limits.emittedOperations");
  if (emittedOperations !== operations.length) {
    fail("$.limits.emittedOperations", "must equal operations.length");
  }
  let totalOperations: number | undefined;
  if (limits.totalOperations !== undefined) {
    totalOperations = nonNegativeInteger(limits.totalOperations, "$.limits.totalOperations");
    if (totalOperations < emittedOperations) {
      fail("$.limits.totalOperations", "must not be less than emittedOperations");
    }
  }
  if (truncated && (totalOperations === undefined || totalOperations <= emittedOperations)) {
    fail("$.limits.totalOperations", "truncated ChangeSets require a larger totalOperations count");
  }
  if (!truncated && totalOperations !== undefined && totalOperations !== emittedOperations) {
    fail("$.limits.totalOperations", "non-truncated totalOperations must equal emittedOperations");
  }
  const expectedTotal = totalOperations ?? emittedOperations;
  if (summarizedTotal !== expectedTotal) {
    fail("$.summary", "summary counts must equal the total operation count");
  }
  if (!truncated) {
    for (const countKind of Object.keys(counts) as OperationCountKind[]) {
      if (summaryCounts[countKind] !== counts[countKind]) {
        fail(`$.summary.${countKind === "insert" ? "inserts" : countKind === "delete" ? "deletes" : countKind === "modify" ? "modifies" : countKind === "move" ? "moves" : "opaque"}`, "summary count does not match emitted operations");
      }
    }
  }

  const hasOpaque = counts.opaque > 0;
  const hasLimitDiagnostic = diagnosticCodes.includes("limit-exceeded");
  const hasOpaqueDiagnostic = diagnosticCodes.includes("opaque-source-change");
  if (truncated && (completenessStatus !== "degraded" || !hasLimitDiagnostic)) {
    fail("$.completeness", "truncation requires degraded completeness and a limit-exceeded diagnostic");
  }
  if (hasOpaque && (completenessStatus !== "degraded" || !hasOpaqueDiagnostic)) {
    fail("$.completeness", "opaque changes require degraded completeness and an opaque-source-change diagnostic");
  }

  return root as unknown as ChangeSetV1;
}

export function isChangeSetV1(
  value: unknown,
  budget?: ChangeSetValidationBudgetV1,
): value is ChangeSetV1 {
  try {
    parseChangeSetV1(value, budget);
    return true;
  } catch {
    return false;
  }
}
