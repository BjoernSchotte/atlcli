import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DocxExportResultIntentV1,
  DocxExportResultStoreV1,
  DocxReadyToRenderCheckpointV1,
  DocxReadyToRenderStoreV1,
  PdfExportResultIntentV1,
  PdfExportResultStoreV1,
  PdfReadyToRenderCheckpointV1,
  PdfReadyToRenderStoreV1,
} from "@atlcli/export-wiring/jobs";
import type {
  ExportJobExecutionContext,
  ExportJobExecutionResultV1,
  SpoolRefV1,
  SpoolWriteLimitsV1,
} from "@atlcli/export-jobs";
import { writeDurableAtomic } from "./atomic-fs.js";
import { FileExportJobStore } from "./file-job-store.js";
import { FileExportSpoolStore } from "./file-spool-store.js";
import { logicalDigest, throwIfAborted } from "./file-byte-utils.js";

interface BytesPlaceholderV1 { __atlcliBytes: number; }
interface DatePlaceholderV1 { __atlcliDate: string; }
interface MapPlaceholderV1 { __atlcliMap: Array<[unknown, unknown]>; }
interface SetPlaceholderV1 { __atlcliSet: unknown[]; }
interface PreparedManifestV1 {
  schema: "atlcli.node-prepared-payload/1";
  value: unknown;
  blobs: SpoolRefV1[];
}

function checkpointKey(format: "pdf" | "docx", jobId: string, requestId: string, requestKey: string): string {
  return `${format}:${logicalDigest([jobId, requestId, requestKey])}`;
}

function dehydrate(value: unknown, blobs: Uint8Array[], seen = new Set<object>()): unknown {
  if (value instanceof Uint8Array) { const index = blobs.length; blobs.push(value); return { __atlcliBytes: index } satisfies BytesPlaceholderV1; }
  if (value instanceof Date) return { __atlcliDate: value.toISOString() } satisfies DatePlaceholderV1;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new Error("Prepared export payload contains a cycle.");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => dehydrate(entry, blobs, seen));
    if (value instanceof Map) return { __atlcliMap: [...value].map(([key, entry]) => [dehydrate(key, blobs, seen), dehydrate(entry, blobs, seen)]) } satisfies MapPlaceholderV1;
    if (value instanceof Set) return { __atlcliSet: [...value].map((entry) => dehydrate(entry, blobs, seen)) } satisfies SetPlaceholderV1;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Prepared export payload must contain plain data.");
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, dehydrate(entry, blobs, seen)]));
  } finally { seen.delete(value); }
}

function hydrate(value: unknown, blobs: Uint8Array[]): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => hydrate(entry, blobs));
  if (Object.keys(value).length === 1 && Number.isSafeInteger((value as Partial<BytesPlaceholderV1>).__atlcliBytes)) {
    const blob = blobs[(value as BytesPlaceholderV1).__atlcliBytes]; if (!blob) throw new Error("Prepared payload references a missing blob."); return blob;
  }
  if (Object.keys(value).length === 1 && typeof (value as Partial<DatePlaceholderV1>).__atlcliDate === "string") return new Date((value as DatePlaceholderV1).__atlcliDate);
  if (Object.keys(value).length === 1 && Array.isArray((value as Partial<MapPlaceholderV1>).__atlcliMap)) return new Map((value as MapPlaceholderV1).__atlcliMap.map(([key, entry]) => [hydrate(key, blobs), hydrate(entry, blobs)]));
  if (Object.keys(value).length === 1 && Array.isArray((value as Partial<SetPlaceholderV1>).__atlcliSet)) return new Set((value as SetPlaceholderV1).__atlcliSet.map((entry) => hydrate(entry, blobs)));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, hydrate(entry, blobs)]));
}

async function collect(source: AsyncIterable<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []; let length = 0;
  for await (const chunk of source) { throwIfAborted(signal); length += chunk.byteLength; if (length > maxBytes) throw new RangeError("Prepared payload object exceeds configured limit."); chunks.push(chunk); }
  const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result;
}

export interface FileExecutorStoreOptionsV1 {
  jobs: FileExportJobStore;
  spool: FileExportSpoolStore;
  rootDir: string;
  spoolLimits: SpoolWriteLimitsV1;
  now?: () => number;
}

