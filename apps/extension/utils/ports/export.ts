/**
 * Engine ports (spec 010 Phase 0).
 *
 * PDF and DOCX are two independent ports, never one "export" port with a
 * `format` discriminator. `forge-export-app/SPIKE.md` records a conditional GO
 * in which PDF-WASM fails in a Forge iframe while DOCX works ("Browserbasis nur
 * DOCX"); a shared path would make that outcome a rewrite instead of a
 * capability flag. `AppPorts.pdf === null` and `AppPorts.docx === null` are
 * therefore both legal, independently.
 *
 * Both ports are host-implemented and lazily loaded: in the extension `run`
 * dynamically imports the heavy engine chunk on first use, so a panel that
 * never exports never pays for Typst WASM or PizZip.
 */
import type { ExportReport } from "@atlcli/docx/browser";
import type { ScanResult } from "@atlcli/docx/scan";
import type { PdfExportReport } from "@atlcli/pdf/browser";
import type { LoadedPage } from "../read-path.js";

/**
 * User-visible export phases.
 *
 * Declared here rather than imported from `utils/pdf/run-export.ts` so the
 * portable layer does not name an extension module. The extension adapter
 * assigns that module's `PdfExportPhase` values straight into this union, so a
 * divergence between the two is a compile error at the adapter — which is the
 * point.
 */
export type ExportPhase =
  | "preparing"
  | "fetching"
  | "queued"
  | "compiling"
  | "validating"
  | "downloading";

export interface PdfExportRequest {
  page: LoadedPage;
  /** Page URL — hosts that need an origin for asset fetches key on it. */
  pageUrl: string;
  signal?: AbortSignal;
  onPhase?: (phase: ExportPhase) => void;
}

export interface PdfExportPort {
  run(request: PdfExportRequest): Promise<PdfExportReport>;
}

/** One stored DOCX template. Phase 0 keeps today's single-slot model. */
export interface DocxTemplateRecord {
  name: string;
  uploadedAt: number;
  bytes: ArrayBuffer;
}

/**
 * Persistence for template bytes.
 *
 * Single-slot in Phase 0, matching `utils/docx/template-store.ts`'s `"current"`
 * record. T5.2 replaces the implementation with the multi-slot library; this
 * interface then grows list/select methods rather than the screens growing
 * storage knowledge.
 */
export interface DocxTemplateStore {
  get(): Promise<DocxTemplateRecord | null>;
  put(record: { name: string; bytes: ArrayBuffer }): Promise<DocxTemplateRecord>;
  remove(): Promise<void>;
}

export interface DocxExportRequest {
  page: LoadedPage;
  pageUrl: string;
  template: DocxTemplateRecord;
  signal?: AbortSignal;
}

export interface DocxExportPort {
  /**
   * Validate and classify template bytes.
   *
   * Throws the engine's own rejection error (a `DocxError`-shaped value with a
   * `kind`) so the UI can map the known kinds to translated copy and quote the
   * engine's message verbatim for everything else.
   */
  scan(bytes: Uint8Array): Promise<ScanResult>;

  run(request: DocxExportRequest): Promise<ExportReport>;

  /**
   * Optional: pre-fetch the heavy engine chunks because an export is likely
   * (a template already exists). Pure warm-up — failures must be swallowed.
   */
  warm?(): void;
}
