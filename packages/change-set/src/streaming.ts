import {
  CanonicalJsonErrorV1,
  DEFAULT_CANONICAL_JSON_BUDGET_V1,
  type CanonicalJsonBudgetV1,
} from "./canonical-json.js";
import {
  CANONICAL_SOURCE_SCHEMA_V1,
  ChangeDigestErrorV1,
} from "./digest.js";
import type {
  CanonicalJsonObject,
  CanonicalJsonValue,
  SemanticPathV1,
  SnapshotRepresentationV1,
} from "./types.js";

const encoder = new TextEncoder();
const SHA256_HEX = /^[a-f0-9]{64}$/u;

/** Default transport chunk size. It does not affect canonical bytes. */
export const DEFAULT_CANONICAL_JSON_CHUNK_BYTES_V1 = 64 * 1024;
export const MAX_CANONICAL_JSON_CHUNK_BYTES_V1 = 1024 * 1024;

/** Calibrated for a bounded 100k-node canonical source tree plus envelope. */
export const SNAPSHOT_STREAMING_JSON_BUDGET_V1:
Readonly<CanonicalJsonBudgetV1> = Object.freeze({
  maxDepth: 256,
  maxNodes: 5_000_000,
  maxStringBytes: 32 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
});

export interface CanonicalJsonChunkOptionsV1 {
  readonly budget?: CanonicalJsonBudgetV1;
  readonly chunkBytes?: number;
}

function fail(path: string, message: string): never {
  throw new CanonicalJsonErrorV1(path, message);
}

function positiveBudget(value: number, name: keyof CanonicalJsonBudgetV1): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("$", `${name} must be a positive safe integer`);
  }
}

function propertyValue(object: object, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    return fail(path, "expected an enumerable data property");
  }
  return descriptor.value;
}

/**
 * Produce canonical JSON tokens without constructing the complete serialized
 * document. This intentionally mirrors `canonicalJsonV1` validation and
 * budget semantics.
 */
function* canonicalJsonTokensV1(
  value: unknown,
  budget: CanonicalJsonBudgetV1,
): Generator<string, void, void> {
  positiveBudget(budget.maxDepth, "maxDepth");
  positiveBudget(budget.maxNodes, "maxNodes");
  positiveBudget(budget.maxStringBytes, "maxStringBytes");
  positiveBudget(budget.maxOutputBytes, "maxOutputBytes");

  let nodes = 0;
  let stringBytes = 0;
  const active = new WeakSet<object>();

  const countString = (item: string, path: string): void => {
    stringBytes += encoder.encode(item).byteLength;
    if (stringBytes > budget.maxStringBytes) {
      fail(path, "string-byte budget exceeded");
    }
  };

  function* walk(
    item: unknown,
    path: string,
    depth: number,
  ): Generator<string, void, void> {
    nodes += 1;
    if (nodes > budget.maxNodes) fail(path, "node budget exceeded");
    if (depth > budget.maxDepth) fail(path, "depth budget exceeded");

    if (item === null || typeof item === "boolean") {
      yield JSON.stringify(item);
      return;
    }
    if (typeof item === "string") {
      countString(item, path);
      yield JSON.stringify(item);
      return;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail(path, "expected a finite number");
      yield JSON.stringify(item);
      return;
    }
    if (typeof item !== "object") {
      fail(path, "expected JSON-only data");
    }
    if (active.has(item)) fail(path, "cyclic value");
    active.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getOwnPropertySymbols(item).length > 0) {
          fail(path, "symbol properties are not JSON data");
        }
        const ownNames = Object.getOwnPropertyNames(item);
        if (ownNames.some((key) => key !== "length" && !/^(0|[1-9]\d*)$/u.test(key))) {
          fail(path, "array has non-index properties");
        }
        yield "[";
        for (let index = 0; index < item.length; index += 1) {
          if (!Object.hasOwn(item, index)) {
            fail(`${path}[${index}]`, "sparse arrays are not JSON data");
          }
          if (index > 0) yield ",";
          yield* walk(
            propertyValue(item, String(index), `${path}[${index}]`),
            `${path}[${index}]`,
            depth + 1,
          );
        }
        yield "]";
        return;
      }

      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        fail(path, "expected a plain object");
      }
      if (Object.getOwnPropertySymbols(item).length > 0) {
        fail(path, "symbol properties are not JSON data");
      }
      const ownNames = Object.getOwnPropertyNames(item);
      const keys = Object.keys(item);
      if (ownNames.length !== keys.length) {
        fail(path, "non-enumerable properties are not JSON data");
      }
      keys.sort();
      yield "{";
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        countString(key, `${path}.${key}`);
        if (index > 0) yield ",";
        yield `${JSON.stringify(key)}:`;
        yield* walk(
          propertyValue(item, key, `${path}.${key}`),
          `${path}.${key}`,
          depth + 1,
        );
      }
      yield "}";
    } finally {
      active.delete(item);
    }
  }

  yield* walk(value, "$", 0);
}