class FileReadyStoreBase {
  readonly #jobs: FileExportJobStore; readonly #spool: FileExportSpoolStore; readonly #limits: SpoolWriteLimitsV1; readonly #now: () => number;
  constructor(options: FileExecutorStoreOptionsV1) { this.#jobs = options.jobs; this.#spool = options.spool; this.#limits = options.spoolLimits; this.#now = options.now ?? Date.now; }
  async commit<TPrepared, TCheckpoint extends { ref: string }>(input: { format: "pdf" | "docx"; jobId: string; leaseEpoch: number; requestId: string; requestKey: string; prepared: TPrepared; checkpoint: TCheckpoint; signal: AbortSignal }): Promise<TCheckpoint> {
    const key = checkpointKey(input.format, input.jobId, input.requestId, input.requestKey); const blobs: Uint8Array[] = [];
    const value = dehydrate(input.prepared, blobs); const refs: SpoolRefV1[] = [];
    for (const [index, bytes] of blobs.entries()) {
      const ref: SpoolRefV1 = { jobId: input.jobId, leaseEpoch: input.leaseEpoch, namespace: `ready-${input.format}`, key: `${key}:blob:${index}` };
      await this.#spool.put(ref, (async function* () { yield bytes; })(), this.#limits, { signal: input.signal }); refs.push(ref);
    }
    const manifestRef: SpoolRefV1 = { jobId: input.jobId, leaseEpoch: input.leaseEpoch, namespace: `ready-${input.format}`, key: `${key}:manifest` };
    const manifest = new TextEncoder().encode(JSON.stringify({ schema: "atlcli.node-prepared-payload/1", value, blobs: refs } satisfies PreparedManifestV1));
    await this.#spool.put(manifestRef, (async function* () { yield manifest; })(), this.#limits, { signal: input.signal });
    return this.#jobs.commitExecutorCheckpoint({ key, jobId: input.jobId, leaseEpoch: input.leaseEpoch, checkpoint: input.checkpoint, manifestRef, at: this.#now() });
  }
  async load<T>(format: "pdf" | "docx", jobId: string, requestId: string, requestKey: string): Promise<T | undefined> { return (await this.#jobs.loadExecutorCheckpoint<T>(checkpointKey(format, jobId, requestId, requestKey)))?.checkpoint; }
  async materialize<T>(format: "pdf" | "docx", checkpoint: { jobId: string; requestId: string; requestKey: string }, signal: AbortSignal): Promise<T> {
    const stored = await this.#jobs.loadExecutorCheckpoint<T>(checkpointKey(format, checkpoint.jobId, checkpoint.requestId, checkpoint.requestKey)); if (!stored) throw new Error("Prepared checkpoint was not found.");
    const manifestBytes = await collect(this.#spool.read(stored.manifestRef, { signal }), this.#limits.maxObjectBytes, signal);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as PreparedManifestV1; if (manifest.schema !== "atlcli.node-prepared-payload/1") throw new Error("Prepared manifest schema is unsupported.");
    const blobs: Uint8Array[] = []; for (const ref of manifest.blobs) blobs.push(await collect(this.#spool.read(ref, { signal }), this.#limits.maxObjectBytes, signal));
    return hydrate(manifest.value, blobs) as T;
  }
  advance<T extends { renderAttempts: number }>(format: "pdf" | "docx", input: { checkpoint: T & { jobId: string; requestId: string; requestKey: string }; jobId: string; leaseEpoch: number }): Promise<T> {
    return this.#jobs.advanceExecutorCheckpointAttempt({ key: checkpointKey(format, input.checkpoint.jobId, input.checkpoint.requestId, input.checkpoint.requestKey), jobId: input.jobId, leaseEpoch: input.leaseEpoch, expected: input.checkpoint });
  }
}

export function createFilePdfReadyToRenderStore(options: FileExecutorStoreOptionsV1): PdfReadyToRenderStoreV1 {
  const base = new FileReadyStoreBase(options);
  return {
    load: ({ jobId, request }) => base.load("pdf", jobId, request.id, request.idempotencyKey),
    async commit(input) {
      const key = checkpointKey("pdf", input.jobId, input.request.id, input.request.idempotencyKey);
      const checkpoint: PdfReadyToRenderCheckpointV1 = { schema: "atlcli.pdf-ready-to-render/1", ref: `node-ready:${key}`, jobId: input.jobId, requestId: input.request.id, requestKey: input.request.idempotencyKey, preparedRef: `node-prepared:${key}`, preparedByteLength: input.binding.byteLength, preparedSha256: input.binding.sha256, estimate: structuredClone(input.estimate), renderAttempts: 0 };
      return base.commit({ format: "pdf", jobId: input.jobId, leaseEpoch: input.leaseEpoch, requestId: input.request.id, requestKey: input.request.idempotencyKey, prepared: input.prepared, checkpoint, signal: input.signal });
    },
    materialize: (input) => base.materialize("pdf", input.checkpoint, input.signal),
    beginRenderAttempt: (input) => base.advance("pdf", input),
  };
}

export function createFileDocxReadyToRenderStore(options: FileExecutorStoreOptionsV1): DocxReadyToRenderStoreV1 {
  const base = new FileReadyStoreBase(options);
  return {
    load: ({ jobId, request }) => base.load("docx", jobId, request.id, request.idempotencyKey),
    async commit(input) {
      const key = checkpointKey("docx", input.jobId, input.request.id, input.request.idempotencyKey);
      const checkpoint: DocxReadyToRenderCheckpointV1 = { schema: "atlcli.docx-ready-to-render/1", ref: `node-ready:${key}`, jobId: input.jobId, requestId: input.request.id, requestKey: input.request.idempotencyKey, preparedRef: `node-prepared:${key}`, preparedByteLength: input.binding.byteLength, preparedSha256: input.binding.sha256, template: structuredClone(input.template), estimate: structuredClone(input.estimate), renderAttempts: 0 };
      return base.commit({ format: "docx", jobId: input.jobId, leaseEpoch: input.leaseEpoch, requestId: input.request.id, requestKey: input.request.idempotencyKey, prepared: input.prepared, checkpoint, signal: input.signal });
    },
    materialize: (input) => base.materialize("docx", input.checkpoint, input.signal),
    beginRenderAttempt: (input) => base.advance("docx", input),
  };
}

function createResultStore<TIntent extends { key: { ref: string }; reportRef: string; reportSummary: import("@atlcli/export-jobs").ExportReportSummaryV1 }>(options: FileExecutorStoreOptionsV1) {
  const reportsDir = join(options.rootDir, "reports");
  return {
    async recover(key: TIntent["key"], context: ExportJobExecutionContext) {
      const stored = await options.jobs.loadExecutorResult<TIntent>(key.ref); if (!stored?.result) return undefined;
      return { intent: stored.intent, result: stored.result };
    },
    async prepare(input: { intent: TIntent; report: unknown }, context: ExportJobExecutionContext): Promise<TIntent> {
      const reportPath = join(reportsDir, `${logicalDigest(input.intent.reportRef)}.json`); await writeDurableAtomic(reportPath, `${JSON.stringify(input.report)}\n`);
      return await options.jobs.prepareExecutorResult({ key: input.intent.key.ref, jobId: context.jobId, leaseEpoch: context.leaseEpoch, intent: input.intent, reportRef: input.intent.reportRef, reportPath }) as TIntent;
    },
    async stage(input: { intent: TIntent; artifact: import("@atlcli/export-jobs").PendingArtifactV1 }, context: ExportJobExecutionContext): Promise<ExportJobExecutionResultV1> {
      const stagedArtifact = await context.artifacts.stage(input.artifact, { signal: context.signal });
      const result: ExportJobExecutionResultV1 = { stagedArtifact, reportRef: input.intent.reportRef, reportSummary: input.intent.reportSummary };
      await options.jobs.completeExecutorResult({ key: input.intent.key.ref, jobId: context.jobId, leaseEpoch: context.leaseEpoch, intent: input.intent, result }); return result;
    },
  };
}

export function createFilePdfExportResultStore(options: FileExecutorStoreOptionsV1): PdfExportResultStoreV1 { return createResultStore<PdfExportResultIntentV1>(options); }
export function createFileDocxExportResultStore(options: FileExecutorStoreOptionsV1): DocxExportResultStoreV1 { return createResultStore<DocxExportResultIntentV1>(options); }

/** Resolve a logical report ref without ever placing a physical path in job metadata. */
export async function readFileExportReport<T = unknown>(jobs: FileExportJobStore, reportRef: string): Promise<T | undefined> {
  const path = await jobs.resolveExecutorReportPath(reportRef); if (!path) return undefined;
  return JSON.parse(await readFile(path, "utf8")) as T;
}
