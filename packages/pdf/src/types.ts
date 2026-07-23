import type {
  Caption,
  ExportBlock,
  ExportNote,
  InlineNode,
  LinkTarget,
  ListItem,
  LayoutColumn,
  TableCell,
  TableRow,
} from "@atlcli/confluence";
import type { TemplateManifest } from "@atlcli/template-pack";

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
  /**
   * Provenance (spec 004). `"export-view"` marks a URL from a third-party app's
   * rendered macro HTML (untrusted) that a host SHOULD route through its
   * stricter external-asset fetcher/policy; `"page"`/absent is the trusted
   * page-author path.
   */
  trust?: "page" | "export-view";
  /**
   * The id of the page the attachment lives on (spec 008 T3.3). Threaded so a
   * host resolver can disambiguate identically named attachments on different
   * pages in a tree/space export, instead of colliding on filename alone.
   * Undefined for external refs and single-page exports without page context.
   */
  pageId?: string;
}

export interface PdfResolvedAsset {
  bytes: Uint8Array;
  mediaType: string;
  filename?: string;
}

export interface PdfAssetResolver {
  /**
   * Resolve an asset. `context.signal` (spec 008 T3.2) lets a Ctrl-C abort an
   * in-flight image fetch instead of it running to completion and being
   * downgraded to a soft skip note.
   */
  resolve(ref: PdfAssetRef, context?: { signal?: AbortSignal }): Promise<PdfResolvedAsset>;
}

export interface PreparedPdfAsset {
  path: string;
  bytes: Uint8Array;
  mediaType: string;
}

export type PreparedPdfBlock =
  | Exclude<ExportBlock, { type: "callout" | "expand" | "list" | "layout" | "table" | "image" | "blockquote" | "codeBlock" | "orientation" | "unknown" }>
  /**
   * An unresolved macro (spec 004 placeholder floor). `body` is prepared
   * recursively so images/tables inside an unresolved third-party macro still
   * render; `plainBody` is the verbatim plain-text body.
   */
  | { type: "unknown"; macroName: string; body?: PreparedPdfBlock[]; plainBody?: string }
  | { type: "callout"; kind: Extract<ExportBlock, { type: "callout" }>["kind"]; title?: string; content: PreparedPdfBlock[] }
  | Omit<Extract<ExportBlock, { type: "expand" }>, "content"> & {
      content: PreparedPdfBlock[];
    }
  | Omit<Extract<ExportBlock, { type: "list" }>, "items"> & {
      items: Array<Omit<ListItem, "content"> & { content: PreparedPdfBlock[] }>;
    }
  | Omit<Extract<ExportBlock, { type: "layout" }>, "columns"> & {
      columns: Array<Omit<LayoutColumn, "content"> & { content: PreparedPdfBlock[] }>;
    }
  | Omit<Extract<ExportBlock, { type: "table" }>, "rows"> & {
      rows: Array<Omit<TableRow, "cells"> & {
        cells: Array<Omit<TableCell, "content"> & { content: PreparedPdfBlock[] }>;
      }>;
    }
  | { type: "image"; assetPath?: string; alt?: string; width?: number; height?: number; fallbackLabel: string; caption?: Caption }
  | { type: "blockquote"; content: PreparedPdfBlock[] }
  | Extract<ExportBlock, { type: "codeBlock" }>
  | {
      type: "diagram";
      assetPath: string;
      alt?: string;
      source: string;
      caption?: Caption;
      /** Retained from an ADF code block even when Mermaid becomes a diagram. */
      wrap?: boolean;
      hideLineNumbers?: boolean;
      firstLineNumber?: number;
      localId?: string;
      uniqueId?: string;
    }
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

/**
 * Level-A PDF template settings — the fixed, built-in settings surface.
 *
 * IMPORTANT boundary: `PdfTemplateSettings` is a *closed* set of named fields
 * consumed directly by the built-in `atlcli-doc` template. It is **not** the
 * same shape as a template-pack manifest's `settings` map, which is an *open*,
 * arbitrarily-named, typed dictionary (`accent`, `logo`, font choices, …) used
 * by Level-B templates. This folder deliberately does not thread
 * manifest-declared custom settings into the render call — that requires the
 * host-side Level-B template-loading glue that lives outside `packages/pdf`.
 * A later folder must keep the two shapes distinct rather than conflating them
 * (see 007 PLAN "Built-in vs. manifest settings" risk).
 *
 * All fields are optional and plain JSON-able so every host (CLI flags,
 * extension form, further hosts) can supply them without importing engine code.
 */
