import type { ConfluencePageDetails } from "@atlcli/confluence";
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
  "bodyOptions" | "resolveExternalUrl"
> & {
  port: ConfluenceSourceResolverPortV1;
  onProgress?: (
    request: PdfExportJobRequestV1 | DocxExportJobRequestV1,
    context: ExportJobExecutionContext,
    progress: ConfluenceSourceProgressV1,
  ) => void;
  sourcePlan?: {
    store: ConfluenceSourcePlanStoreV1;
    /** Stable host capability/representation policy identity. */
    sourcePolicyKey: string;
  };
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
): ResolveConfluenceSourceOptionsV1 {
  return {
    exporter,
    port: options.port,
    signal: context.signal,
    ...(options.bodyOptions ? { bodyOptions: options.bodyOptions } : {}),
    ...(options.resolveExternalUrl ? { resolveExternalUrl: options.resolveExternalUrl } : {}),
    ...(options.onProgress
      ? {
          onProgress: (progress) => options.onProgress!(request, context, progress),
        }
      : {}),
    ...(options.sourcePlan
      ? {
          sourcePlanCheckpoint: {
            jobId: context.jobId,
            requestKey: request.idempotencyKey,
            sourcePolicyKey: options.sourcePlan.sourcePolicyKey,
            leaseEpoch: context.leaseEpoch,
            store: options.sourcePlan.store,
            publishCheckpointRef: (ref: string) => context.checkpoint(ref),
          },
        }
      : {}),
  };
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
}> {
  return async (request, context) => {
    const resolved = await resolveConfluenceSourceV1(
      request.source,
      sourceOptions(options, request, context, "pdf"),
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
    const resolved = await resolveConfluenceSourceV1(
      request.source,
      sourceOptions(options, request, context, "word"),
    );
    const built = await prepareHostInputV1(
      context.signal,
      () => options.build(resolved, request, context),
    );
    return {
      ...built.input,
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
