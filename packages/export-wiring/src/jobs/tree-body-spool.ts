import type {
  ExportJobExecutionContext,
  SpoolRefV1,
} from "@atlcli/export-jobs";
import type {
  ExportTreeBodyManifestEntryV1,
  ExportTreeBodyResultV1,
  ExportTreeBodyStoreV1,
} from "@atlcli/confluence";

const CHECKPOINT_PREFIX = "atlcli.export-tree-spool/1:";
const ASSET_CHECKPOINT_PREFIX = "atlcli.export-asset-spool/1:";
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const PAGE_MAX_BYTES = 64 * 1024 * 1024;
const FOREIGN_CHECKPOINT_MAX_BYTES = 64 * 1024;
const MAX_RECOVERY_CHAIN = 10_000;

interface TreeManifestPayloadV1 {
  schema: "atlcli.export-tree-manifest/1";
  jobId: string;
  requestKey: string;
  entries: ExportTreeBodyManifestEntryV1[];
}

interface TreePagePayloadV1 {
  schema: "atlcli.export-tree-page/1";
  jobId: string;
  requestKey: string;
  entry: ExportTreeBodyManifestEntryV1;
  previousRef: string;
  result: ExportTreeBodyResultV1;
}

type TreeSpoolPayloadV1 = TreeManifestPayloadV1 | TreePagePayloadV1;

function encodeCheckpointRef(ref: SpoolRefV1): string {
  return `${CHECKPOINT_PREFIX}${encodeURIComponent(JSON.stringify(ref))}`;
}

function parseCheckpointRef(value: string): SpoolRefV1 {
  if (!value.startsWith(CHECKPOINT_PREFIX)) {
    throw new Error("Source checkpoint is not an export-tree spool ref.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      decodeURIComponent(value.slice(CHECKPOINT_PREFIX.length)),
    );
  } catch {
    throw new Error("Source checkpoint contains an invalid spool ref.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as SpoolRefV1).jobId !== "string" ||
    !Number.isSafeInteger((parsed as SpoolRefV1).leaseEpoch) ||
    typeof (parsed as SpoolRefV1).namespace !== "string" ||
    typeof (parsed as SpoolRefV1).key !== "string"
  ) {
    throw new Error("Source checkpoint contains malformed spool coordinates.");
  }
  return parsed as SpoolRefV1;
}

function parseAssetCheckpointRef(value: string): SpoolRefV1 {
  if (!value.startsWith(ASSET_CHECKPOINT_PREFIX)) {
    throw new Error("Source checkpoint is not an export-asset spool ref.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      decodeURIComponent(value.slice(ASSET_CHECKPOINT_PREFIX.length)),
    );
  } catch {
    throw new Error("Source checkpoint contains an invalid asset spool ref.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as SpoolRefV1).jobId !== "string" ||
    !Number.isSafeInteger((parsed as SpoolRefV1).leaseEpoch) ||
    typeof (parsed as SpoolRefV1).namespace !== "string" ||
    typeof (parsed as SpoolRefV1).key !== "string"
  ) {
    throw new Error("Source checkpoint contains malformed asset coordinates.");
  }
  return parsed as SpoolRefV1;
}

async function collectJson(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of source) {
    signal.throwIfAborted();
    if (
      !Number.isSafeInteger(byteLength + chunk.byteLength) ||
      byteLength + chunk.byteLength > maxBytes
    ) {
      throw new Error("Export-tree checkpoint exceeds its bounded object limit.");
    }
    byteLength += chunk.byteLength;
    chunks.push(chunk.slice());
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Export-tree checkpoint JSON is corrupt.");
  }
}

function jsonSource(value: unknown): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return (async function* (): AsyncIterable<Uint8Array> {
    yield bytes;
  })();
}

function sameEntries(
  left: readonly ExportTreeBodyManifestEntryV1[],
  right: readonly ExportTreeBodyManifestEntryV1[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (entry, index) =>
      entry.ordinal === right[index]?.ordinal &&
      entry.key === right[index]?.key &&
      entry.pageId === right[index]?.pageId &&
      entry.title === right[index]?.title,
  );
}