export interface PdfWatermarkSettings {
  /** Watermark text. Required when a watermark is requested; must be non-empty. */
  text: string;
  /** `#RRGGBB`; default `#DE350B`. */
  color?: string;
  /** In `(0, 1]`; default `0.08`. `0`, `NaN`, and `Infinity` are rejected. */
  opacity?: number;
  /** Rotation in degrees, `-180..180`; default `-54`. */
  angle?: number;
  /** Glyph size in pt, `8..400`; default `96`. */
  size?: number;
}

export interface PdfLogoAsset {
  bytes: Uint8Array;
  mediaType: "image/png" | "image/svg+xml";
  /** Required when the logo is present (meaning-bearing); must be non-empty. */
  alt?: string;
}

export interface PdfTemplateSettings {
  page?: "a4" | "letter";
  orientation?: "portrait" | "landscape";
  cover?: boolean;
  outline?: boolean;
  headerText?: string;
  footerText?: string;
  /** `#RRGGBB`; default the built-in indigo `#4B57A3`. */
  accentColor?: string;
  organizationName?: string;
  logo?: PdfLogoAsset;
  watermark?: PdfWatermarkSettings;
}

export interface PdfSerializeOptions {
  metadata: PdfExportMetadata;
  profile?: PdfProfile;
  theme?: PdfThemeOptions;
  settings?: PdfTemplateSettings;
  /**
   * The curated template manifest to render with (spec 012). Its `design`,
   * `bindings`, and `localization` drive the resolver and the generated Typst
   * template. Defaults to the built-in "Editorial Indigo". A second curated
   * template (e.g. "Manuscript") renders through the identical engine code path
   * — only this manifest differs. Host UI for selecting a template is folder
   * 010's job; this field is the data seam it drives.
   */
  templateManifest?: TemplateManifest;
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
  /**
   * The SOURCE half of {@link notes} — the host's `sourceNotes` — AFTER
   * dynamic-macro reconciliation (spec 010). A host that builds a
   * per-source-page view of the report must project THIS rather than the notes
   * it walked itself: the walker's `macro-not-rendered`/`unknown-macro` is
   * provisional, and only this pass knows it became `macro-rendered-via`.
   * Always set by `runPdfExport`; optional so hand-built report literals stay
   * additive.
   */
  sourceNotes?: ExportNote[];
  /**
   * False when the composed document omitted content (partial-mode unreadable
   * pages, spec 002). Single-page/normal exports are `true`.
   */
  complete: boolean;
  /**
   * Compiler diagnostics from a SUCCESSFUL compile (spec 008 T3.4). Previously
   * dropped unless the compile failed, which made `--strict` a no-op for real
   * Typst warnings on an otherwise-valid document; surfaced here so a host can
   * fold them into its report's issues. Always set by `runPdfExport` (empty for
   * a clean compile); optional so hand-built report literals stay additive.
   */
  compilerDiagnostics?: PdfCompilerDiagnostic[];
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

/**
 * Font-intake seam (spec 007 B5). An approved corporate font face a host may
 * feed into the PDF compiler. The engine never fetches font bytes: a host
 * resolves them through a {@link FontSource} and hands them to the compiler as
 * `Uint8Array[]`, after gating each one through `verifyFontBytes` (see
 * `fonts.ts`).
 */
export interface FontAsset {
  family: string;
  style: "normal" | "italic";
  weight: number;
  /** Lowercase hex SHA-256 of the exact font bytes; re-verified before use. */
  sha256: string;
  /** Optional license attestation carried alongside the approved face. */
  license?: { kind: "OFL" | "Apache-2.0" | "proprietary"; evidence: string };
}

/**
 * Host-provided port for approved fonts, mirroring {@link PdfAssetResolver}.
 * Implementers own storage and the upload/attestation flow (host follow-ups);
 * the engine only consumes `list()` (e.g. to build a `choice` setting's options)
 * and `getBytes(sha256)`, whose result MUST be passed through `verifyFontBytes`
 * before it reaches the compiler.
 */
export interface FontSource {
  list(): Promise<FontAsset[]>;
  getBytes(sha256: string): Promise<Uint8Array>;
}
