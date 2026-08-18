import type { ImportDocumentV2, ImportOutcome } from "@atlcli/import-core";

export const PDF_FACTS_SCHEMA_V1 = "atlcli.pdf-facts/1" as const;
export const PDFIUM_ENGINE_VERSION = "2.15.0" as const;
export const PDFIUM_WASM_SHA256 = "c0af5a6aca30d7e54a149c3a68e317116ca906d6edc28fd3318b12c7d9478ac8" as const;
export const PDF_FACTS_ADAPTER_REVISION = "atlcli.pdfium-public-fpdf/1" as const;
export const PDF_ANALYSIS_POLICY_REVISION = "atlcli.pdf-analysis-policy/1" as const;
export const PDF_ASSET_MATERIALIZER_REVISION = "atlcli.pdfium-asset-materializer/1" as const;

export interface PdfNormalizedRect {
  /** Left edge in page-normalized top-left coordinates, 0..1. */
  x: number;
  /** Top edge in page-normalized top-left coordinates, 0..1. */
  y: number;
  width: number;
  height: number;
}

export interface PdfTextCharacterFact {
  index: number;
  unicode: number;
  value: string;
  bbox: PdfNormalizedRect | null;
  fontSizePoints: number;
  fontWeight: number;
  angleRadians: number;
  mcid: number | null;
  generated: boolean;
  hyphen: boolean;
  unicodeMapError: boolean;
}

export interface PdfStructureAttributeFact {
  name: string;
  type: number;
  value: boolean | number | string | PdfStructureAttributeFact[] | null;
}

export interface PdfStructureNodeFact {
  id: string;
  type: string;
  title: string;
  alt: string;
  actualText: string;
  language: string;
  elementId: string;
  mcids: number[];
  childMcids: number[];
  attributes: PdfStructureAttributeFact[];
  children: PdfStructureNodeFact[];
}

export interface PdfImageObjectFact {
  id: string;
  mcid: number | null;
  bbox: PdfNormalizedRect | null;
  pixelWidth: number;
  pixelHeight: number;
  decodedBytes: number;
}

export interface PdfPathObjectFact {
  id: string;
  mcid: number | null;
  bbox: PdfNormalizedRect | null;
  segmentCount: number;
  fillMode: number;
  stroke: boolean;
}

export interface PdfAnnotationFact {
  id: string;
  subtype: number;
  bbox: PdfNormalizedRect | null;
  actionType: number | null;
  /** Only allowlisted http/https/mailto targets survive normalization. */
  safeExternalTarget: string | null;
  unsafeTargetReported: boolean;
}

export type PdfPageKind = "digital" | "image-only" | "mixed" | "blank";
export type PdfDocumentClassification =
  | "tagged"
  | "digital-untagged"
  | "scan"
  | "mixed"
  | "blank"
  | "encrypted"
  | "rejected";

export interface PdfPageFactsV1 {
  index: number;
  label?: string;
  widthPoints: number;
  heightPoints: number;
  boxes: {
    bounding: PdfNormalizedRect | null;
    media: PdfNormalizedRect | null;
    crop: PdfNormalizedRect | null;
    bleed: PdfNormalizedRect | null;
    trim: PdfNormalizedRect | null;
    art: PdfNormalizedRect | null;
  };
  rotation: number;
  kind: PdfPageKind;
  text: string;
  characters: PdfTextCharacterFact[];
  structures: PdfStructureNodeFact[];
  objectTypeCounts: Record<string, number>;
  operatorSummary: { capability: "unavailable"; count: null };
  images: PdfImageObjectFact[];
  paths: PdfPathObjectFact[];
  annotations: PdfAnnotationFact[];
}

export interface PdfFactsIssue {
  code: string;
  severity: "info" | "warning" | "error";
  outcome: ImportOutcome;
  message: string;
  pageIndex?: number;
  sourceRefs?: string[];
  context?: Record<string, string | number>;
}