function validateEntry(
  value: unknown,
  expected?: ExportTreeBodyManifestEntryV1,
): ExportTreeBodyManifestEntryV1 {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isSafeInteger((value as ExportTreeBodyManifestEntryV1).ordinal) ||
    (value as ExportTreeBodyManifestEntryV1).ordinal < 0 ||
    typeof (value as ExportTreeBodyManifestEntryV1).key !== "string" ||
    (value as ExportTreeBodyManifestEntryV1).key.length === 0 ||
    typeof (value as ExportTreeBodyManifestEntryV1).pageId !== "string" ||
    (value as ExportTreeBodyManifestEntryV1).pageId.length === 0 ||
    typeof (value as ExportTreeBodyManifestEntryV1).title !== "string"
  ) {
    throw new Error("Export-tree checkpoint contains an invalid manifest entry.");
  }
  const entry = value as ExportTreeBodyManifestEntryV1;
  if (
    expected &&
    (
      entry.ordinal !== expected.ordinal ||
      entry.key !== expected.key ||
      entry.pageId !== expected.pageId ||
      entry.title !== expected.title
    )
  ) {
    throw new Error("Export-tree checkpoint slot does not match current discovery.");
  }
  return entry;
}

function validateResult(
  value: unknown,
  entry: ExportTreeBodyManifestEntryV1,
): ExportTreeBodyResultV1 {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as ExportTreeBodyResultV1).ok !== "boolean" ||
    typeof (value as ExportTreeBodyResultV1).pageId !== "string" ||
    typeof (value as ExportTreeBodyResultV1).title !== "string"
  ) {
    throw new Error(`Export-tree result ${entry.ordinal} is malformed.`);
  }
  const result = value as ExportTreeBodyResultV1;
  if (result.pageId !== entry.pageId || result.title !== entry.title) {
    throw new Error(`Export-tree result ${entry.ordinal} identity is malformed.`);
  }
  if (result.ok) {
    if (
      !Array.isArray(result.blocks) ||
      !Array.isArray(result.notes) ||
      !result.meta ||
      !Array.isArray(result.meta.labels)
    ) {
      throw new Error(`Export-tree success result ${entry.ordinal} is malformed.`);
    }
  } else if (
    !result.failure ||
    ![
      "page-unreadable",
      "subtree-unreadable",
      "page-ambiguous-404",
      "page-version-changed",
    ].includes(result.failure.code) ||
    !Array.isArray(result.failure.affected)
  ) {
    throw new Error(`Export-tree failure result ${entry.ordinal} is malformed.`);
  }
  return result;
}

/**
 * Durable, browser-safe page/block spool over the executor context. Every page
 * object contains both its normalized result and the link to the previous
 * checkpoint, so one atomic object write precedes the fenced metadata publish.
 */
