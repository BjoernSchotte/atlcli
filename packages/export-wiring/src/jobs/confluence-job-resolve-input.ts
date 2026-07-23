import type {
  ConfluencePageDetails,
  ExportTreeBodyStoreV1,
} from "@atlcli/confluence";
import type {
  DocxExportJobRequestV1,
  ExportJobExecutionContext,
  PdfExportJobRequestV1,
} from "@atlcli/export-jobs";
import type { PreparePdfExportEnv } from "@atlcli/pdf";
import {
  resolveConfluenceSourceV1,
  type ConfluenceSourceProgressV1,
  type ConfluenceSourceResolverPortV1,
  type ResolveConfluenceSourceOptionsV1,
  type ResolvedConfluenceSourceV1,
} from "./confluence-source-resolver.js";
import type { PdfExportJobEngineInputV1 } from "./pdf-job-executor.js";
import type { TypescriptDocxExportJobEngineInputV1 } from "./typescript-docx-job-executor.js";
import type { ConfluenceSourcePlanStoreV1 } from "./confluence-source-plan-checkpoint.js";

type SharedSourceOptionsV1 = Pick<
  ResolveConfluenceSourceOptionsV1,
  "bodyOptions" | "resolveExternalUrl" | "classifyError"
> & {
  port: ConfluenceSourceResolverPortV1;
  onProgress?: (
    request: PdfExportJobRequestV1 | DocxExportJobRequestV1,
    context: ExportJobExecutionContext,
    progress: ConfluenceSourceProgressV1,
  ) => void | Promise<void>;
  sourcePlan?: {
    store: ConfluenceSourcePlanStoreV1;
    /** Stable host capability/representation policy identity. */
    sourcePolicyKey: string;
  };
  createSourcePlan?: (
    request: PdfExportJobRequestV1 | DocxExportJobRequestV1,
    context: ExportJobExecutionContext,
  ) => {
    store: ConfluenceSourcePlanStoreV1;
    sourcePolicyKey: string;
  };
  createBodyStore?: (
    request: PdfExportJobRequestV1 | DocxExportJobRequestV1,
    context: ExportJobExecutionContext,
  ) => ExportTreeBodyStoreV1;
};

export type PdfConfluenceResolvedInputExtrasV1 = Omit<
  PdfExportJobEngineInputV1,
  "blocks" | "sourceNotes" | "complete" | "page"
>;

export interface CreateConfluencePdfResolveInputOptionsV1 extends SharedSourceOptionsV1 {
  build(
    resolved: ResolvedConfluenceSourceV1,
    request: PdfExportJobRequestV1,
    context: ExportJobExecutionContext,
  ): Promise<{
    input: PdfConfluenceResolvedInputExtrasV1;
    env: Omit<PreparePdfExportEnv, "now">;
  }> | {
    input: PdfConfluenceResolvedInputExtrasV1;
    env: Omit<PreparePdfExportEnv, "now">;
  };
}

export type DocxConfluenceResolvedInputExtrasV1 = Omit<
  TypescriptDocxExportJobEngineInputV1,
  "blocks" | "sourceNotes" | "complete" | "details"
>;

export type DocxConfluenceRootDetailsV1 = Omit<
  ConfluencePageDetails,
  "id" | "title" | "version" | "spaceKey" | "storage"
>;

export interface CreateConfluenceDocxResolveInputOptionsV1 extends SharedSourceOptionsV1 {
  build(
    resolved: ResolvedConfluenceSourceV1,
    request: DocxExportJobRequestV1,
    context: ExportJobExecutionContext,
  ): Promise<{
    input: DocxConfluenceResolvedInputExtrasV1;
    rootDetails?: DocxConfluenceRootDetailsV1;
  }> | {
    input: DocxConfluenceResolvedInputExtrasV1;
    rootDetails?: DocxConfluenceRootDetailsV1;
  };
}

/** Stable, content-free error suitable for a durable job summary. */
export class ConfluenceInputPreparationError extends Error {
  readonly code = "confluence-input-preparation-failed" as const;

  constructor() {
    super("The Confluence export input could not be prepared.");
    this.name = "ConfluenceInputPreparationError";
  }
}

async function prepareHostInputV1<T>(
  signal: AbortSignal,
  prepare: () => Promise<T> | T,
): Promise<T> {
  try {
    const prepared = await prepare();
    signal.throwIfAborted();
    return prepared;
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    // Macro, attachment, identity and asset adapters may include source text,
    // URLs or filenames in their original messages. Those details stay on the
    // transient host side and never become the durable executor error.
    throw new ConfluenceInputPreparationError();
  }
}