export interface PdfEngineCapabilitiesV1 {
  textCharacters: true;
  normalizedCharacterGeometry: true;
  structureTree: true;
  structureAttributes: true;
  pageLabels: true;
  outline: true;
  annotations: true;
  pageObjects: true;
  pathGeometry: true;
  imageMetadata: true;
  operatorList: false;
  nativeTableExtraction: false;
  ocr: false;
  activeContentExecution: false;
}

export interface PdfAnalysisProvenanceV1 {
  engine: "pdfium";
  engineVersion: typeof PDFIUM_ENGINE_VERSION;
  wasmSha256: typeof PDFIUM_WASM_SHA256;
  adapterRevision: typeof PDF_FACTS_ADAPTER_REVISION;
  policyRevision: typeof PDF_ANALYSIS_POLICY_REVISION;
  optionsDigest: string;
  capabilities: PdfEngineCapabilitiesV1;
}

export interface PdfCompletenessV1 {
  expectedPages: number;
  analyzedPages: number;
  pageIndexes: number[];
  complete: boolean;
}

export interface PdfFactsV1 {
  schema: typeof PDF_FACTS_SCHEMA_V1;
  provenance: PdfAnalysisProvenanceV1;
  inputSha256: string;
  inputBytes: number;
  pageCount: number;
  tagged: boolean;
  encrypted: boolean;
  classification: PdfDocumentClassification;
  completeness: PdfCompletenessV1;
  pages: PdfPageFactsV1[];
  outline: Array<{ title: string; pageIndex: number | null; depth: number }>;
  inertFeatures: {
    javascriptActionCount: number;
    attachmentCount: number;
    namedDestinationCount: number;
    formType: number;
  };
  loadError: number | null;
  issues: PdfFactsIssue[];
}

export interface PdfAnalysisTelemetry {
  initMs: number;
  loadMs: number;
  pagesMs: number;
  totalMs: number;
  wasmInitialBytes: number;
  wasmPeakBytes: number;
  wasmFinalBytes: number;
}

export interface PdfAnalysisResultV1 {
  facts: PdfFactsV1;
  factsDigest: string;
  telemetry: PdfAnalysisTelemetry;
}

export type PdfAnalysisProgress =
  | { phase: "start"; completedPages: 0; totalPages: null }
  | { phase: "document-loaded"; completedPages: 0; totalPages: number }
  | { phase: "page-start"; completedPages: number; totalPages: number; pageIndex: number }
  | { phase: "page-complete"; completedPages: number; totalPages: number; pageIndex: number }
  | { phase: "complete"; completedPages: number; totalPages: number }
  | { phase: "cleanup"; completedPages: number; totalPages: number | null };

export interface PdfAnalysisOptions {
  signal?: AbortSignal;
  /** May only tighten the immutable hard ceilings. */
  budgets?: Partial<import("./budgets.js").PdfAnalysisBudgets>;
  progress?: (event: PdfAnalysisProgress) => void;
}

export interface PdfAssetMaterializationRequestV1 {
  id: string;
  pageIndex: number;
  kind: "image-object" | "rendered-region";
  objectId?: string;
  bbox?: PdfNormalizedRect;
  dpi?: number;
}

export interface PdfMaterializedAssetV1 {
  requestId: string;
  pageIndex: number;
  sourceKind: "image-object" | "rendered-region";
  mediaType: "image/png";
  width: number;
  height: number;
  bytes: Uint8Array;
  sha256: string;
  materializerRevision: typeof PDF_ASSET_MATERIALIZER_REVISION;
}

export interface PdfAssetMaterializationOptions {
  signal?: AbortSignal;
  /** May only tighten the immutable hard ceilings. */
  budgets?: Partial<import("./budgets.js").PdfAnalysisBudgets>;
  progress?: (event: PdfAssetMaterializationProgress) => void;
}

export type PdfAssetMaterializationProgress =
  | { phase: "start"; completed: 0; total: number }
  | { phase: "request-start"; completed: number; total: number; requestId: string }
  | { phase: "request-complete"; completed: number; total: number; requestId: string }
  | { phase: "cleanup"; completed: number; total: number };

