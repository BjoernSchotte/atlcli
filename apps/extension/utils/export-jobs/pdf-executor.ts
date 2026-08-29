import {
  parsePdfExportJobRequestV1,
  type ExportJobExecutionContext,
  type ExportJobExecutionResultV1,
  type ExportJobExecutor,
  type ExportJobRequestV1,
  type PdfExportJobRequestV1,
  type ResourceEstimateV1,
  type SpoolWriteLimitsV1,
  type TemplatePackStoreV1,
} from "@atlcli/export-jobs";
import {
  createPdfExportJobExecutor,
  type PdfExportJobEngineInputV1,
  type PdfExportResultStoreV1,
  type PdfRasterNormalizerLeaseFactoryV1,
  type PdfReadyToRenderStoreV1,
} from "@atlcli/export-wiring/jobs";
import type { PdfCompilePort } from "@atlcli/pdf/browser";
import { sanitizeDownloadName } from "../download.js";
import type { ChromeWorkerCompilerHost } from "../pdf/compiler-host.js";
import { IndexedDbExportJobCatalog } from "./catalog.js";
import { IndexedDbExportByteStore } from "./chunk-store.js";
import {
  createExtensionPdfExportResultStore,
  createExtensionPdfReadyToRenderStore,
  type ExtensionPdfExecutorStoreOptionsV1,
} from "./executor-store.js";
import {
  createOffscreenPrivatePdfCompilePort,
  type OffscreenPrivatePdfCompilePortDeps,
} from "./pdf-compiler.js";
import {
  createExtensionPdfJobInputResolver,
  type ResolvedExtensionPdfJobInputV1,
} from "./pdf-resolver.js";
import { BrowserRenderReservationPoolV1 } from "./render-reservation.js";

const MIB = 1024 * 1024;

/**
 * Product limits for durable PDF state. One prepared object may fill the
 * 128-MiB spool reservation, while the per-job allowance also leaves room for
 * its manifest, report, pinned request assets, and staged result metadata.
 */
export const EXTENSION_PDF_SPOOL_LIMITS_V1: SpoolWriteLimitsV1 = Object.freeze({
  maxObjectBytes: 128 * MIB,
  maxJobBytes: 256 * MIB,
  maxTotalBytes: 512 * MIB,
});

/** The compiler and artifact store both reject a PDF larger than this bound. */
export const EXTENSION_PDF_MAX_OUTPUT_BYTES_V1 = 64 * MIB;

/**
 * Conservative first-delivery admission bound.
 *
 * The runner owns a single heavy slot, so reserving the full browser render
 * envelope does not reduce useful concurrency. Actual prepared bytes are
 * reconciled before materialization; exceeding any bound fails closed.
 */
export function estimateExtensionPdfRenderV1(
  _input: PdfExportJobEngineInputV1,
  _request: PdfExportJobRequestV1,
): ResourceEstimateV1 {
  return {
    heapBytes: 512 * MIB,
    spoolBytes: EXTENSION_PDF_SPOOL_LIMITS_V1.maxObjectBytes,
    outputBytes: EXTENSION_PDF_MAX_OUTPUT_BYTES_V1,
    rasterPixels: 32 * MIB,
    confidence: "unknown",
  };
}

type PrivateCompilerDeps = Partial<
  Omit<OffscreenPrivatePdfCompilePortDeps, "catalog" | "host">
>;

export interface CreateProductiveExtensionPdfExecutorOptionsV1 {
  catalog: IndexedDbExportJobCatalog;
  bytes: IndexedDbExportByteStore;
  compilerHost: Pick<ChromeWorkerCompilerHost, "compile" | "cancel">;
  renderPool: BrowserRenderReservationPoolV1;
  now?: () => number;
  spoolLimits?: SpoolWriteLimitsV1;
  storageOptions?: Omit<
    ExtensionPdfExecutorStoreOptionsV1,
    "bytes" | "now" | "spoolLimits"
  >;
  resolveInput?: (
    request: PdfExportJobRequestV1,
    context: ExportJobExecutionContext,
  ) => Promise<ResolvedExtensionPdfJobInputV1>;
  estimateRender?: (
    input: PdfExportJobEngineInputV1,
    request: PdfExportJobRequestV1,
  ) => ResourceEstimateV1;
  readyToRender?: PdfReadyToRenderStoreV1;
  results?: PdfExportResultStoreV1;
  rasterNormalizerLeaseFactory?: PdfRasterNormalizerLeaseFactoryV1;
  templatePacks?: Pick<TemplatePackStoreV1, "get">;
  createCompiler?: (
    request: PdfExportJobRequestV1,
    context: ExportJobExecutionContext,
  ) => PdfCompilePort;
  privateCompilerDeps?: PrivateCompilerDeps;
}

/**
 * Bind the host-neutral PR-C executor to the productive extension host.
 *
 * This outer executor intentionally accepts the common request type. Format
 * validation and per-claim compiler construction happen inside `execute`, so
 * dispatch errors are caught by `runClaimedExtensionExportJob` and always
 * produce a terminal outer record.
 */
export function createProductiveExtensionPdfExecutor(
  options: CreateProductiveExtensionPdfExecutorOptionsV1,
): ExportJobExecutor<ExportJobRequestV1> {
  const now = options.now ?? Date.now;
  const spoolLimits = options.spoolLimits ?? EXTENSION_PDF_SPOOL_LIMITS_V1;
  const storeOptions: ExtensionPdfExecutorStoreOptionsV1 = {
    ...options.storageOptions,
    bytes: options.bytes,
    now,
    spoolLimits,
  };
  const resolveInput = options.resolveInput
    ?? createExtensionPdfJobInputResolver({ bytes: options.bytes });
  const readyToRender = options.readyToRender
    ?? createExtensionPdfReadyToRenderStore(storeOptions);
  const results = options.results
    ?? createExtensionPdfExportResultStore(storeOptions);
  const estimateRender = options.estimateRender ?? estimateExtensionPdfRenderV1;

  return {
    format: "pdf",
    async execute(
      unresolvedRequest: ExportJobRequestV1,
      context: ExportJobExecutionContext,
    ): Promise<ExportJobExecutionResultV1> {
      const request = parsePdfExportJobRequestV1(unresolvedRequest);
      const compiler = options.createCompiler?.(request, context)
        ?? createOffscreenPrivatePdfCompilePort({
          outerJobId: context.jobId,
          outerLeaseEpoch: context.leaseEpoch,
          sourceIdentity: request.idempotencyKey,
          siteOrigin: request.source.siteOrigin,
          title: request.displayName,
          filename: request.requestedFilename
            ?? sanitizeDownloadName(request.displayName, "pdf"),
          deps: {
            catalog: options.catalog,
            host: options.compilerHost,
            ...options.privateCompilerDeps,
          },
        });
      return createPdfExportJobExecutor({
        resolveInput,
        readyToRender,
        estimateRender,
        compiler,
        renderReservations: options.renderPool.pdf,
        results,
        ...(options.rasterNormalizerLeaseFactory
          ? { rasterNormalizerLeaseFactory: options.rasterNormalizerLeaseFactory }
          : {}),
        ...(options.templatePacks
          ? { templatePacks: options.templatePacks }
          : {}),
        now,
      }).execute(request, context);
    },
  };
}
