// This is the extension's explicit DOCX-intent entry. Its first dependency
// installs the browser runtime and pulls the engine into the same ordered graph
// before export-wiring can evaluate its @atlcli/docx engine imports.
import "@atlcli/docx/browser-entry";
import {
  parseDocxExportJobRequestV1,
  type DocxExportJobRequestV1,
  type ExportJobExecutionContext,
  type ExportJobExecutionResultV1,
  type ExportJobExecutor,
  type ExportJobRequestV1,
  type ResourceEstimateV1,
  type SpoolWriteLimitsV1,
} from "@atlcli/export-jobs";
import {
  createTypescriptDocxExportJobExecutor,
  type DocxExportResultStoreV1,
  type DocxPinnedTemplatePortV1,
  type DocxReadyToRenderStoreV1,
  type TypescriptDocxExportJobEngineInputV1,
} from "@atlcli/export-wiring/jobs";
import { IndexedDbExportByteStore } from "./chunk-store.js";
import {
  createExtensionDocxExportResultStore,
  createExtensionDocxReadyToRenderStore,
  type ExtensionDocxExecutorStoreOptionsV1,
} from "./docx-executor-store.js";
import { createExtensionDocxJobInputResolver } from "./docx-resolver.js";
import { createExtensionDocxPinnedTemplatePort } from "./docx-template.js";
import { BrowserRenderReservationPoolV1 } from "./render-reservation.js";

const MIB = 1024 * 1024;

export const EXTENSION_DOCX_SPOOL_LIMITS_V1: SpoolWriteLimitsV1 = Object.freeze({
  maxObjectBytes: 128 * MIB,
  maxJobBytes: 256 * MIB,
  maxTotalBytes: 512 * MIB,
});

export const EXTENSION_DOCX_MAX_OUTPUT_BYTES_V1 = 64 * MIB;

/** Conservative first-delivery bound shared with the single browser heavy slot. */
export function estimateExtensionDocxRenderV1(
  _input: TypescriptDocxExportJobEngineInputV1,
  _request: DocxExportJobRequestV1,
): ResourceEstimateV1 {
  return {
    heapBytes: 512 * MIB,
    spoolBytes: EXTENSION_DOCX_SPOOL_LIMITS_V1.maxObjectBytes,
    outputBytes: EXTENSION_DOCX_MAX_OUTPUT_BYTES_V1,
    rasterPixels: 32 * MIB,
    confidence: "unknown",
  };
}

export interface CreateProductiveExtensionDocxExecutorOptionsV1 {
  bytes: IndexedDbExportByteStore;
  renderPool: BrowserRenderReservationPoolV1;
  now?: () => number;
  /** Override the adaptive in-memory versus streamed packaging boundary. */
  streamingPreparedBytesThreshold?: number;
  spoolLimits?: SpoolWriteLimitsV1;
  storageOptions?: Omit<
    ExtensionDocxExecutorStoreOptionsV1,
    "bytes" | "now" | "spoolLimits"
  >;
  resolveInput?: (
    request: DocxExportJobRequestV1,
    context: ExportJobExecutionContext,
  ) => Promise<TypescriptDocxExportJobEngineInputV1>;
  estimateRender?: (
    input: TypescriptDocxExportJobEngineInputV1,
    request: DocxExportJobRequestV1,
  ) => ResourceEstimateV1;
  templates?: DocxPinnedTemplatePortV1;
  readyToRender?: DocxReadyToRenderStoreV1;
  results?: DocxExportResultStoreV1;
}

/** Bind the host-neutral TypeScript DOCX executor to the productive browser host. */
export function createProductiveExtensionDocxExecutor(
  options: CreateProductiveExtensionDocxExecutorOptionsV1,
): ExportJobExecutor<ExportJobRequestV1> {
  const now = options.now ?? Date.now;
  const spoolLimits = options.spoolLimits ?? EXTENSION_DOCX_SPOOL_LIMITS_V1;
  const storeOptions: ExtensionDocxExecutorStoreOptionsV1 = {
    ...options.storageOptions,
    bytes: options.bytes,
    now,
    spoolLimits,
  };
  const resolveInput = options.resolveInput ?? createExtensionDocxJobInputResolver();
  const templates = options.templates
    ?? createExtensionDocxPinnedTemplatePort(options.bytes);
  const readyToRender = options.readyToRender
    ?? createExtensionDocxReadyToRenderStore(storeOptions);
  const results = options.results
    ?? createExtensionDocxExportResultStore(storeOptions);
  const estimateRender = options.estimateRender ?? estimateExtensionDocxRenderV1;

  return {
    format: "docx",
    async execute(
      unresolvedRequest: ExportJobRequestV1,
      context: ExportJobExecutionContext,
    ): Promise<ExportJobExecutionResultV1> {
      const request = parseDocxExportJobRequestV1(unresolvedRequest);
      return createTypescriptDocxExportJobExecutor({
        resolveInput,
        estimateRender,
        templates,
        readyToRender,
        renderReservations: options.renderPool.docx,
        results,
        now,
        streamingPreparedBytesThreshold: options.streamingPreparedBytesThreshold,
      }).execute(request, context);
    },
  };
}
