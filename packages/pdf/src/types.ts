import type { ExportBlock, ExportNote, InlineNode, LinkTarget } from "@atlcli/confluence";

export interface PdfExportMetadata {
  title: string;
  space?: string;
  version?: number;
  author?: string;
  exporter?: string;
  language?: string;
  exportedAt: Date;
}

export interface PdfAssetRef {
  kind: "attachment" | "external";
  filename?: string;
  url?: string;
}

export interface PdfResolvedAsset {
  bytes: Uint8Array;
  mediaType: string;
  filename?: string;
}

export interface PdfAssetResolver {
  resolve(ref: PdfAssetRef): Promise<PdfResolvedAsset>;
}

export interface PreparedPdfAsset {
  path: string;
  bytes: Uint8Array;
  mediaType: string;
}

export type PreparedPdfBlock =
  | Exclude<ExportBlock, { type: "callout" | "list" | "table" | "image" | "blockquote" | "codeBlock" }>
  | { type: "callout"; kind: Extract<ExportBlock, { type: "callout" }>["kind"]; title?: string; content: PreparedPdfBlock[] }
  | { type: "list"; ordered: boolean; items: Array<{ content: PreparedPdfBlock[]; checked?: boolean }> }
  | { type: "table"; rows: Array<{ cells: Array<{ header: boolean; colspan: number; rowspan: number; content: PreparedPdfBlock[] }> }> }
  | { type: "image"; assetPath?: string; alt?: string; width?: number; height?: number; fallbackLabel: string }
  | { type: "blockquote"; content: PreparedPdfBlock[] }
  | { type: "codeBlock"; language?: string; code: string }
  | { type: "diagram"; assetPath: string; alt?: string; source: string };

export interface PreparedPdfDocument {
  blocks: PreparedPdfBlock[];
  assets: PreparedPdfAsset[];
  notes: ExportNote[];
}

export interface PdfSourceMapEntry {
  blockPath: string;
  startLine: number;
  endLine: number;
  blockType: PreparedPdfBlock["type"];
  summary?: string;
}

export interface PdfSourceBundle {
  main: string;
  template: string;
  assets: PreparedPdfAsset[];
  sourceMap: PdfSourceMapEntry[];
  notes: ExportNote[];
}

export type PdfProfile = "tagged" | "pdf-ua-1";

export interface PdfSerializeOptions {
  metadata: PdfExportMetadata;
  profile?: PdfProfile;
}

export interface PdfExportTimings {
  prepareMs: number;
  compileMs: number;
  downloadMs: number;
  totalMs: number;
}

export interface PdfExportReport {
  filename: string;
  profile: PdfProfile;
  compilerVersion: string;
  pageCount?: number;
  embeddedImages: number;
  renderedDiagrams: number;
  skippedAssets: number;
  notes: ExportNote[];
  timings: PdfExportTimings;
}

export interface PdfCompilerDiagnostic {
  severity: "error" | "warning";
  message: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  blockPath?: string;
}

export type { ExportBlock, ExportNote, InlineNode, LinkTarget };
