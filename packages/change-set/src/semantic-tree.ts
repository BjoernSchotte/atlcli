import type {
  CanonicalJsonObject,
  ChangeDiagnosticV1,
  ChangeSetV1,
  ChangeSubjectV1,
  SemanticPathV1,
  SnapshotRefV1,
} from "./types.js";

export interface IdentityHintV1 {
  kind: "local-id" | "unique-id" | "resource-id" | "media-id" | "node-id";
  value: string;
  /** Only stable hints may authorize a move, and only when unique on both sides. */
  stability: "stable" | "context";
  /** Source attribute that supplied the hint, when applicable. */
  attribute?: string;
  /** False for identity metadata that is not itself user-visible meaning. */
  semantic?: boolean;
}

export interface CanonicalMarkV1 {
  type: string;
  /** Exact canonical source attributes, including identity-only fields. */
  attributes: CanonicalJsonObject;
  /** Attributes visible to semantic comparison; absent means equal to `attributes`. */
  semanticAttributes?: CanonicalJsonObject;
  opaque: boolean;
}

/** Lossless canonical tree after a source adapter's explicit noise policy. */
export interface CanonicalSourceNodeV1 {
  kind: string;
  attributes: CanonicalJsonObject;
  text?: string;
  marks?: readonly CanonicalMarkV1[];
  children: readonly CanonicalSourceNodeV1[];
  sourcePath: SemanticPathV1;
  identityHints: readonly IdentityHintV1[];
}

/** User-facing alignment tree shared by ADF and Storage source adapters. */
export interface SemanticDocumentNodeV1 {
  kind: string;
  label?: string;
  attributes: CanonicalJsonObject;
  text?: string;
  children: readonly SemanticDocumentNodeV1[];
  sourcePaths: readonly SemanticPathV1[];
  identityHints: readonly IdentityHintV1[];
  coverage: "exact" | "projected" | "opaque";
}

export type SourceChangeKindV1 = "insert" | "delete" | "modify" | "move";

/** Exact canonical-source change used as the completeness oracle. */
export interface SourceChangeV1 {
  id: string;
  kind: SourceChangeKindV1;
  path: SemanticPathV1;
  fromPath?: SemanticPathV1;
  before?: CanonicalJsonObject;
  after?: CanonicalJsonObject;
  classification: "meaningful" | "policy-noise";
}

export interface SemanticTreeSnapshotV1 {
  ref: Omit<SnapshotRefV1, "digest">;
  sourceTree: CanonicalSourceNodeV1;
  semanticTree: SemanticDocumentNodeV1;
  /** Adapter diagnostics already translated to the shared vocabulary. */
  diagnostics?: readonly ChangeDiagnosticV1[];
}

/**
 * One bounded top-level projection unit. A source node can project to zero or
 * more semantic nodes because adapters may intentionally flatten transparent
 * source containers.
 */
export interface SemanticTreeShardV1 {
  /** Stable output ordinal; original source positions remain in sourcePath(s). */
  index: number;
  sourceTree: CanonicalSourceNodeV1;
  semanticNodes: readonly SemanticDocumentNodeV1[];
}

export type SemanticTreeShardVisitorV1 = (shard: SemanticTreeShardV1) => void;

/** Root metadata returned after all top-level shards were visited. */
export interface SemanticTreeShardVisitResultV1 {
  /** Canonical source root with an intentionally empty children array. */
  sourceRoot: CanonicalSourceNodeV1;
  /** Semantic root with an intentionally empty children array. */
  semanticRoot: SemanticDocumentNodeV1;
  shardCount: number;
  diagnostics: readonly ChangeDiagnosticV1[];
}

export interface SemanticDiffLimitsV1 {
  maxNodes: number;
  maxCandidateComparisons: number;
  maxOperations: number;
  maxDiagnostics: number;
}

export const DEFAULT_SEMANTIC_DIFF_LIMITS_V1:
Readonly<SemanticDiffLimitsV1> = Object.freeze({
  maxNodes: 100_000,
  maxCandidateComparisons: 1_000_000,
  maxOperations: 10_000,
  maxDiagnostics: 1_000,
});

export interface SemanticDiffInstrumentationV1 {
  sourceNodesVisited: number;
  semanticNodesVisited: number;
  candidateComparisons: number;
  stableIdMatches: number;
  exactSubtreeMatches: number;
  sequenceMatches: number;
  positionalMatches: number;
  ambiguousGroups: number;
}

export interface SemanticDiffInputV1 {
  subject: ChangeSubjectV1;
  baseline: SemanticTreeSnapshotV1;
  target: SemanticTreeSnapshotV1;
  limits?: Partial<SemanticDiffLimitsV1>;
}

export interface SemanticDiffResultV1 {
  changeSet: ChangeSetV1;
  sourceChanges: readonly SourceChangeV1[];
  instrumentation: SemanticDiffInstrumentationV1;
}
