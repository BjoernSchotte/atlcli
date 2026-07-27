import type {
  TemplateCapabilityCatalogV1,
  TemplateCapabilityPresentationRegistryV1,
} from "@atlcli/template-pack";

export const TEMPLATE_CANDIDATE_SCHEMA_V1 =
  "wiki.pdf-template-candidate/v1" as const;
export const TEMPLATE_DECISION_STATE_SCHEMA_V1 =
  "wiki.pdf-template-decisions/v1" as const;
export const AUTHORING_RESOLUTION_SCHEMA_V1 =
  "wiki.pdf-template-authoring-resolution/v1" as const;
export const TEMPLATE_IMPORT_VIEW_SCHEMA_V1 =
  "wiki.pdf-template-import-view/v1" as const;
export const TEMPLATE_IMPORT_PROGRESS_SCHEMA_V1 =
  "wiki.pdf-template-import-progress/v1" as const;
export const TEMPLATE_PROJECT_GENERATION_SCHEMA_V1 =
  "wiki.pdf-template-project-generation/v1" as const;

export type TemplateImportStageV1 =
  | "analyzing"
  | "review-required"
  | "ready-to-preview"
  | "ready-to-build"
  | "built"
  | "source-changed"
  | "blocked";

export type CandidateValueNatureV1 =
  | "source-explicit"
  | "source-derived"
  | "inferred";
export type CandidateConfidenceV1 =
  | "conclusive"
  | "corroborated"
  | "blocked";
export type CandidateCompatibilityV1 =
  | "native"
  | "needs-conversion"
  | "unsupported";
export type CandidateAdoptionV1 = "safe" | "review" | "blocked";
export type CandidateKindV1 = "token" | "font" | "asset";

export interface TemplateEvidenceV1 {
  id: string;
  partRef: string;
  locator: string;
  styleChain?: readonly string[];
  themeRef?: string;
  sectionIndex?: number;
}

export interface CandidateWriteV1 {
  target: string;
  value: unknown;
}

export interface TemplateCandidateV1 {
  schema: typeof TEMPLATE_CANDIDATE_SCHEMA_V1;
  /** Analysis-local handle. It is deliberately not a durable identity. */
  id: string;
  /** Business-facing concept label owned by an injected message registry. */
  conceptCode?: string;
  semanticKey: string;
  candidateFingerprint: string;
  sourceFingerprint: string;
  group: {
    id: string;
    cardinality: "zero-or-one" | "many";
    atomic: boolean;
  };
  writes: readonly CandidateWriteV1[];
  rank: number;
  kind: CandidateKindV1;
  valueNature: CandidateValueNatureV1;
  confidence: CandidateConfidenceV1;
  compatibility: CandidateCompatibilityV1;
  adoption: CandidateAdoptionV1;
  evidence: readonly TemplateEvidenceV1[];
  rule: { id: string; version: string };
  explanations: readonly TemplateExplanationV1[];
  diagnostics: readonly TemplateDiagnosticV1[];
  /** For asset placement: true means Word layout cannot be frozen safely. */
  layoutDependent?: boolean;
}

export type TemplateMessageParamTypeV1 = "boolean" | "number" | "string";
export type TemplateStringParamFormatV1 =
  | "fingerprint"
  | "safe-text"
  | "stable-id";

export interface TemplateMessageParamDefinitionV1 {
  type: TemplateMessageParamTypeV1;
  maxLength?: number;
  format?: TemplateStringParamFormatV1;
}

export interface TemplateMessageDefinitionV1 {
  code: string;
  params: Readonly<Record<string, TemplateMessageParamDefinitionV1>>;
}

export interface TemplateMessageRegistryV1 {
  schema: "wiki.pdf-template-message-registry/v1";
  id: string;
  version: number;
  definitions: readonly TemplateMessageDefinitionV1[];
}

export interface TemplateMessageV1 {
  code: string;
  params: Readonly<Record<string, string | number | boolean>>;
}

export interface TemplateDiagnosticV1 extends TemplateMessageV1 {
  severity: "info" | "warning" | "error";
  related?: {
    semanticKey?: string;
    sceneId?: string;
    target?: string;
  };
  recoveryActions: readonly TemplateImportActionKindV1[];
  technicalRef?: string;
}

export interface TemplateExplanationV1 extends TemplateMessageV1 {
  evidenceRefs: readonly string[];
}

export type TemplateDecisionStalenessV1 =
  | "current"
  | "candidate-changed"
  | "candidate-missing"
  | "mapping-changed"
  | "source-changed-same-value"
  | "catalog-migration-required";

