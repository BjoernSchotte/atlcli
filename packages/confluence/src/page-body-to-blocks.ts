import { adfToBlocks } from "./adf-to-blocks.js";
import {
  storageToBlocks,
  type ExportNote,
  type StorageToBlocksOptions,
} from "./export-blocks.js";
import type {
  BlocksResult,
  ExportPageSource,
  ExportSourceFallbackReason,
  PageBodyToBlocksOptions,
} from "./page-body.js";

/**
 * Decode the explicitly selected primary representation exactly once.
 *
 * Malformed/over-budget ADF is an input failure and is never retried through
 * the Storage sidecar. Storage is used only when the source adapter selected
 * it as primary (Data Center or proven Cloud capability absence).
 */
export function pageBodyToBlocks(
  source: ExportPageSource,
  options: PageBodyToBlocksOptions = {},
): BlocksResult {
  const common = {
    ...(options.exporter ? { exporter: options.exporter } : {}),
    ...(options.exportControls ? { exportControls: options.exportControls } : {}),
    ...(options.pageContext ? { pageContext: options.pageContext } : {}),
  } satisfies Omit<StorageToBlocksOptions, "parseBudget">;

  switch (source.primary.representation) {
    case "atlas_doc_format":
      if (source.fallbackReason !== undefined) {
        throw new TypeError("An ADF-primary export source cannot carry a Storage fallback reason.");
      }
      return adfToBlocks(source.primary.value, {
        ...common,
        ...(options.adfParseBudget ? { parseBudget: options.adfParseBudget } : {}),
        ...(options.resolveMediaAttachment ? { resolveMediaAttachment: options.resolveMediaAttachment } : {}),
      });
    case "storage": {
      const decoded = storageToBlocks(source.primary.value, {
        ...common,
        ...(options.storageParseBudget ? { parseBudget: options.storageParseBudget } : {}),
      });
      const fallbackNote = source.fallbackReason
        ? storageFallbackNote(source.fallbackReason, options.pageContext)
        : undefined;
      return {
        blocks: decoded.blocks,
        notes: fallbackNote ? [fallbackNote, ...decoded.notes] : decoded.notes,
        representation: "storage",
        ...(decoded.degraded !== undefined ? { degraded: decoded.degraded } : {}),
      };
    }
    default:
      return assertNever(source.primary);
  }
}

function storageFallbackNote(
  reason: ExportSourceFallbackReason,
  pageContext?: StorageToBlocksOptions["pageContext"],
): ExportNote {
  return {
    level: "info",
    code: "adf-storage-fallback",
    message: reason === "data-center"
      ? "Storage was selected because this deployment does not expose the Cloud ADF page contract."
      : reason === "rollout-storage-primary"
        ? "Storage was selected by the export-source rollout policy."
        : "Storage was selected because the page API proved ADF representation unavailable for this capability.",
    ...(pageContext ? {
      source: {
        pageId: pageContext.id,
        ...(pageContext.title ? { pageTitle: pageContext.title } : {}),
        ...(pageContext.url ? { pageUrl: pageContext.url } : {}),
        blockPath: "blocks",
      },
    } : {}),
  };
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported page body representation: ${String((value as { representation?: unknown }).representation)}`);
}
