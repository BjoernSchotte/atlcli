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
  output: { policy: "collect" | "path" | "host"; targetRef?: string };
}

/** Version-1 TypeScript DOCX export request. */
export interface DocxExportJobRequestV1 extends ExportJobRequestBaseV1 {
  format: "docx";
  renderer: "docx-typescript";
  template: { recordKey: string; sha256: string; name: string };
  options: {
    embedImages: boolean;
    resolveMacros: boolean;
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
  options: { resolveMacros: boolean; profile?: string };
}

/** Closed version-1 export request union. */
export type ExportJobRequestV1 = DocxExportJobRequestV1 | PdfExportJobRequestV1;
