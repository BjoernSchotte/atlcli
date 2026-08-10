/** JSON primitives accepted by the portable change contract. */
export type CanonicalJsonPrimitive = null | boolean | number | string;

/** A plain JSON object. Object keys are canonicalized during serialization. */
export interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}

/** JSON-only value accepted in bounded operation payloads. */
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | CanonicalJsonObject;

/** JSON-safe path segment. Numeric segments address ordered children. */
export type SemanticPathSegmentV1 = string | number;

/** Host-neutral semantic path from the compared resource root. */
export type SemanticPathV1 = readonly SemanticPathSegmentV1[];

export type ChangeProviderV1 = "confluence" | "jira";
export type ChangeSubjectKindV1 = "page" | "issue";

/** Provider and resource identity whose two snapshots are compared. */
export type ChangeSubjectV1 =
  | {
      provider: "confluence";
      kind: "page";
      id: string;
      label?: string;
    }
  | {
      provider: "jira";
      kind: "issue";
      id: string;
      label?: string;
    };

export type SnapshotRepresentationV1 =
  | "atlas_doc_format"
  | "storage"
  | "jira-fields";

export type SnapshotAcquisitionV1 =
  | "rest-v2"
  | "rest-v1"
  | "planned-operation"
  | "synthetic-fixture"
  | "local-file";

/** Version-bound identity and canonical-source digest for one comparison side. */
export interface SnapshotRefV1 {
  revision: string;
  digest: string;
  representation: SnapshotRepresentationV1;
  deployment?: "cloud" | "data-center";
  acquisition: SnapshotAcquisitionV1;
}

export type ChangeMatchBasisV1 =
  | "stable-id"
  | "exact-subtree"
  | "sequence"
  | "position"
  | "opaque";

export type ChangeConfidenceV1 =
  | "exact"
  | "anchored"
  | "conservative"
  | "ambiguous";

/** Review-oriented risk vocabulary; it does not authorize execution. */
export type ChangeRiskTagV1 =
  | "content-change"
  | "structure-change"
  | "identity-change"
  | "collection-change"
  | "workflow-transition"
  | "destructive"
  | "opaque"
  | "ambiguous";

/** Representation provenance for the values carried by one operation. */
export interface ChangeSourceProvenanceV1 {
  baseline: SnapshotRepresentationV1;
  target: SnapshotRepresentationV1;
}

export type ChangeDiagnosticCodeV1 =
  | "ambiguous-match"
  | "opaque-source-change"
  | "source-fallback"
  | "source-incomplete"
  | "limit-exceeded"
  | "policy-noise"
  | "unavailable-transition"
  | "missing-observed-value";

/** Bounded, typed diagnostic attached to completeness evidence. */
export interface ChangeDiagnosticV1 {
  code: ChangeDiagnosticCodeV1;
  severity: "info" | "warning" | "error";
  message: string;
  path?: SemanticPathV1;
  sourceChangeIds?: readonly string[];
}

export interface ChangeOperationBaseV1 {
  /** Lowercase SHA-256 over the operation identity envelope. */
  id: string;
  /** Destination/current path; for moves the original path is `fromPath`. */
  path: SemanticPathV1;
  matchBasis: ChangeMatchBasisV1;
  confidence: ChangeConfidenceV1;
  riskTags: readonly ChangeRiskTagV1[];
  source: ChangeSourceProvenanceV1;
  /** Exact-source changes accounted for by this semantic operation. */
  coveredSourceChangeIds: readonly string[];
}

export interface InsertOperationV1 extends ChangeOperationBaseV1 {
  kind: "insert";
  after: CanonicalJsonValue;
}

export interface DeleteOperationV1 extends ChangeOperationBaseV1 {
  kind: "delete";
  before: CanonicalJsonValue;
}

export interface ModifyOperationV1 extends ChangeOperationBaseV1 {
  kind: "modify";
  before: CanonicalJsonValue;
  after: CanonicalJsonValue;
}

export interface MoveOperationV1 extends ChangeOperationBaseV1 {
  kind: "move";
  fromPath: SemanticPathV1;
  value: CanonicalJsonValue;
}

export interface CollectionAddOperationV1 extends ChangeOperationBaseV1 {
  kind: "collection-add";
  item: CanonicalJsonValue;
}

export interface CollectionRemoveOperationV1 extends ChangeOperationBaseV1 {
  kind: "collection-remove";
  item: CanonicalJsonValue;
}

/** Stable provider entity identity; labels are presentation only. */
export interface ChangeEntityRefV1 {
  id: string;
  label?: string;
}

export interface TransitionOperationV1 extends ChangeOperationBaseV1 {
  kind: "transition";
  before: ChangeEntityRefV1;
  after: ChangeEntityRefV1;
}

export interface OpaqueChangeOperationV1 extends ChangeOperationBaseV1 {
  kind: "opaque-change";
  reason: string;
  before?: CanonicalJsonValue;
  after?: CanonicalJsonValue;
}

/** Owned operation contract; no third-party delta shape crosses this boundary. */
export type ChangeOperationV1 =
  | InsertOperationV1
  | DeleteOperationV1
  | ModifyOperationV1
  | MoveOperationV1
  | CollectionAddOperationV1
  | CollectionRemoveOperationV1
  | TransitionOperationV1
  | OpaqueChangeOperationV1;

/** Operation before its deterministic ID has been attached. */
export type ChangeOperationDraftV1 = ChangeOperationV1 extends infer Operation
  ? Operation extends ChangeOperationV1
    ? Omit<Operation, "id">
    : never
  : never;

export interface ChangeSummaryV1 {
  inserts: number;
  deletes: number;
  modifies: number;
  moves: number;
  opaque: number;
  noOp: boolean;
}

export interface ChangeLimitsV1 {
  truncated: boolean;
  emittedOperations: number;
  totalOperations?: number;
}

/** Portable, read-only comparison result. This is not an executable plan. */
export interface ChangeSetV1 {
  schema: "atlcli.change-set/1";
  subject: ChangeSubjectV1;
  baseline: SnapshotRefV1;
  target: SnapshotRefV1;
  completeness: {
    status: "complete" | "degraded";
    diagnostics: readonly ChangeDiagnosticV1[];
  };
  summary: ChangeSummaryV1;
  operations: readonly ChangeOperationV1[];
  limits: ChangeLimitsV1;
}
