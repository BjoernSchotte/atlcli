import { describe, expect, test } from "bun:test";
import {
  CHANGE_SET_SCHEMA_V1,
  ChangeSetValidationErrorV1,
  isChangeSetV1,
  parseChangeSetV1,
  type ChangeOperationV1,
  type ChangeSetV1,
} from "./index.js";

const BASELINE = "a".repeat(64);
const TARGET = "b".repeat(64);
const SOURCE = { baseline: "atlas_doc_format", target: "atlas_doc_format" } as const;

function operationBase(index: number) {
  return {
    id: index.toString(16).repeat(64),
    path: ["content", index] as const,
    matchBasis: "position" as const,
    confidence: "conservative" as const,
    riskTags: ["content-change"] as const,
    source: SOURCE,
    coveredSourceChangeIds: [`source-${index}`] as const,
  };
}

function allOperations(): ChangeOperationV1[] {
  return [
    { ...operationBase(1), kind: "insert", after: { kind: "paragraph", text: "new" } },
    { ...operationBase(2), kind: "delete", before: { kind: "paragraph", text: "old" } },
    { ...operationBase(3), kind: "modify", before: "old", after: "new" },
    {
      ...operationBase(4),
      kind: "move",
      matchBasis: "exact-subtree",
      confidence: "exact",
      fromPath: ["content", 8],
      value: { kind: "heading", text: "Moved" },
    },
    { ...operationBase(5), kind: "collection-add", item: { id: "label-a" } },
    { ...operationBase(6), kind: "collection-remove", item: { id: "label-b" } },
    {
      ...operationBase(7),
      kind: "transition",
      riskTags: ["workflow-transition"],
      before: { id: "1", label: "Open" },
      after: { id: "2", label: "Done" },
    },
    {
      ...operationBase(8),
      kind: "opaque-change",
      matchBasis: "opaque",
      confidence: "ambiguous",
      riskTags: ["opaque", "ambiguous"],
      reason: "unknown extension payload changed",
      before: { extension: "before" },
      after: { extension: "after" },
    },
  ];
}

function fixture(): ChangeSetV1 {
  return {
    schema: CHANGE_SET_SCHEMA_V1,
    subject: { provider: "confluence", kind: "page", id: "123", label: "API Reference" },
    baseline: {
      revision: "3",
      digest: BASELINE,
      representation: "atlas_doc_format",
      deployment: "cloud",
      acquisition: "synthetic-fixture",
    },
    target: {
      revision: "7",
      digest: TARGET,
      representation: "atlas_doc_format",
      deployment: "cloud",
      acquisition: "synthetic-fixture",
    },
    completeness: {
      status: "degraded",
      diagnostics: [{
        code: "opaque-source-change",
        severity: "warning",
        message: "One exact source change is rendered opaquely.",
        sourceChangeIds: ["source-8"],
      }],
    },
    summary: {
      inserts: 2,
      deletes: 2,
      modifies: 2,
      moves: 1,
      opaque: 1,
      noOp: false,
    },
    operations: allOperations(),
    limits: { truncated: false, emittedOperations: 8 },
  };
}

function clone(): Record<string, unknown> {
  return structuredClone(fixture()) as unknown as Record<string, unknown>;
}