export type TemplateDecisionOriginV1 =
  | { kind: "user" }
  | {
      kind: "policy";
      id: string;
      version: string;
      inputDigest: string;
    };

export interface AcceptedCandidateDecisionV1 {
  id: string;
  kind: "accept-candidate";
  semanticKey: string;
  candidateFingerprint: string;
  groupId: string;
  groupAtomic: boolean;
  rank: number;
  frozenWrites: readonly CandidateWriteV1[];
  sourceFingerprint: string;
  sourceDigest: string;
  catalogDigest: string;
  importerVersion: string;
  mappingVersion: string;
  decidedBy: TemplateDecisionOriginV1;
}

export interface BaselineTombstoneDecisionV1 {
  id: string;
  kind: "use-baseline";
  semanticKey: string | "*";
  scope:
    | { kind: "target"; target: string }
    | { kind: "group"; groupId: string };
}

export interface RejectedCandidateDecisionV1 {
  id: string;
  kind: "reject-candidate";
  semanticKey: string;
  candidateFingerprint: string;
  groupId: string;
}

export interface OverrideDecisionV1 {
  id: string;
  kind: "override";
  target: string;
  value: unknown;
}

export interface ClearedOptionalDecisionV1 {
  id: string;
  kind: "clear-optional";
  target: string;
}

export interface InventoryAcknowledgementV1 {
  id: string;
  kind: "acknowledge-inventory";
  analysisDigest: string;
  diagnosticCodes: readonly string[];
}

export interface AssetAccessibilityV1 {
  decorative: boolean;
  alt?: string;
}

export interface AssetRenderingDecisionV1 {
  kind: "slot-default" | "candidate-placement" | "custom-placement";
  placement?: Readonly<Record<string, unknown>>;
}

export interface AcceptedAssetDecisionV1 {
  id: string;
  kind: "accept-asset";
  semanticKey: string;
  candidateFingerprint: string;
  assetSha256: string;
  role: string;
  rightsConfirmed: true;
  accessibility: AssetAccessibilityV1;
  rendering: AssetRenderingDecisionV1;
}

export type TemplateDecisionV1 =
  | AcceptedCandidateDecisionV1
  | BaselineTombstoneDecisionV1
  | RejectedCandidateDecisionV1
  | OverrideDecisionV1
  | ClearedOptionalDecisionV1
  | InventoryAcknowledgementV1
  | AcceptedAssetDecisionV1;

export interface TemplatePreviewStateV1 {
  designReviewDigest?: string;
  compatibilityProofDigest?: string;
}

export interface TemplateDecisionStateV1 {
  schema: typeof TEMPLATE_DECISION_STATE_SCHEMA_V1;
  decisions: readonly TemplateDecisionV1[];
  preview: TemplatePreviewStateV1;
  builtFromDigest?: string;
}

export interface TemplateDecisionContextV1 {
  catalog: TemplateCapabilityCatalogV1;
  baseline: Readonly<Record<string, unknown>>;
  catalogDigest: string;
  sourceDigest: string;
  importerVersion: string;
  mappingVersion: string;
}

export type TemplateDecisionCommandV1 =
  | {
      kind: "accept-candidate";
      candidate: TemplateCandidateV1;
      decidedBy: TemplateDecisionOriginV1;
    }
  | {
      kind: "use-baseline";
      semanticKey: string | "*";
      scope: BaselineTombstoneDecisionV1["scope"];
    }
  | {
      kind: "reset-tombstone";
      semanticKey: string | "*";
      scope: BaselineTombstoneDecisionV1["scope"];
    }
  | { kind: "reject-candidate"; candidate: TemplateCandidateV1 }
  | { kind: "reset-rejection"; candidateFingerprint: string }
  | { kind: "override"; target: string; value: unknown }
  | { kind: "clear-override"; target: string }
  | { kind: "clear-optional"; target: string }
  | {
      kind: "acknowledge-inventory";
      analysisDigest: string;
      diagnosticCodes: readonly string[];
    }
  | {
      kind: "accept-asset";
      candidate: TemplateCandidateV1;
      assetSha256: string;
      role: string;
      rightsConfirmed: boolean;
      accessibility: AssetAccessibilityV1;
      rendering: AssetRenderingDecisionV1;
    }
  | { kind: "clear-asset"; semanticKey: string }
  | { kind: "mark-preview"; digest: string }
  | { kind: "invalidate-derived-artifacts" }
  | { kind: "mark-built"; digest: string }
  | { kind: "restore"; state: TemplateDecisionStateV1 };

export interface TemplateDecisionStalenessEntryV1 {
  decisionId: string;
  state: TemplateDecisionStalenessV1;
}

