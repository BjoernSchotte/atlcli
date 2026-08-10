import {
  canonicalJsonBytesV1,
  type CanonicalJsonBudgetV1,
} from "./canonical-json.js";
import type {
  ChangeOperationDraftV1,
  ChangeSubjectV1,
  SnapshotRepresentationV1,
} from "./types.js";

export const CANONICAL_SOURCE_SCHEMA_V1 = "atlcli.canonical-source/1" as const;
export const CHANGE_OPERATION_ID_SCHEMA_V1 = "atlcli.change-operation-id/1" as const;

const SHA256_HEX = /^[a-f0-9]{64}$/u;

/** Calibrated for a bounded 100k-node canonical source tree plus envelope. */
const SNAPSHOT_DIGEST_JSON_BUDGET_V1: Readonly<CanonicalJsonBudgetV1> = Object.freeze({
  maxDepth: 256,
  maxNodes: 5_000_000,
  maxStringBytes: 32 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
});

export class ChangeDigestErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeDigestErrorV1";
  }
}

/** Browser-compatible SHA-256. Absence of Web Crypto is fatal. */
export async function sha256HexV1(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array)) {
    throw new ChangeDigestErrorV1("SHA-256 input must be a Uint8Array");
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ChangeDigestErrorV1("Web Crypto SHA-256 is unavailable");
  }
  const source: Uint8Array<ArrayBuffer> =
    bytes.buffer instanceof ArrayBuffer
      ? (bytes as Uint8Array<ArrayBuffer>)
      : bytes.slice();
  const digest = new Uint8Array(await subtle.digest("SHA-256", source));
  return [...digest]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 over canonical JSON bytes. */
export async function digestCanonicalJsonV1(value: unknown): Promise<string> {
  return sha256HexV1(canonicalJsonBytesV1(value));
}

/**
 * Digest one canonical source snapshot exactly as `atlcli.canonical-source/1`.
 * This never hashes raw REST bytes, semantic projections, or rendered output.
 */
export async function digestSnapshotV1(
  representation: SnapshotRepresentationV1,
  canonicalSourceTree: unknown,
): Promise<string> {
  if (
    representation !== "atlas_doc_format" &&
    representation !== "storage" &&
    representation !== "jira-fields"
  ) {
    throw new ChangeDigestErrorV1("snapshot representation is unsupported");
  }
  return sha256HexV1(canonicalJsonBytesV1({
    schema: CANONICAL_SOURCE_SCHEMA_V1,
    representation,
    tree: canonicalSourceTree,
  }, SNAPSHOT_DIGEST_JSON_BUDGET_V1));
}

export interface ChangeOperationIdContextV1 {
  subject: ChangeSubjectV1;
  baselineDigest: string;
  targetDigest: string;
}

function requireDigest(value: string, name: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new ChangeDigestErrorV1(`${name} must be a lowercase SHA-256 digest`);
  }
}

function operationIdentity(operation: ChangeOperationDraftV1): unknown {
  const common = { kind: operation.kind, path: operation.path } as const;
  switch (operation.kind) {
    case "insert":
      return { ...common, after: operation.after };
    case "delete":
      return { ...common, before: operation.before };
    case "modify":
      return { ...common, before: operation.before, after: operation.after };
    case "move":
      return { ...common, fromPath: operation.fromPath, value: operation.value };
    case "collection-add":
    case "collection-remove":
      return { ...common, item: operation.item };
    case "transition":
      return { ...common, before: operation.before, after: operation.after };
    case "opaque-change":
      return {
        ...common,
        reason: operation.reason,
        ...(operation.before !== undefined ? { before: operation.before } : {}),
        ...(operation.after !== undefined ? { after: operation.after } : {}),
      };
  }
}

/**
 * Deterministic ID bound to subject, both snapshots, operation kind, paths,
 * and canonical changed values. Review metadata does not alter identity.
 */
export async function createChangeOperationIdV1(
  context: ChangeOperationIdContextV1,
  operation: ChangeOperationDraftV1,
): Promise<string> {
  requireDigest(context.baselineDigest, "baselineDigest");
  requireDigest(context.targetDigest, "targetDigest");
  return digestCanonicalJsonV1({
    schema: CHANGE_OPERATION_ID_SCHEMA_V1,
    subject: context.subject,
    baselineDigest: context.baselineDigest,
    targetDigest: context.targetDigest,
    operation: operationIdentity(operation),
  });
}