function sourceOptions<Request extends PdfExportJobRequestV1 | DocxExportJobRequestV1>(
  options: SharedSourceOptionsV1,
  request: Request,
  context: ExportJobExecutionContext,
  exporter: "pdf" | "word",
  onProgress?: (progress: ConfluenceSourceProgressV1) => void,
): ResolveConfluenceSourceOptionsV1 {
  const sourcePlan = options.createSourcePlan?.(request, context) ?? options.sourcePlan;
  return {
    exporter,
    port: options.port,
    signal: context.signal,
    ...(options.bodyOptions ? { bodyOptions: options.bodyOptions } : {}),
    ...(options.resolveExternalUrl ? { resolveExternalUrl: options.resolveExternalUrl } : {}),
    ...(options.classifyError ? { classifyError: options.classifyError } : {}),
    ...(options.createBodyStore
      ? { bodyStore: options.createBodyStore(request, context) }
      : {}),
    ...(onProgress ? { onProgress } : {}),
    ...(sourcePlan
      ? {
          sourcePlanCheckpoint: {
            jobId: context.jobId,
            requestKey: request.idempotencyKey,
            sourcePolicyKey: sourcePlan.sourcePolicyKey,
            leaseEpoch: context.leaseEpoch,
            ...(context.checkpointRef
              ? { recoveryHeadRef: context.checkpointRef }
              : {}),
            store: sourcePlan.store,
            publishCheckpointRef: (ref: string) => context.checkpoint(ref),
          },
        }
      : {}),
  };
}

function sourceProgressChannel(
  options: SharedSourceOptionsV1,
  request: PdfExportJobRequestV1 | DocxExportJobRequestV1,
  context: ExportJobExecutionContext,
): {
  callback?: (progress: ConfluenceSourceProgressV1) => void;
  settled(): Promise<void>;
} {
  if (!options.onProgress) return { settled: async () => {} };
  let pending = Promise.resolve();
  return {
    callback(progress) {
      pending = pending.then(() => options.onProgress!(request, context, progress));
    },
    settled: () => pending,
  };
}

async function resolveSourceWithProgressV1(
  options: SharedSourceOptionsV1,
  request: PdfExportJobRequestV1 | DocxExportJobRequestV1,
  context: ExportJobExecutionContext,
  exporter: "pdf" | "word",
): Promise<ResolvedConfluenceSourceV1> {
  const progress = sourceProgressChannel(options, request, context);
  let resolved: ResolvedConfluenceSourceV1 | undefined;
  let sourceFailure: unknown;
  try {
    resolved = await resolveConfluenceSourceV1(
      request.source,
      sourceOptions(options, request, context, exporter, progress.callback),
    );
  } catch (error) {
    sourceFailure = error;
  } finally {
    try {
      await progress.settled();
    } catch (progressFailure) {
      if (sourceFailure === undefined) throw progressFailure;
    }
  }
  if (sourceFailure !== undefined) throw sourceFailure;
  if (!resolved) throw new Error("Confluence source resolution completed without a result.");
  return resolved;
}

/** Bind the shared ADF/Storage resolver to the PDF executor's `resolveInput`. */
export function createConfluencePdfResolveInputV1(
  options: CreateConfluencePdfResolveInputOptionsV1,
): (
  request: PdfExportJobRequestV1,
  context: ExportJobExecutionContext,
) => Promise<{
  input: PdfExportJobEngineInputV1;
  env: Omit<PreparePdfExportEnv, "now">;
  telemetry: { sourcePageCount: number };
}> {
  return async (request, context) => {
    const resolved = await resolveSourceWithProgressV1(
      options,
      request,
      context,
      "pdf",
    );
    const built = await prepareHostInputV1(
      context.signal,
      () => options.build(resolved, request, context),
    );
    return {
      input: {
        ...built.input,
        blocks: resolved.blocks,
        sourceNotes: resolved.sourceNotes,
        complete: resolved.complete,
        page: {
          id: resolved.root.id,
          ...(resolved.root.version !== undefined ? { version: resolved.root.version } : {}),
          ...(resolved.root.spaceKey !== undefined ? { spaceKey: resolved.root.spaceKey } : {}),
        },
      },
      env: built.env,
      telemetry: { sourcePageCount: resolved.pageCount },
    };
  };
}

/**
 * Bind the shared resolver to TypeScript DOCX while keeping raw source bodies
 * out of `details`. Precomposed blocks are always present, so the engine never
 * needs the legacy single-page Storage fallback in this job path.
 */
export function createConfluenceDocxResolveInputV1(
  options: CreateConfluenceDocxResolveInputOptionsV1,
): (
  request: DocxExportJobRequestV1,
  context: ExportJobExecutionContext,
) => Promise<TypescriptDocxExportJobEngineInputV1> {
  return async (request, context) => {
    const resolved = await resolveSourceWithProgressV1(
      options,
      request,
      context,
      "word",
    );
    const built = await prepareHostInputV1(
      context.signal,
      () => options.build(resolved, request, context),
    );
    return {
      ...built.input,
      jobTelemetry: { sourcePageCount: resolved.pageCount },
      details: {
        ...built.rootDetails,
        id: resolved.root.id,
        title: resolved.root.title,
        storage: "",
        ...(resolved.root.version !== undefined ? { version: resolved.root.version } : {}),
        ...(resolved.root.spaceKey !== undefined ? { spaceKey: resolved.root.spaceKey } : {}),
      },
      blocks: resolved.blocks,
      sourceNotes: resolved.sourceNotes,
      complete: resolved.complete,
    };
  };
}