export interface AuthoringTraceEntryV1 {
  source: "baseline" | "candidate" | "policy" | "override";
  decisionId?: string;
}

export interface AuthoringResolutionSnapshotV1 {
  schema: typeof AUTHORING_RESOLUTION_SCHEMA_V1;
  catalog: { id: string; version: number; digest: string };
  baseline: { id: string; version: string; digest: string };
  sourceDigest: string;
  decisionDigest: string;
  snapshotDigest: string;
  design: Readonly<Record<string, unknown>>;
  assets: Readonly<Record<string, AcceptedAssetDecisionV1>>;
  staleness: readonly TemplateDecisionStalenessEntryV1[];
  trace: Readonly<Record<string, AuthoringTraceEntryV1>>;
}

export interface TemplateLayerDiffEntryV1 {
  target: string;
  baseline: unknown;
  effective: unknown;
  source: AuthoringTraceEntryV1["source"];
}

export interface TemplateAmbiguousConflictV1 {
  kind: "ambiguous-conflict";
  rank: number;
  target: string;
  decisionIds: readonly string[];
  values: readonly unknown[];
}

export type TemplateDisplayValueV1 =
  | {
      kind: "scalar";
      format:
        | "boolean"
        | "color"
        | "font"
        | "length"
        | "number"
        | "text";
      value: string | number | boolean | null;
      unitCode?: string;
    }
  | { kind: "choice"; valueCode: string }
  | {
      kind: "asset";
      assetId: string;
      mediaType: string;
      width?: number;
      height?: number;
      thumbnailRef?: string;
    }
  | { kind: "not-set" };

export type TemplateImportActionKindV1 =
  | "apply-ready"
  | "use-word-value"
  | "keep-current-design"
  | "customize"
  | "review-asset"
  | "keep-current-for-remaining"
  | "acknowledge-inventory"
  | "reanalyze"
  | "preview"
  | "build"
  | "undo";

export interface TemplateImportActionDescriptorV1 {
  id: string;
  kind: TemplateImportActionKindV1;
  enabled: boolean;
  confirmation: "none" | "summary" | "rights" | "accessibility";
  affectedItems: number;
  disabledReason?: TemplateDiagnosticV1;
}

export interface TemplateReviewItemV1 {
  id: string;
  semanticKey: string;
  labelCode: string;
  state: "ready" | "review" | "decided" | "cannot-transfer";
  baseline: TemplateDisplayValueV1;
  proposed?: TemplateDisplayValueV1;
  effective: TemplateDisplayValueV1;
  explanations: readonly TemplateExplanationV1[];
  diagnostics: readonly TemplateDiagnosticV1[];
  actions: readonly TemplateImportActionDescriptorV1[];
  details: {
    candidateIds: readonly string[];
    candidateFingerprints: readonly string[];
    targets: readonly string[];
  };
}

export interface TemplateReviewSectionV1 {
  id: string;
  itemCount: number;
  attentionCount: number;
  items: readonly TemplateReviewItemV1[];
}

export interface TemplateImportViewV1 {
  schema: typeof TEMPLATE_IMPORT_VIEW_SCHEMA_V1;
  generation: string;
  stage: TemplateImportStageV1;
  summary: {
    readyToApply: number;
    needsReview: number;
    cannotTransfer: number;
    blockers: number;
    unanswered: number;
  };
  sections: readonly TemplateReviewSectionV1[];
  diagnostics: readonly TemplateDiagnosticV1[];
  availableActions: readonly TemplateImportActionDescriptorV1[];
  nextActions: readonly string[];
  preview: {
    designReview: "missing" | "stale" | "ready";
    compatibilityProof: "missing" | "stale" | "ready";
  };
}

export interface TemplateImportProjectionInputV1 {
  generation: string;
  analysisDigest: string;
  baseline: Readonly<Record<string, unknown>>;
  candidates: readonly TemplateCandidateV1[];
  decisions: TemplateDecisionStateV1;
  snapshot: AuthoringResolutionSnapshotV1;
  catalog: TemplateCapabilityCatalogV1;
  presentation: TemplateCapabilityPresentationRegistryV1;
  messageRegistries?: readonly TemplateMessageRegistryV1[];
  diagnostics: readonly TemplateDiagnosticV1[];
  inventoryDiagnosticCodes: readonly string[];
  previewDigest: string;
  hasHistory: boolean;
  analyzing?: boolean;
}