export interface PdfFactsAdapter {
  analyze(data: Uint8Array, options?: PdfAnalysisOptions): Promise<PdfAnalysisResultV1>;
  materialize(
    data: Uint8Array,
    requests: readonly PdfAssetMaterializationRequestV1[],
    options?: PdfAssetMaterializationOptions,
  ): Promise<PdfMaterializedAssetV1[]>;
}

export const PDF_TAGGED_SEMANTICS_SCHEMA_V1 = "atlcli.pdf-tagged-semantics/1" as const;
export const PDF_TAGGED_POLICY_REVISION = "atlcli.pdf-tagged-policy/1" as const;
export const PDF_UNTAGGED_SEMANTICS_SCHEMA_V1 = "atlcli.pdf-untagged-semantics/1" as const;
export const PDF_GEOMETRY_POLICY_REVISION = "atlcli.pdf-geometry-policy/1" as const;
export const PDF_TABLE_POLICY_REVISION = "atlcli.pdf-table-policy/1" as const;
export const PDF_FIGURE_POLICY_REVISION = "atlcli.pdf-figure-policy/1" as const;
export const PDF_VISUAL_FALLBACK_POLICY_REVISION = "atlcli.pdf-visual-fallback-policy/1" as const;

export interface PdfSourceLocatorV1 {
  pageIndex: number;
  pageLabel?: string;
  bbox?: PdfNormalizedRect;
  structurePath?: string;
  markedContentIds?: string[];
  annotationId?: string;
  objectFingerprint?: string;
}

export type PdfEvidenceBasis =
  | "structure-tree"
  | "marked-content"
  | "outline"
  | "text-geometry"
  | "font-evidence"
  | "annotation"
  | "path-object"
  | "image-object"
  | "operator-list"
  | "rendered-region"
  | "ocr";

export interface PdfDecisionEvidenceV1 {
  sourceId: string;
  targetNodeId?: string;
  locator: PdfSourceLocatorV1;
  basis: PdfEvidenceBasis[];
  confidence: number;
  decisionCode: string;
  outcome: ImportOutcome;
  analyzerRevision:
    | typeof PDF_TAGGED_POLICY_REVISION
    | typeof PDF_GEOMETRY_POLICY_REVISION
    | typeof PDF_TABLE_POLICY_REVISION
    | typeof PDF_FIGURE_POLICY_REVISION
    | typeof PDF_VISUAL_FALLBACK_POLICY_REVISION;
}

export interface PdfTaggedPageOutcomeV1 {
  pageIndex: number;
  mode: "tagged-native" | "geometry-required";
  projectedNodeIds: string[];
  claimedCharacterCount: number;
  unclaimedCharacterCount: number;
  corruptTagCount: number;
}

export interface PdfTaggedSemanticsV1 {
  schema: typeof PDF_TAGGED_SEMANTICS_SCHEMA_V1;
  factsDigest: string;
  policyRevision: typeof PDF_TAGGED_POLICY_REVISION;
  document: ImportDocumentV2;
  evidence: PdfDecisionEvidenceV1[];
  pageOutcomes: PdfTaggedPageOutcomeV1[];
  requiresGeometryPages: number[];
  semanticDigest: string;
}

export interface PdfUntaggedPageOutcomeV1 {
  pageIndex: number;
  mode: "geometry-native" | "fallback-required";
  projectedNodeIds: string[];
  columnCount: number;
  sourceFragmentCount: number;
  suppressedFragmentCount: number;
  accountedCharacterCount: number;
  unaccountedCharacterCount: number;
  qualificationReasons: string[];
}

export interface PdfUntaggedSemanticsV1 {
  schema: typeof PDF_UNTAGGED_SEMANTICS_SCHEMA_V1;
  factsDigest: string;
  policyRevision: typeof PDF_GEOMETRY_POLICY_REVISION;
  document: ImportDocumentV2;
  evidence: PdfDecisionEvidenceV1[];
  pageOutcomes: PdfUntaggedPageOutcomeV1[];
  requiresFallbackPages: number[];
  semanticDigest: string;
}
