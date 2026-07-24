import type { ConfluencePageDetails, InlineComment } from "./client.js";
import type {
  ExportBlock,
  ExportNote,
  StorageParseBudget,
  StorageToBlocksOptions,
} from "./export-blocks.js";
import type {
  AdfMediaAttachment,
  AdfMediaReference,
  AdfResolvedMediaAttachment,
} from "./adf-to-blocks.js";
import type { AdfParseBudget } from "./adf-types.js";

/** A page body whose representation has been selected by the source adapter. */
export type PageBody =
  | { representation: "atlas_doc_format"; value: string }
  | { representation: "storage"; value: string };

/** The ADF-specific member of {@link PageBody}. */
export type AtlasDocFormatPageBody = Extract<
  PageBody,
  { representation: "atlas_doc_format" }
>;

/** Why an export source deliberately uses Storage as its primary body. */
export type ExportSourceFallbackReason =
  | "data-center"
  | "adf-representation-unavailable"
  | "rollout-storage-primary";

/** Deployment policy at the export source adapter; never part of a job request. */
export type ExportSourcePolicy = "adf-primary" | "storage-primary";

/**
 * Parse the single rollout/rollback flag shared by export hosts.
 *
 * Hosts own where the value comes from (CLI environment, extension deployment
 * configuration). Keeping parsing here prevents host-specific policy aliases.
 */
export function exportSourcePolicyFromFlag(value: string | undefined): ExportSourcePolicy {
  if (value === undefined || value.trim() === "" || value === "adf") return "adf-primary";
  if (value === "storage") return "storage-primary";
  throw new RangeError('ATLCLI_EXPORT_SOURCE must be either "adf" or "storage".');
}

/**
 * Representation-neutral source selected for one export page.
 *
 * Raw bodies are intentionally short-lived source data. They must not be
 * copied into durable job requests, progress events, or logs.
 */
export interface ExportPageSource {
  primary: PageBody;
  /** Compatibility input for definitions, legacy macros, and correlation. */
  storageSidecar?: string;
  /** Version shared by every body in this source. */
  sourceVersion?: number;
  fallbackReason?: ExportSourceFallbackReason;
}

/** Existing page metadata plus the export-specific representation choice. */
export type ConfluenceExportPageDetails = ConfluencePageDetails & {
  exportSource: ExportPageSource;
  /** Prefetched v2 attachment metadata for exact ADF media-id correlation. */
  mediaAttachments?: AdfMediaAttachment[];
  /** False only when the configured attachment metadata budget truncated. */
  mediaAttachmentsComplete?: boolean;
  /** Privacy-safe, transient v2 sidecar for exact ADF annotation correlation. */
  inlineComments?: InlineComment[];
  /** False only when the configured comment/request budget truncated. */
  inlineCommentsComplete?: boolean;
};

/** Validated transport result of the Cloud v2 ADF page read. */
export interface ConfluencePageAdf {
  id: string;
  version: number;
  /** Opaque until the bounded ADF runtime validator accepts it. */
  body: AtlasDocFormatPageBody;
}

/** Neutral decoder result shared by ADF and Storage source adapters. */
export interface BlocksResult {
  blocks: ExportBlock[];
  notes: ExportNote[];
  representation?: PageBody["representation"];
  degraded?: boolean;
}

/** Options accepted by the representation-neutral decoder dispatcher. */
export interface PageBodyToBlocksOptions
  extends Omit<StorageToBlocksOptions, "parseBudget"> {
  storageParseBudget?: StorageParseBudget;
  adfParseBudget?: Partial<AdfParseBudget>;
  resolveMediaAttachment?: (
    reference: AdfMediaReference,
  ) => AdfResolvedMediaAttachment | undefined;
  resolveAnnotation?: import("./adf-to-blocks.js").AdfToBlocksOptions["resolveAnnotation"];
  annotationCommentsComplete?: boolean;
}

/** Stable, body-free failure classification for export-specific page reads. */
export type ExportPageReadErrorKind =
  | "adf-representation-unavailable"
  | "invalid-adf-response"
  | "invalid-storage-response"
  | "page-version-mismatch";

/**
 * An export page could not produce one trustworthy, version-bound source.
 * Messages and fields contain metadata only, never response bodies.
 */
export class ExportPageReadError extends Error {
  constructor(
    public readonly kind: ExportPageReadErrorKind,
    message: string,
    public readonly pageId?: string,
    public readonly storageVersion?: number,
    public readonly adfVersion?: number,
  ) {
    super(message);
    this.name = "ExportPageReadError";
  }
}