export function createExportTreeBodySpoolV1(
  context: ExportJobExecutionContext,
  requestKey: string,
): ExportTreeBodyStoreV1 {
  if (!context.readSpool) {
    throw new Error("This export host cannot read prior-epoch source checkpoints.");
  }
  const refs = new Map<number, SpoolRefV1>();
  let manifest: TreeManifestPayloadV1 | undefined;
  let latestRef: string | undefined;
  let initialized = false;

  const readPayload = async (
    encodedRef: string,
    signal: AbortSignal,
  ): Promise<TreeSpoolPayloadV1> => {
    const ref = parseCheckpointRef(encodedRef);
    if (ref.jobId !== context.jobId || ref.leaseEpoch > context.leaseEpoch) {
      throw new Error("Export-tree checkpoint escaped its job or lease history.");
    }
    const maxBytes =
      ref.namespace === "source-manifest"
        ? MANIFEST_MAX_BYTES
        : PAGE_MAX_BYTES;
    const raw = await collectJson(context.readSpool!(ref, { signal }), maxBytes, signal);
    if (!raw || typeof raw !== "object" || !("schema" in raw)) {
      throw new Error("Export-tree checkpoint payload is malformed.");
    }
    const payload = raw as TreeSpoolPayloadV1;
    if (
      payload.jobId !== context.jobId ||
      payload.requestKey !== requestKey
    ) {
      throw new Error("Export-tree checkpoint identity does not match this request.");
    }
    return payload;
  };

  const recover = async (signal: AbortSignal): Promise<void> => {
    if (initialized) return;
    initialized = true;
    const checkpointRef = context.checkpointRef;
    if (!checkpointRef) return;
    latestRef = checkpointRef;
    const seen = new Set<string>();
    let cursor = checkpointRef;
    for (let depth = 0; depth < MAX_RECOVERY_CHAIN; depth += 1) {
      signal.throwIfAborted();
      if (seen.has(cursor)) {
        throw new Error("Export-tree checkpoint chain contains a cycle.");
      }
      seen.add(cursor);
      if (cursor.startsWith(ASSET_CHECKPOINT_PREFIX)) {
        const ref = parseAssetCheckpointRef(cursor);
        if (ref.jobId !== context.jobId || ref.leaseEpoch > context.leaseEpoch) {
          throw new Error("Export-tree checkpoint escaped its job or lease history.");
        }
        const raw = await collectJson(
          context.readSpool!(ref, { signal }),
          FOREIGN_CHECKPOINT_MAX_BYTES,
          signal,
        );
        if (
          !raw ||
          typeof raw !== "object" ||
          (raw as { schema?: unknown }).schema !==
            "atlcli.export-asset-checkpoint/1" ||
          (raw as { jobId?: unknown }).jobId !== context.jobId ||
          (raw as { requestKey?: unknown }).requestKey !== requestKey
        ) {
          throw new Error("Export-tree encountered a mismatched asset checkpoint.");
        }
        const previousRef = (raw as { previousRef?: unknown }).previousRef;
        if (previousRef === undefined) return;
        if (typeof previousRef !== "string") {
          throw new Error("Export-tree encountered a malformed asset checkpoint link.");
        }
        cursor = previousRef;
        continue;
      }
      if (!cursor.startsWith(CHECKPOINT_PREFIX)) return;
      const payload = await readPayload(cursor, signal);
      if (payload.schema === "atlcli.export-tree-manifest/1") {
        if (!Array.isArray(payload.entries)) {
          throw new Error("Export-tree manifest entries are malformed.");
        }
        manifest = {
          ...payload,
          entries: payload.entries.map((entry) => validateEntry(entry)),
        };
        break;
      }
      if (payload.schema !== "atlcli.export-tree-page/1") {
        throw new Error("Unsupported export-tree checkpoint schema.");
      }
      const entry = validateEntry(payload.entry);
      validateResult(payload.result, entry);
      if (refs.has(entry.ordinal)) {
        throw new Error("Export-tree checkpoint chain repeats an ordinal.");
      }
      refs.set(entry.ordinal, parseCheckpointRef(cursor));
      cursor = payload.previousRef;
      if (depth === MAX_RECOVERY_CHAIN - 1) {
        throw new Error("Export-tree checkpoint chain exceeds its safety bound.");
      }
    }
    if (!manifest) {
      throw new Error("Export-tree checkpoint chain has no discovery manifest.");
    }
    for (let ordinal = 0; ordinal < refs.size; ordinal += 1) {
      if (!refs.has(ordinal)) {
        throw new Error("Export-tree checkpoint chain contains a page gap.");
      }
    }
  };

  return {
    async prepare(entries, { signal }) {
      await recover(signal);
      if (manifest) {
        if (!sameEntries(manifest.entries, entries)) {
          throw new Error(
            "Export-tree discovery changed after recovery; refusing mixed-version output.",
          );
        }
        return;
      }
      const payload: TreeManifestPayloadV1 = {
        schema: "atlcli.export-tree-manifest/1",
        jobId: context.jobId,
        requestKey,
        entries: entries.map((entry) => ({ ...entry })),
      };
      const object = await context.spool.put(
        { namespace: "source-manifest", key: "manifest" },
        jsonSource(payload),
        { signal },
      );
      manifest = payload;
      latestRef = encodeCheckpointRef(object.ref);
      await context.checkpoint(latestRef);
    },

    async load(entry, { signal }) {
      await recover(signal);
      const ref = refs.get(entry.ordinal);
      if (!ref) return undefined;
      const payload = await readPayload(encodeCheckpointRef(ref), signal);
      if (payload.schema !== "atlcli.export-tree-page/1") {
        throw new Error("Export-tree page ref resolved to a non-page payload.");
      }
      validateEntry(payload.entry, entry);
      return validateResult(payload.result, entry);
    },

    async commit(entry, result, { signal }) {
      await recover(signal);
      if (!manifest || !latestRef) {
        throw new Error("Export-tree manifest was not prepared before page commit.");
      }
      if (refs.has(entry.ordinal)) {
        throw new Error("Export-tree page slot was committed twice.");
      }
      if (entry.ordinal !== refs.size) {
        throw new Error("Export-tree page commits must be contiguous and ordered.");
      }
      const payload: TreePagePayloadV1 = {
        schema: "atlcli.export-tree-page/1",
        jobId: context.jobId,
        requestKey,
        entry: { ...entry },
        previousRef: latestRef,
        result,
      };
      const object = await context.spool.put(
        {
          namespace: "source-pages",
          key: `page-${String(entry.ordinal).padStart(6, "0")}`,
        },
        jsonSource(payload),
        { signal },
      );
      refs.set(entry.ordinal, object.ref);
      latestRef = encodeCheckpointRef(object.ref);
      await context.checkpoint(latestRef);
    },
  };
}