describe("ChangeSetV1 runtime contract", () => {
  test("accepts every closed operation variant and returns the exact object", () => {
    const value = fixture();
    expect(parseChangeSetV1(value)).toBe(value);
    expect(isChangeSetV1(value)).toBe(true);
  });

  test("accepts a complete no-op", () => {
    const value: ChangeSetV1 = {
      ...fixture(),
      completeness: { status: "complete", diagnostics: [] },
      summary: { inserts: 0, deletes: 0, modifies: 0, moves: 0, opaque: 0, noOp: true },
      operations: [],
      limits: { truncated: false, emittedOperations: 0, totalOperations: 0 },
    };
    expect(parseChangeSetV1(value)).toBe(value);
  });

  test("accepts explicit truncation only with total counts and a diagnostic", () => {
    const value: ChangeSetV1 = {
      ...fixture(),
      completeness: {
        status: "degraded",
        diagnostics: [{
          code: "limit-exceeded",
          severity: "warning",
          message: "Only one of eight operations was emitted.",
        }],
      },
      operations: allOperations().slice(0, 1),
      limits: { truncated: true, emittedOperations: 1, totalOperations: 8 },
    };
    expect(parseChangeSetV1(value)).toBe(value);

    const missingDiagnostic = structuredClone(value) as ChangeSetV1;
    missingDiagnostic.completeness.diagnostics = [];
    expect(() => parseChangeSetV1(missingDiagnostic)).toThrow("limit-exceeded diagnostic");
  });

  test("rejects schema drift, unknown fields, and unknown operations", () => {
    const wrongSchema = clone();
    wrongSchema.schema = "atlcli.change-set/2";
    expect(() => parseChangeSetV1(wrongSchema)).toThrow("expected atlcli.change-set/1");

    const unknownRoot = clone();
    unknownRoot.extra = true;
    expect(() => parseChangeSetV1(unknownRoot)).toThrow("unknown field");

    const unknownOperation = clone();
    const operations = unknownOperation.operations as Array<Record<string, unknown>>;
    operations[0]!.kind = "rename";
    expect(() => parseChangeSetV1(unknownOperation)).toThrow("unknown operation kind rename");
  });

  test("rejects provider/representation drift and mismatched operation provenance", () => {
    const provider = clone();
    provider.subject = { provider: "jira", kind: "issue", id: "ATL-1" };
    expect(() => parseChangeSetV1(provider)).toThrow("representation is incompatible");

    const provenance = clone();
    const operations = provenance.operations as Array<Record<string, unknown>>;
    operations[0]!.source = { baseline: "storage", target: "storage" };
    expect(() => parseChangeSetV1(provenance)).toThrow("provenance must match");
  });

  test("rejects unsafe moves and incomplete opaque evidence", () => {
    const move = clone();
    const moveOperations = move.operations as Array<Record<string, unknown>>;
    moveOperations[3]!.matchBasis = "position";
    expect(() => parseChangeSetV1(move)).toThrow("moves require stable-id or exact-subtree");

    const opaque = clone();
    const opaqueOperations = opaque.operations as Array<Record<string, unknown>>;
    delete opaqueOperations[7]!.before;
    delete opaqueOperations[7]!.after;
    expect(() => parseChangeSetV1(opaque)).toThrow("requires before or after");

    const completeOpaque = clone();
    (completeOpaque.completeness as Record<string, unknown>).status = "complete";
    expect(() => parseChangeSetV1(completeOpaque)).toThrow("opaque changes require degraded completeness");
  });

  test("rejects inconsistent summaries, limits, and duplicate operation IDs", () => {
    const summary = clone();
    (summary.summary as Record<string, unknown>).inserts = 1;
    expect(() => parseChangeSetV1(summary)).toThrow("summary counts");

    const limits = clone();
    (limits.limits as Record<string, unknown>).emittedOperations = 7;
    expect(() => parseChangeSetV1(limits)).toThrow("must equal operations.length");

    const duplicate = clone();
    const operations = duplicate.operations as Array<Record<string, unknown>>;
    operations[1]!.id = operations[0]!.id;
    expect(() => parseChangeSetV1(duplicate)).toThrow("unique operation IDs");
  });

  test("enforces operation, diagnostic, value, and whole-payload budgets", () => {
    const value = fixture();
    expect(() => parseChangeSetV1(value, {
      maxDepth: 128,
      maxNodes: 100_000,
      maxStringBytes: 100_000,
      maxPayloadBytes: 100_000,
      maxOperations: 7,
      maxDiagnostics: 10,
      maxOperationValueBytes: 10_000,
    })).toThrow("operation budget exceeded");
    expect(() => parseChangeSetV1(value, {
      maxDepth: 128,
      maxNodes: 100_000,
      maxStringBytes: 100_000,
      maxPayloadBytes: 100_000,
      maxOperations: 10,
      maxDiagnostics: 10,
      maxOperationValueBytes: 5,
    })).toThrow("budget exceeded");
  });

  test("rejects non-JSON values before typed traversal", () => {
    const value = clone();
    value.operations = [new Map([["kind", "insert"]])];
    expect(() => parseChangeSetV1(value)).toThrow(ChangeSetValidationErrorV1);
    expect(isChangeSetV1(value)).toBe(false);
  });
});
