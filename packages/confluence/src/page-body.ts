import type { ConfluencePageDetails } from "./client.js";
import type {
  ExportBlock,
  ExportNote,
  StorageParseBudget,
  StorageToBlocksOptions,
} from "./export-blocks.js";
import type {
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
  | "adf-representation-unavailable";

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
