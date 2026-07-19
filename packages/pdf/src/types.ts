import type { Caption, ExportBlock, ExportNote, InlineNode, LinkTarget } from "@atlcli/confluence";

export interface PdfExportMetadata {
  title: string;
  space?: string;
  version?: number;
  author?: string;
  exporter?: string;
  language?: string;
  region?: string;
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
  | Exclude<ExportBlock, { type: "callout" | "list" | "table" | "image" | "blockquote" | "codeBlock" | "orientation" }>
  | { type: "callout"; kind: Extract<ExportBlock, { type: "callout" }>["kind"]; title?: string; content: PreparedPdfBlock[] }
  | { type: "list"; ordered: boolean; items: Array<{ content: PreparedPdfBlock[]; checked?: boolean }> }
  | {
      type: "table";
      rows: Array<{ cells: Array<{ header: boolean; colspan: number; rowspan: number; backgroundColor?: string; content: PreparedPdfBlock[] }> }>;
      columnWidths?: number[];
      caption?: Caption;
    }
  | { type: "image"; assetPath?: string; alt?: string; width?: number; height?: number; fallbackLabel: string; caption?: Caption }
  | { type: "blockquote"; content: PreparedPdfBlock[] }
  | { type: "codeBlock"; language?: string; code: string; caption?: Caption }
  | { type: "diagram"; assetPath: string; alt?: string; source: string; caption?: Caption }
  | { type: "orientation"; landscape: boolean; content: PreparedPdfBlock[] };

export interface PreparedPdfDocument {
  blocks: PreparedPdfBlock[];
  assets: PreparedPdfAsset[];
  notes: ExportNote[];
}

export interface PdfSourceMapEntry {
  blockPath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
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

export type PdfTableCellTextMode = "auto" | "source";

/** Public, serializable configuration for the built-in Typst theme. */
export interface PdfThemeOptions {
  colors?: {
    /** Main document ink. Also becomes the default foreground on light table fills. */
    ink?: string;
    /** Document paper. Also becomes the default foreground on dark table fills. */
    paper?: string;
  };
  table?: {
    coloredCellText?: {
      /** `auto` enforces theme ink; `source` retains source colors only when readable. */
      mode?: PdfTableCellTextMode;
      /** Optional table-specific foreground on perceptually dark source fills. */
      onDark?: string;
      /** Optional table-specific foreground on perceptually light source fills. */
      onLight?: string;
      /** Contrast target used for source-color acceptance and export warnings. */
      minimumContrast?: number;
    };
  };
}

export interface PdfTheme {
  colors: {
    ink: string;
    paper: string;
  };
  table: {
    coloredCellText: {
      mode: PdfTableCellTextMode;
      onDark: string;
      onLight: string;
      minimumContrast: number;
    };
  };
}

export interface PdfSerializeOptions {
  metadata: PdfExportMetadata;
  profile?: PdfProfile;
  theme?: PdfThemeOptions;
}

export interface PdfExportTimings {
  prepareMs: number;
  compileMs: number;
  emitMs: number;
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
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  blockPath?: string;
}

export type { ExportBlock, ExportNote, InlineNode, LinkTarget };
