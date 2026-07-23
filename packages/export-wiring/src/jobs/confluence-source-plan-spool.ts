import type {
  ExportJobExecutionContext,
  SpoolRefV1,
} from "@atlcli/export-jobs";
import type {
  ConfluenceSourcePlanCheckpointV1,
  ConfluenceSourcePlanIdentityV1,
  ConfluenceSourcePlanStoreV1,
  PersistedConfluenceSourcePlanV1,
} from "./confluence-source-plan-checkpoint.js";

const PLAN_PREFIX = "atlcli.confluence-source-plan-spool/1:";
const TREE_PREFIX = "atlcli.export-tree-spool/1:";
const ASSET_PREFIX = "atlcli.export-asset-spool/1:";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_CHAIN = 10_000;

interface SourcePlanPayloadV1 {
  schema: "atlcli.confluence-source-plan-spool/1";
  checkpoint: ConfluenceSourcePlanCheckpointV1;
  previousRef?: string;
}

function encodeRef(ref: SpoolRefV1): string {
  return `${PLAN_PREFIX}${encodeURIComponent(JSON.stringify(ref))}`;
}

function parseRef(value: string, prefix: string): SpoolRefV1 {
  if (!value.startsWith(prefix)) {
    throw new Error("Source-plan checkpoint has an unsupported ref.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(value.slice(prefix.length)));
  } catch {
    throw new Error("Source-plan checkpoint contains an invalid spool ref.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as SpoolRefV1).jobId !== "string" ||
    !Number.isSafeInteger((parsed as SpoolRefV1).leaseEpoch) ||
    typeof (parsed as SpoolRefV1).namespace !== "string" ||
    typeof (parsed as SpoolRefV1).key !== "string"
  ) {
    throw new Error("Source-plan checkpoint contains malformed spool coordinates.");
  }
  return parsed as SpoolRefV1;
}

async function readJson(
  context: ExportJobExecutionContext,
  ref: SpoolRefV1,
  signal: AbortSignal,
): Promise<unknown> {
  if (!context.readSpool) {
    throw new Error("This export host cannot read prior-epoch source plans.");
  }
  if (ref.jobId !== context.jobId || ref.leaseEpoch > context.leaseEpoch) {
    throw new Error("Source-plan checkpoint escaped its job or lease history.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of context.readSpool(ref, { signal })) {
    signal.throwIfAborted();
    size += chunk.byteLength;
    if (!Number.isSafeInteger(size) || size > MAX_BYTES) {
      throw new Error("Source-plan checkpoint exceeds its bounded object limit.");
    }
    chunks.push(chunk.slice());
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Source-plan checkpoint JSON is corrupt.");
  }
}

function jsonSource(value: unknown): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return (async function* (): AsyncIterable<Uint8Array> {
    yield bytes;
  })();
}

function previousRefFromForeignPayload(
  raw: unknown,
  identity: ConfluenceSourcePlanIdentityV1,
): string | undefined {
  if (!raw || typeof raw !== "object") {
    throw new Error("Source-plan recovery encountered a malformed checkpoint.");
  }
  const payload = raw as {
    schema?: unknown;
    jobId?: unknown;
    requestKey?: unknown;
    previousRef?: unknown;
  };
  if (
    payload.jobId !== identity.jobId ||
    payload.requestKey !== identity.requestKey
  ) {
    throw new Error("Source-plan recovery encountered a foreign checkpoint.");
  }
  if (
    payload.schema !== "atlcli.export-tree-page/1" &&
    payload.schema !== "atlcli.export-tree-manifest/1" &&
    payload.schema !== "atlcli.export-asset-checkpoint/1"
  ) {
    throw new Error("Source-plan recovery encountered an unsupported checkpoint.");
  }
  if (payload.previousRef === undefined) return undefined;
  if (typeof payload.previousRef !== "string") {
    throw new Error("Source-plan recovery encountered a malformed checkpoint link.");
  }
  return payload.previousRef;
}

/**
 * Durable source-plan store backed by the job's fenced spool.
 *
 * The plan is published before body IO. Tree-body and asset checkpoints retain
 * a `previousRef` chain, so a later lease can find this plan without copying
 * ADF, Storage, decoded blocks, or attachment bytes into job metadata.
 */
export function createConfluenceSourcePlanSpoolV1(
  context: ExportJobExecutionContext,
): ConfluenceSourcePlanStoreV1 {
  return {
    async load(identity, { signal }): Promise<PersistedConfluenceSourcePlanV1 | undefined> {
      let cursor = context.checkpointRef;
      if (!cursor) return undefined;
      const seen = new Set<string>();
      for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
        signal.throwIfAborted();
        if (seen.has(cursor)) {
          throw new Error("Source-plan checkpoint chain contains a cycle.");
        }
        seen.add(cursor);
        if (cursor.startsWith(PLAN_PREFIX)) {
          const raw = await readJson(context, parseRef(cursor, PLAN_PREFIX), signal);
          if (
            !raw ||
            typeof raw !== "object" ||
            (raw as SourcePlanPayloadV1).schema !==
              "atlcli.confluence-source-plan-spool/1"
          ) {
            throw new Error("Source-plan checkpoint payload is malformed.");
          }
          const payload = raw as SourcePlanPayloadV1;
          if (
            payload.checkpoint.jobId !== identity.jobId ||
            payload.checkpoint.requestKey !== identity.requestKey ||
            payload.checkpoint.sourcePolicyKey !== identity.sourcePolicyKey
          ) {
            throw new Error("Source-plan checkpoint identity does not match this request.");
          }
          return { checkpoint: payload.checkpoint, ref: cursor };
        }
        const prefix = cursor.startsWith(TREE_PREFIX)
          ? TREE_PREFIX
          : cursor.startsWith(ASSET_PREFIX)
            ? ASSET_PREFIX
            : undefined;
        if (!prefix) return undefined;
        const raw = await readJson(context, parseRef(cursor, prefix), signal);
        cursor = previousRefFromForeignPayload(raw, identity);
        if (!cursor) return undefined;
      }
      throw new Error("Source-plan checkpoint chain exceeds its safety bound.");
    },

    async commit(checkpoint, { leaseEpoch, signal }): Promise<string> {
      signal.throwIfAborted();
      if (
        checkpoint.jobId !== context.jobId ||
        leaseEpoch !== context.leaseEpoch ||
        checkpoint.committedLeaseEpoch !== leaseEpoch
      ) {
        throw new Error("Source-plan commit escaped its claimed job lease.");
      }
      const payload: SourcePlanPayloadV1 = {
        schema: "atlcli.confluence-source-plan-spool/1",
        checkpoint,
        ...(context.checkpointRef ? { previousRef: context.checkpointRef } : {}),
      };
      const object = await context.spool.put(
        { namespace: "confluence-source-plan", key: "plan" },
        jsonSource(payload),
        { signal },
      );
      return encodeRef(object.ref);
    },
  };
}
