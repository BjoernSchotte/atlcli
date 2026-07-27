import type { CodeThemeId } from "@atlcli/code-highlight/registry";
import type { ExportFormat, ExportSourceV1 } from "./source.js";

/** Fields shared by every version-1 export request. */
export interface ExportJobRequestBaseV1 {
  schema: "atlcli.export-job-request/1";
  id: string;
  idempotencyKey: string;
  format: ExportFormat;
  source: ExportSourceV1;
  authRef: string;
  displayName: string;
  requestedFilename?: string;
  createdAt: number;
  priority: "interactive" | "retry";
  output: {
    policy: "collect" | "path" | "host";
    targetRef?: string;
    /** Path targets are files unless explicitly recorded as a directory. */
    targetKind?: "file" | "directory";
    /**
     * Durable authorization to replace an existing delivery target. Omitted is
     * fail-closed (`false`). CLI hosts map an explicit `--force` to `true` so a
     * later Retry/Run-again cannot silently acquire broader write authority.
     */
    overwriteExisting?: boolean;
  };
}

/** Version-1 TypeScript DOCX export request. */
export interface DocxExportJobRequestV1 extends ExportJobRequestBaseV1 {
  format: "docx";
  renderer: "docx-typescript";
  template: {
    recordKey: string;
    sha256: string;
    name: string;
    /** Pinned upload timestamp for deterministic template placeholders. */
    uploadedAt?: number;
  };
  options: {
    embedImages: boolean;
    resolveMacros: boolean;
    /** Effective theme; absent only on historical schema-v1 records. */
    codeTheme?: CodeThemeId;
    /** Preserve scroll-only/scroll-ignore content in the rendered document. */
    keepIgnored?: boolean;
    /** Turn warning-level report issues into the host's strict failure outcome. */
    strict?: boolean;
    /** `--no-field-update-prompt` is represented exactly as `"never"`. */
    updateFields?: "auto" | "always" | "never";
    captionLang?: string;
  };
}

export interface PdfExportWatermarkV1 {
  text: string;
  color?: string;
  opacity?: number;
  angle?: number;
  size?: number;
}

/** Durable pinned logo identity; bytes remain in a protected host-owned asset store. */
export interface PdfExportLogoV1 {
  assetRef: string;
  sha256: string;
  byteLength: number;
  mediaType: "image/png" | "image/svg+xml";
  alt: string;
}

export interface PdfExportSettingsV1 {
  page?: "a4" | "letter";
  orientation?: "portrait" | "landscape";
  cover?: boolean;
  outline?: boolean;
  headerText?: string;
  footerText?: string;
  accentColor?: string;
  organizationName?: string;
  watermark?: PdfExportWatermarkV1;
  logo?: PdfExportLogoV1;
  /** Manifest-declared scalar settings remain separate from built-in settings. */
  custom?: Record<string, string | number | boolean | null>;
}

/** Version-1 Typst PDF export request. */
export interface PdfExportJobRequestV1 extends ExportJobRequestBaseV1 {
  format: "pdf";
  renderer: "pdf-typst";
  template: { id: string; manifestVersion: string };
  settings: PdfExportSettingsV1;
  options: {
    resolveMacros: boolean;
    /** Effective theme; absent only on historical schema-v1 records. */
    codeTheme?: CodeThemeId;
    profile?: string;
    /** Turn warning-level report issues into the host's strict failure outcome. */
    strict?: boolean;
    /** Disable reuse or persistence of the host's downloaded-asset cache. */
    noCache?: boolean;
    /** Explicit reproducible export timestamp, as Unix epoch milliseconds. */
    exportedAt?: number;
    /**
     * Explicit image-quality profile (issue #118 Phase 1/3). Absent means
     * `original` (byte-identical rasters). Persisted here so retries render
     * with the identical quality and the recovery key absorbs it.
     */
    imageProfile?: "original" | "standard" | "print";
    /** Advanced exact-PPI override in [72, 1200]; invalid with `original`. */
    imagePpi?: number;
  };
}

/** Closed version-1 export request union. */
export type ExportJobRequestV1 = DocxExportJobRequestV1 | PdfExportJobRequestV1;