export type TemplateImportActionV1 =
  | { id: string; kind: "apply-ready" }
  | { id: string; kind: "use-word-value"; candidateId: string }
  | {
      id: string;
      kind: "keep-current-design";
      semanticKey: string | "*";
      scope: BaselineTombstoneDecisionV1["scope"];
    }
  | { id: string; kind: "customize"; target: string; value: unknown }
  | {
      id: string;
      kind: "review-asset";
      candidateId: string;
      assetSha256: string;
      role: string;
      rightsConfirmed: boolean;
      accessibility: AssetAccessibilityV1;
      rendering: AssetRenderingDecisionV1;
    }
  | { id: string; kind: "keep-current-for-remaining" }
  | { id: string; kind: "acknowledge-inventory" }
  | { id: string; kind: "reanalyze" }
  | { id: string; kind: "preview" }
  | { id: string; kind: "build" }
  | { id: string; kind: "undo"; previousState: TemplateDecisionStateV1 };

export interface TemplateImportActionContextV1 {
  projection: TemplateImportProjectionInputV1;
  decisionContext: TemplateDecisionContextV1;
}

export interface TemplateImportProgressEventV1 {
  schema: typeof TEMPLATE_IMPORT_PROGRESS_SCHEMA_V1;
  operationId: string;
  phase:
    | "opening"
    | "scanning"
    | "resolving"
    | "matching"
    | "extracting-assets"
    | "rendering-preview"
    | "validating"
    | "packing";
  completed: number;
  total: number | null;
  detailCode?: string;
  detailParams?: Readonly<Record<string, string | number>>;
}

export interface TemplateProjectGenerationV1 {
  schema: typeof TEMPLATE_PROJECT_GENERATION_SCHEMA_V1;
  projectId: string;
  generation: string;
  parentGeneration: string | null;
  analysisDigest: string;
  decisions: TemplateDecisionStateV1;
  snapshotDigest?: string;
}

export interface TemplateProjectCommitV1 {
  projectId: string;
  expectedGeneration: string | null;
  analysisDigest: string;
  decisions: TemplateDecisionStateV1;
  snapshotDigest?: string;
}

export interface TemplateProjectHistoryItemV1 {
  generation: string;
  parentGeneration: string | null;
  analysisDigest: string;
}

export interface TemplateProjectUndoV1 {
  projectId: string;
  expectedGeneration: string;
  targetGeneration: string;
}

export interface TemplateProjectRepository {
  read(projectId: string): Promise<TemplateProjectGenerationV1>;
  commit(input: TemplateProjectCommitV1): Promise<TemplateProjectGenerationV1>;
  listHistory(projectId: string): Promise<readonly TemplateProjectHistoryItemV1[]>;
  undo(input: TemplateProjectUndoV1): Promise<TemplateProjectGenerationV1>;
}

export interface VerifiedAssetCandidateV1 {
  sha256: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface TemplateAssetHandleV1 {
  id: string;
  sha256: string;
  mediaType: string;
  byteLength: number;
}

export interface TemplateAssetStore {
  put(candidate: VerifiedAssetCandidateV1): Promise<TemplateAssetHandleV1>;
  get(handle: TemplateAssetHandleV1): Promise<Uint8Array>;
  verify(handle: TemplateAssetHandleV1): Promise<void>;
}

export interface TemplatePreviewRequestV1 {
  generation: string;
  snapshotDigest: string;
  purpose:
    | "asset-contact-sheet"
    | "compatibility-proof"
    | "design-review";
  /**
   * Exact journey counts projected by `TemplateImportViewV1`. A renderer may
   * display them but must not reinterpret or recompute them.
   */
  summary?: TemplateImportViewV1["summary"];
}

export interface TemplatePreviewRegionReferenceV1 {
  page: number;
  region:
    | "asset-grid"
    | "baseline"
    | "current"
    | "feature-zoo"
    | "summary";
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
    unit: "point";
  };
}

export interface TemplatePreviewResultV1 {
  digest: string;
  mediaType: "application/pdf";
  byteLength: number;
  pageCount: number;
  regions: readonly TemplatePreviewRegionReferenceV1[];
  /**
   * In-process hosts receive bytes. A persistent host may return an opaque
   * verified handle instead. Neither form exposes a file path or DOM node.
   */
  output:
    | { kind: "bytes"; bytes: Uint8Array }
    | { kind: "asset-handle"; handle: TemplateAssetHandleV1 };
}

export interface TemplatePreviewCompiler {
  render(input: TemplatePreviewRequestV1): Promise<TemplatePreviewResultV1>;
}

export interface TemplateRuntimeMaterializer {
  materialize(
    snapshot: AuthoringResolutionSnapshotV1
  ): Promise<Readonly<Record<string, unknown>>>;
}