/**
 * Stream the exact UTF-8 bytes of `canonicalJsonV1` in bounded chunks.
 *
 * Each yielded chunk has independent backing storage and must be treated as
 * read-only. A validation or budget failure may occur after earlier chunks
 * were yielded; digest sinks therefore need an abort path.
 */
export function* canonicalJsonChunksV1(
  value: unknown,
  options: CanonicalJsonChunkOptionsV1 = {},
): Generator<Uint8Array, void, void> {
  const budget = options.budget ?? DEFAULT_CANONICAL_JSON_BUDGET_V1;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CANONICAL_JSON_CHUNK_BYTES_V1;
  positiveBudget(budget.maxDepth, "maxDepth");
  positiveBudget(budget.maxNodes, "maxNodes");
  positiveBudget(budget.maxStringBytes, "maxStringBytes");
  positiveBudget(budget.maxOutputBytes, "maxOutputBytes");
  if (
    !Number.isSafeInteger(chunkBytes) ||
    chunkBytes < 1 ||
    chunkBytes > MAX_CANONICAL_JSON_CHUNK_BYTES_V1
  ) {
    fail(
      "$",
      `chunkBytes must be between 1 and ${MAX_CANONICAL_JSON_CHUNK_BYTES_V1}`,
    );
  }

  let outputBytes = 0;
  let pending = new Uint8Array(chunkBytes);
  let pendingLength = 0;

  for (const token of canonicalJsonTokensV1(value, budget)) {
    const bytes = encoder.encode(token);
    outputBytes += bytes.byteLength;
    if (outputBytes > budget.maxOutputBytes) {
      fail("$", "output-byte budget exceeded");
    }

    let offset = 0;
    while (offset < bytes.byteLength) {
      const writable = Math.min(chunkBytes - pendingLength, bytes.byteLength - offset);
      pending.set(bytes.subarray(offset, offset + writable), pendingLength);
      pendingLength += writable;
      offset += writable;
      if (pendingLength === chunkBytes) {
        yield pending;
        pending = new Uint8Array(chunkBytes);
        pendingLength = 0;
      }
    }
  }

  if (pendingLength > 0) {
    yield pending.slice(0, pendingLength);
  }
}

/** Host-provided cryptographic digest state for canonical byte chunks. */
export interface CanonicalChunkDigestSinkV1 {
  write(chunk: Uint8Array): void | Promise<void>;
  finish(): string | Promise<string>;
  abort?(reason?: unknown): void | Promise<void>;
}

async function abortSink(
  sink: CanonicalChunkDigestSinkV1,
  reason: unknown,
): Promise<void> {
  try {
    await sink.abort?.(reason);
  } catch {
    // Preserve the canonicalization, write, or digest error that caused abort.
  }
}

/** Feed canonical JSON chunks into an injected incremental SHA-256 sink. */
export async function digestCanonicalJsonWithSinkV1(
  value: unknown,
  sink: CanonicalChunkDigestSinkV1,
  options?: CanonicalJsonChunkOptionsV1,
): Promise<string> {
  try {
    for (const chunk of canonicalJsonChunksV1(value, options)) {
      await sink.write(chunk);
    }
    const digest = await sink.finish();
    if (!SHA256_HEX.test(digest)) {
      throw new ChangeDigestErrorV1(
        "incremental SHA-256 sink returned an invalid digest",
      );
    }
    return digest;
  } catch (error) {
    await abortSink(sink, error);
    throw error;
  }
}

/**
 * Incrementally digest the exact `atlcli.canonical-source/1` snapshot envelope.
 */
export async function digestSnapshotWithSinkV1(
  representation: SnapshotRepresentationV1,
  canonicalSourceTree: unknown,
  sink: CanonicalChunkDigestSinkV1,
): Promise<string> {
  if (
    representation !== "atlas_doc_format" &&
    representation !== "storage" &&
    representation !== "jira-fields"
  ) {
    throw new ChangeDigestErrorV1("snapshot representation is unsupported");
  }
  return digestCanonicalJsonWithSinkV1({
    schema: CANONICAL_SOURCE_SCHEMA_V1,
    representation,
    tree: canonicalSourceTree,
  }, sink, { budget: SNAPSHOT_STREAMING_JSON_BUDGET_V1 });
}

export type SpillSnapshotSideV1 = "baseline" | "target";
export type SpillRecordLayerV1 = "source" | "semantic";

export interface SpillSnapshotDescriptorV1 {
  readonly side: SpillSnapshotSideV1;
  readonly representation: SnapshotRepresentationV1;
  readonly revision: string;
}

/** One bounded, deterministic flat-tree row stored by the spill adapter. */
export interface SpillNodeRecordV1 {
  readonly side: SpillSnapshotSideV1;
  readonly layer: SpillRecordLayerV1;
  /** Pre-order ordinal unique within one side and layer. */
  readonly ordinal: number;
  readonly parentOrdinal: number | null;
  readonly childIndex: number;
  readonly path: SemanticPathV1;
  readonly kind: string;
  readonly shallow: CanonicalJsonObject;
  readonly subtreeDigest: string;
  readonly stableId?: string;
  readonly opaque?: boolean;
}

/**
 * Projection event emitted while a source adapter walks one validated tree.
 * The close event supplies the post-order digest needed to complete a record.
 */
export type CanonicalTreeEventV1 =
  | {
      readonly type: "node-open";
      readonly node: Omit<SpillNodeRecordV1, "subtreeDigest">;
    }
  | {
      readonly type: "node-close";
      readonly side: SpillSnapshotSideV1;
      readonly layer: SpillRecordLayerV1;
      readonly ordinal: number;
      readonly subtreeDigest: string;
    };

export interface SpillSnapshotFinalV1 {
  readonly side: SpillSnapshotSideV1;
  readonly digest: string;
  readonly sourceNodeCount: number;
  readonly semanticNodeCount: number;
}

export interface SpillChildWindowQueryV1 {
  readonly side: SpillSnapshotSideV1;
  readonly layer: SpillRecordLayerV1;
  readonly parentOrdinal: number | null;
  readonly offset: number;
  readonly limit: number;
}

export interface SpillChildWindowV1 {
  readonly records: readonly SpillNodeRecordV1[];
  readonly nextOffset?: number;
}

export interface SpillCandidateQueryV1 {
  readonly side: SpillSnapshotSideV1;
  readonly layer: SpillRecordLayerV1;
  readonly basis: "stable-id" | "exact-subtree";
  readonly key: string;
  readonly excludeOrdinal?: number;
}

export type SpillCandidateLookupV1 =
  | { readonly status: "none" }
  | { readonly status: "unique"; readonly record: SpillNodeRecordV1 }
  | { readonly status: "ambiguous" };

export interface SpillSubtreeReadV1 {
  readonly side: SpillSnapshotSideV1;
  readonly layer: SpillRecordLayerV1;
  readonly ordinal: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

/**
 * Browser-neutral ephemeral spill port. Implementations own persistence,
 * quotas, private-path lifecycle, and deterministic query ordering.
 */
export interface SpillStoreV1 {
  beginSnapshot(descriptor: SpillSnapshotDescriptorV1): Promise<void>;
  appendRecords(records: readonly SpillNodeRecordV1[]): Promise<void>;
  finalizeSnapshot(snapshot: SpillSnapshotFinalV1): Promise<void>;
  readChildWindow(query: SpillChildWindowQueryV1): Promise<SpillChildWindowV1>;
  findCandidate(query: SpillCandidateQueryV1): Promise<SpillCandidateLookupV1>;
  readSubtreeValue(query: SpillSubtreeReadV1): Promise<CanonicalJsonValue>;
  close(): Promise<void>;
  erase(): Promise<void>;
}
