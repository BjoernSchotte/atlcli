/**
 * DOCX-independent PDF-template authoring core.
 *
 * Every operation consumes and returns portable data. This module intentionally
 * contains no filesystem, terminal, locale, browser-storage, or renderer code.
 */
import { sha256Hex } from "@atlcli/core";
import {
  canonicalCapabilityJson,
  flattenDesign,
  unflattenDesign,
  validateCompleteBaseline,
  validateDesignAgainstCatalog,
  type TemplateCapabilityDescriptorV1,
} from "@atlcli/template-pack";
import {
  AUTHORING_RESOLUTION_SCHEMA_V1,
  TEMPLATE_CANDIDATE_SCHEMA_V1,
  TEMPLATE_DECISION_STATE_SCHEMA_V1,
  TEMPLATE_IMPORT_VIEW_SCHEMA_V1,
  TEMPLATE_IMPORT_PROGRESS_SCHEMA_V1,
  type AcceptedCandidateDecisionV1,
  type AcceptedAssetDecisionV1,
  type AuthoringResolutionSnapshotV1,
  type AuthoringTraceEntryV1,
  type BaselineTombstoneDecisionV1,
  type CandidateWriteV1,
  type TemplateAmbiguousConflictV1,
  type TemplateCandidateV1,
  type TemplateDecisionCommandV1,
  type TemplateDecisionContextV1,
  type TemplateDecisionStalenessEntryV1,
  type TemplateDecisionStateV1,
  type TemplateDiagnosticV1,
  type TemplateDisplayValueV1,
  type TemplateExplanationV1,
  type TemplateImportActionContextV1,
  type TemplateImportActionDescriptorV1,
  type TemplateImportActionKindV1,
  type TemplateImportActionV1,
  type TemplateImportProjectionInputV1,
  type TemplateImportProgressEventV1,
  type TemplateImportViewV1,
  type TemplateLayerDiffEntryV1,
  type TemplateMessageDefinitionV1,
  type TemplateMessageRegistryV1,
  type TemplateMessageV1,
} from "./contracts.js";

const STABLE_ID_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,191}$/;
const STABLE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const MESSAGE_CODE_RE = /^[A-Z][A-Z0-9_]{2,127}$/;
const UNSAFE_MESSAGE_STRING_RE =
  /(?:[\u0000-\u001f\u007f]|\x1b|<\/?[A-Za-z]|(?:https?|file):\/\/|(?:^|[ ])(?:\/|[A-Za-z]:\\)|(?:^|[ ])\.\.[/\\])/;

export const ACCEPT_SAFE_POLICY_V1 = {
  id: "atlcli.accept-safe",
  version: "1",
} as const;
export const ACCEPT_RECOMMENDED_POLICY_V1 = {
  id: "atlcli.accept-recommended",
  version: "1",
} as const;

export const AUTHORING_MESSAGE_REGISTRY_V1: TemplateMessageRegistryV1 = {
  schema: "wiki.pdf-template-message-registry/v1",
  id: "atlcli.pdf-template-authoring",
  version: 1,
  definitions: [
    {
      code: "AUTHORING_ACTION_DISABLED",
      params: {
        action: { type: "string", maxLength: 64, format: "stable-id" },
      },
    },
    {
      code: "AUTHORING_AMBIGUOUS_CONFLICT",
      params: {
        target: { type: "string", maxLength: 192, format: "stable-id" },
      },
    },
    {
      code: "AUTHORING_PREVIEW_REQUIRED",
      params: {
        preview: { type: "string", maxLength: 64, format: "stable-id" },
      },
    },
    {
      code: "AUTHORING_REVIEW_REQUIRED",
      params: {
        count: { type: "number" },
      },
    },
    {
      code: "AUTHORING_SOURCE_CHANGED",
      params: {
        state: { type: "string", maxLength: 64, format: "stable-id" },
      },
    },
    {
      code: "AUTHORING_SOURCE_UNREADABLE",
      params: {
        technicalRef: { type: "string", maxLength: 96, format: "stable-id" },
      },
    },
    {
      code: "AUTHORING_UNSUPPORTED_INVENTORY",
      params: {
        count: { type: "number" },
      },
    },
  ],
};

export class TemplateAuthoringError extends Error {
  constructor(
    readonly code:
      | "action-disabled"
      | "asset-decision-invalid"
      | "candidate-invalid"
      | "decision-invalid"
      | "message-invalid",
    message: string
  ) {
    super(message);
    this.name = "TemplateAuthoringError";
  }
}

export class TemplateLayerConflictError extends Error {
  constructor(readonly conflicts: readonly TemplateAmbiguousConflictV1[]) {
    super("Authoring layers contain ambiguous equal-ranked writes");
    this.name = "TemplateLayerConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalClone<T>(value: T): T {
  if (value === undefined) return value;
  const json = canonicalCapabilityJson(value);
  if (json === undefined) {
    throw new TemplateAuthoringError("decision-invalid", "Value is not canonical JSON");
  }
  return JSON.parse(json) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function immutable<T>(value: T): T {
  return deepFreeze(canonicalClone(value));
}

async function digest(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalCapabilityJson(value)));
}

function assertStableId(value: string, field: string): void {
  if (!STABLE_ID_RE.test(value)) {
    throw new TemplateAuthoringError(
      "candidate-invalid",
      `${field} must be a stable identifier`
    );
  }
}

function canonicalWrites(
  writes: readonly CandidateWriteV1[],
  allowEmpty = false
): CandidateWriteV1[] {
  const targets = new Set<string>();
  const sorted = [...writes]
    .map((write) => canonicalClone(write))
    .sort((left, right) => left.target.localeCompare(right.target));
  if (sorted.length === 0 && !allowEmpty) {
    throw new TemplateAuthoringError("candidate-invalid", "Candidate must write at least one target");
  }
  for (const write of sorted) {
    assertStableId(write.target, "candidate target");
    if (targets.has(write.target)) {
      throw new TemplateAuthoringError(
        "candidate-invalid",
        `Candidate writes ${write.target} more than once`
      );
    }
    targets.add(write.target);
  }
  return sorted;
}

export interface CreateTemplateCandidateInputV1
  extends Omit<
    TemplateCandidateV1,
    | "candidateFingerprint"
    | "id"
    | "schema"
    | "sourceFingerprint"
    | "writes"
  > {
  analysisDigest: string;
  ordinal: number;
  writes: readonly CandidateWriteV1[];
}

/**
 * Derive the analysis-local ID, durable semantic key, source fingerprint, and
 * candidate fingerprint from deliberately separate canonical inputs.
 */
export async function createTemplateCandidate(
  input: CreateTemplateCandidateInputV1
): Promise<TemplateCandidateV1> {
  assertStableId(input.semanticKey, "semanticKey");
  assertStableId(input.group.id, "group.id");
  assertStableId(input.rule.id, "rule.id");
  if (
    input.conceptCode !== undefined &&
    !MESSAGE_CODE_RE.test(input.conceptCode)
  ) {
    throw new TemplateAuthoringError(
      "candidate-invalid",
      "conceptCode must be a stable message code"
    );
  }
  if (!STABLE_VERSION_RE.test(input.rule.version)) {
    throw new TemplateAuthoringError(
      "candidate-invalid",
      "rule.version must be a stable version"
    );
  }
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
    throw new TemplateAuthoringError("candidate-invalid", "ordinal must be non-negative");
  }
  if (!Number.isFinite(input.rank)) {
    throw new TemplateAuthoringError("candidate-invalid", "rank must be finite");
  }
  const writes = canonicalWrites(input.writes, input.kind === "asset");
  const evidenceLocator = input.evidence
    .map(({ partRef, locator, sectionIndex, styleChain, themeRef }) => ({
      partRef,
      locator,
      ...(sectionIndex === undefined ? {} : { sectionIndex }),
      ...(styleChain === undefined ? {} : { styleChain: [...styleChain] }),
      ...(themeRef === undefined ? {} : { themeRef }),
    }))
    .sort((left, right) =>
      canonicalCapabilityJson(left).localeCompare(canonicalCapabilityJson(right))
    );
  const sourceFingerprint = await digest({
    analysisDigest: input.analysisDigest,
    evidenceLocator,
  });
  const candidateFingerprint = await digest({
    rule: input.rule,
    evidenceLocator,
    writes,
  });
  const idDigest = await digest({
    analysisDigest: input.analysisDigest,
    ordinal: input.ordinal,
  });
  return immutable({
    ...input,
    schema: TEMPLATE_CANDIDATE_SCHEMA_V1,
    id: `candidate:${idDigest.slice(0, 24)}`,
    writes,
    sourceFingerprint,
    candidateFingerprint,
  });
}

export async function deriveSemanticReconciliationKey(input: {
  ruleId: string;
  concept: string;
  scope: string;
}): Promise<string> {
  assertStableId(input.ruleId, "ruleId");
  assertStableId(input.concept, "concept");
  assertStableId(input.scope, "scope");
  const value = await digest(input);
  return `semantic:${value}`;
}

export function createTemplateDecisionState(): TemplateDecisionStateV1 {
  return immutable({
    schema: TEMPLATE_DECISION_STATE_SCHEMA_V1,
    decisions: [],
    preview: {},
  });
}

/** Product-vocabulary alias used by hosts when starting a new layer draft. */
export const createLayerState = createTemplateDecisionState;

function descriptorFor(
  context: TemplateDecisionContextV1,
  target: string
): TemplateCapabilityDescriptorV1 {
  const descriptor = context.catalog.descriptors.find((item) => item.path === target);
  if (!descriptor) {
    throw new TemplateAuthoringError(
      "decision-invalid",
      `Unknown authoring capability: ${target}`
    );
  }
  return descriptor;
}

function validateWrites(
  context: TemplateDecisionContextV1,
  writes: readonly CandidateWriteV1[]
): CandidateWriteV1[] {
  const normalized = canonicalWrites(writes);
  const flat = { ...flattenDesign(context.baseline) };
  for (const write of normalized) {
    descriptorFor(context, write.target);
    flat[write.target] = canonicalClone(write.value);
  }
  validateCompleteBaseline(unflattenDesign(flat), context.catalog);
  return normalized;
}

function scopeMatchesCandidate(
  scope: BaselineTombstoneDecisionV1["scope"],
  candidate: TemplateCandidateV1 | AcceptedCandidateDecisionV1
): boolean {
  if (scope.kind === "group") {
    const groupId =
      "groupId" in candidate ? candidate.groupId : candidate.group.id;
    return scope.groupId === groupId;
  }
  const writes =
    "frozenWrites" in candidate ? candidate.frozenWrites : candidate.writes;
  return writes.some(({ target }) => target === scope.target);
}

function sameScope(
  left: BaselineTombstoneDecisionV1["scope"],
  right: BaselineTombstoneDecisionV1["scope"]
): boolean {
  return left.kind === right.kind &&
    (left.kind === "group"
      ? left.groupId === (right as { kind: "group"; groupId: string }).groupId
      : left.target === (right as { kind: "target"; target: string }).target);
}

function candidateIsTombstoned(
  decisions: readonly import("./contracts.js").TemplateDecisionV1[],
  candidate: TemplateCandidateV1
): boolean {
  return decisions.some(
    (decision) =>
      decision.kind === "use-baseline" &&
      (decision.semanticKey === "*" ||
        decision.semanticKey === candidate.semanticKey) &&
      scopeMatchesCandidate(decision.scope, candidate)
  );
}

function candidateIsRejected(
  decisions: readonly import("./contracts.js").TemplateDecisionV1[],
  candidate: TemplateCandidateV1
): boolean {
  return decisions.some(
    (decision) =>
      decision.kind === "reject-candidate" &&
      decision.candidateFingerprint === candidate.candidateFingerprint
  );
}

function upsertBy<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
  value: T
): T[] {
  return [...values.filter((candidate) => !predicate(candidate)), value];
}

/**
 * The only reducer that may create a changed decision state.
 *
 * Commands are validated against the active catalog and baseline before a new
 * immutable state is returned. A thrown command leaves the input untouched.
 */
export function reduceTemplateDecision(
  state: TemplateDecisionStateV1,
  command: TemplateDecisionCommandV1,
  context: TemplateDecisionContextV1
): TemplateDecisionStateV1 {
  const decisions = [...state.decisions];
  let nextDecisions = decisions;
  let preview = state.preview;
  let builtFromDigest = state.builtFromDigest;

  switch (command.kind) {
    case "accept-candidate": {
      if (
        command.decidedBy.kind === "policy" &&
        candidateIsTombstoned(decisions, command.candidate)
      ) {
        throw new TemplateAuthoringError(
          "decision-invalid",
          "A policy cannot accept a tombstoned candidate"
        );
      }
      const frozenWrites = validateWrites(context, command.candidate.writes);
      const decision: AcceptedCandidateDecisionV1 = {
        id: `accept:${command.candidate.candidateFingerprint}`,
        kind: "accept-candidate",
        semanticKey: command.candidate.semanticKey,
        candidateFingerprint: command.candidate.candidateFingerprint,
        groupId: command.candidate.group.id,
        groupAtomic: command.candidate.group.atomic,
        rank: command.candidate.rank,
        frozenWrites,
        sourceFingerprint: command.candidate.sourceFingerprint,
        sourceDigest: context.sourceDigest,
        catalogDigest: context.catalogDigest,
        importerVersion: context.importerVersion,
        mappingVersion: context.mappingVersion,
        decidedBy: canonicalClone(command.decidedBy),
      };
      nextDecisions = decisions.filter((entry) => {
        if (
          entry.kind === "accept-candidate" &&
          entry.semanticKey === decision.semanticKey
        ) {
          return false;
        }
        if (
          command.decidedBy.kind === "user" &&
          entry.kind === "use-baseline" &&
          (entry.semanticKey === "*" ||
            entry.semanticKey === decision.semanticKey) &&
          scopeMatchesCandidate(entry.scope, decision)
        ) {
          return false;
        }
        if (
          entry.kind === "reject-candidate" &&
          entry.candidateFingerprint === decision.candidateFingerprint
        ) {
          return false;
        }
        return true;
      });
      nextDecisions.push(decision);
      break;
    }
    case "use-baseline": {
      if (command.semanticKey !== "*") {
        assertStableId(command.semanticKey, "semanticKey");
      }
      if (command.scope.kind === "target") descriptorFor(context, command.scope.target);
      else assertStableId(command.scope.groupId, "groupId");
      const decision: BaselineTombstoneDecisionV1 = {
        id: `baseline:${command.scope.kind}:${
          command.scope.kind === "target"
            ? command.scope.target
            : command.scope.groupId
        }:${command.semanticKey}`,
        kind: "use-baseline",
        semanticKey: command.semanticKey,
        scope: canonicalClone(command.scope),
      };
      nextDecisions = decisions.filter((entry) => {
        if (
          entry.kind === "use-baseline" &&
          entry.semanticKey === decision.semanticKey &&
          sameScope(entry.scope, decision.scope)
        ) {
          return false;
        }
        return !(
          entry.kind === "accept-candidate" &&
          (decision.semanticKey === "*" ||
            decision.semanticKey === entry.semanticKey) &&
          scopeMatchesCandidate(decision.scope, entry)
        );
      });
      nextDecisions.push(decision);
      break;
    }
    case "reset-tombstone":
      nextDecisions = decisions.filter(
        (entry) =>
          !(
            entry.kind === "use-baseline" &&
            entry.semanticKey === command.semanticKey &&
            sameScope(entry.scope, command.scope)
          )
      );
      break;
    case "reject-candidate": {
      const decision = {
        id: `reject:${command.candidate.candidateFingerprint}`,
        kind: "reject-candidate" as const,
        semanticKey: command.candidate.semanticKey,
        candidateFingerprint: command.candidate.candidateFingerprint,
        groupId: command.candidate.group.id,
      };
      nextDecisions = upsertBy(
        decisions,
        (entry) =>
          entry.kind === "reject-candidate" &&
          entry.candidateFingerprint === decision.candidateFingerprint,
        decision
      ).filter(
        (entry) =>
          !(
            entry.kind === "accept-candidate" &&
            entry.candidateFingerprint === decision.candidateFingerprint
          )
      );
      break;
    }
    case "reset-rejection":
      nextDecisions = decisions.filter(
        (entry) =>
          !(
            entry.kind === "reject-candidate" &&
            entry.candidateFingerprint === command.candidateFingerprint
          )
      );
      break;
    case "override": {
      descriptorFor(context, command.target);
      validateWrites(context, [{ target: command.target, value: command.value }]);
      const decision = {
        id: `override:${command.target}`,
        kind: "override" as const,
        target: command.target,
        value: canonicalClone(command.value),
      };
      nextDecisions = upsertBy(
        decisions,
        (entry) => entry.kind === "override" && entry.target === command.target,
        decision
      );
      break;
    }
    case "clear-override":
      nextDecisions = decisions.filter(
        (entry) => !(entry.kind === "override" && entry.target === command.target)
      );
      break;
    case "clear-optional": {
      const descriptor = descriptorFor(context, command.target);
      if (descriptor.required) {
        throw new TemplateAuthoringError(
          "decision-invalid",
          `${command.target} is required and cannot be cleared`
        );
      }
      nextDecisions = upsertBy(
        decisions,
        (entry) =>
          entry.kind === "clear-optional" && entry.target === command.target,
        {
          id: `clear:${command.target}`,
          kind: "clear-optional" as const,
          target: command.target,
        }
      );
      break;
    }
    case "acknowledge-inventory": {
      if (!FINGERPRINT_RE.test(command.analysisDigest)) {
        throw new TemplateAuthoringError(
          "decision-invalid",
          "Inventory acknowledgement requires an analysis digest"
        );
      }
      const diagnosticCodes = [...new Set(command.diagnosticCodes)].sort();
      if (diagnosticCodes.some((code) => !MESSAGE_CODE_RE.test(code))) {
        throw new TemplateAuthoringError(
          "decision-invalid",
          "Inventory acknowledgement contains an invalid code"
        );
      }
      nextDecisions = upsertBy(
        decisions,
        (entry) => entry.kind === "acknowledge-inventory",
        {
          id: `inventory:${command.analysisDigest}`,
          kind: "acknowledge-inventory" as const,
          analysisDigest: command.analysisDigest,
          diagnosticCodes,
        }
      );
      break;
    }
    case "accept-asset": {
      if (
        command.candidate.kind !== "asset" ||
        !command.useConfirmed ||
        !command.rightsConfirmed ||
        !command.role ||
        !FINGERPRINT_RE.test(command.assetSha256)
      ) {
        throw new TemplateAuthoringError(
          "asset-decision-invalid",
          "Asset acceptance requires an asset, role, digest, and rights confirmation"
        );
      }
      if (
        command.accessibility.decorative === false &&
        (!command.accessibility.alt ||
          command.accessibility.alt.trim().length === 0 ||
          command.accessibility.alt.length > 500)
      ) {
        throw new TemplateAuthoringError(
          "asset-decision-invalid",
          "A non-decorative asset requires bounded alternative text"
        );
      }
      if (
        command.rendering.kind === "candidate-placement" &&
        command.candidate.layoutDependent
      ) {
        throw new TemplateAuthoringError(
          "asset-decision-invalid",
          "A layout-dependent scene cannot freeze candidate placement"
        );
      }
      if (
        command.rendering.kind !== "slot-default" &&
        !isRecord(command.rendering.placement)
      ) {
        throw new TemplateAuthoringError(
          "asset-decision-invalid",
          "A non-default asset rendering requires a placement"
        );
      }
      nextDecisions = upsertBy(
        decisions,
        (entry) =>
          entry.kind === "accept-asset" &&
          entry.semanticKey === command.candidate.semanticKey,
        {
          id: `asset:${command.candidate.semanticKey}`,
          kind: "accept-asset" as const,
          semanticKey: command.candidate.semanticKey,
          candidateFingerprint: command.candidate.candidateFingerprint,
          sourceFingerprint: command.candidate.sourceFingerprint,
          sourceDigest: context.sourceDigest,
          catalogDigest: context.catalogDigest,
          importerVersion: context.importerVersion,
          mappingVersion: context.mappingVersion,
          assetSha256: command.assetSha256,
          role: command.role,
          useConfirmed: true as const,
          rightsConfirmed: true as const,
          accessibility: canonicalClone(command.accessibility),
          rendering: canonicalClone(command.rendering),
        }
      );
      break;
    }
    case "clear-asset":
      nextDecisions = decisions.filter(
        (entry) =>
          !(entry.kind === "accept-asset" && entry.semanticKey === command.semanticKey)
      );
      break;
    case "mark-preview":
      preview = {
        designReviewDigest: command.digest,
        compatibilityProofDigest: command.digest,
      };
      break;
    case "invalidate-derived-artifacts":
      preview = {};
      builtFromDigest = undefined;
      break;
    case "mark-built":
      builtFromDigest = command.digest;
      break;
    case "restore":
      return immutable(command.state);
  }

  const result: TemplateDecisionStateV1 = {
    schema: TEMPLATE_DECISION_STATE_SCHEMA_V1,
    decisions: nextDecisions.sort((left, right) => left.id.localeCompare(right.id)),
    preview: canonicalClone(preview),
    ...(builtFromDigest === undefined ? {} : { builtFromDigest }),
  };
  return immutable(result);
}

function candidateConflictKeys(candidate: TemplateCandidateV1): string[] {
  return candidate.writes.map((write) => `${candidate.rank}:${write.target}`);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return canonicalCapabilityJson(left) === canonicalCapabilityJson(right);
}

function ambiguousCandidates(
  candidates: readonly TemplateCandidateV1[]
): Set<string> {
  const byKey = new Map<string, TemplateCandidateV1[]>();
  for (const candidate of candidates) {
    for (const key of candidateConflictKeys(candidate)) {
      const bucket = byKey.get(key) ?? [];
      bucket.push(candidate);
      byKey.set(key, bucket);
    }
  }
  const ambiguous = new Set<string>();
  for (const bucket of byKey.values()) {
    for (const left of bucket) {
      for (const right of bucket) {
        if (
          left.id !== right.id &&
          left.writes.some((leftWrite) =>
            right.writes.some(
              (rightWrite) =>
                leftWrite.target === rightWrite.target &&
                !valuesEqual(leftWrite.value, rightWrite.value)
            )
          )
        ) {
          ambiguous.add(left.id);
          ambiguous.add(right.id);
        }
      }
    }
  }
  return ambiguous;
}

function candidateTypeValid(
  candidate: TemplateCandidateV1,
  context: TemplateDecisionContextV1
): boolean {
  try {
    validateWrites(context, candidate.writes);
    return true;
  } catch {
    return false;
  }
}

function policyBaseEligible(
  candidate: TemplateCandidateV1,
  state: TemplateDecisionStateV1,
  context: TemplateDecisionContextV1
): boolean {
  if (
    candidate.kind !== "token" ||
    candidate.compatibility !== "native" ||
    candidate.confidence === "blocked" ||
    candidate.adoption === "blocked" ||
    candidateIsTombstoned(state.decisions, candidate) ||
    candidateIsRejected(state.decisions, candidate) ||
    !candidateTypeValid(candidate, context)
  ) {
    return false;
  }
  const supportedNature =
    candidate.valueNature === "source-explicit" ||
    candidate.valueNature === "source-derived";
  return supportedNature;
}

function policyEligible(
  candidate: TemplateCandidateV1,
  state: TemplateDecisionStateV1,
  context: TemplateDecisionContextV1,
  ambiguous: ReadonlySet<string>,
  policy: "recommended" | "safe"
): boolean {
  if (
    !policyBaseEligible(candidate, state, context) ||
    ambiguous.has(candidate.id)
  ) {
    return false;
  }
  if (candidate.confidence === "conclusive") return true;
  return policy === "recommended" && candidate.confidence === "corroborated";
}

async function acceptPolicyCandidates(
  state: TemplateDecisionStateV1,
  candidates: readonly TemplateCandidateV1[],
  context: TemplateDecisionContextV1,
  policy: "recommended" | "safe"
): Promise<TemplateDecisionStateV1> {
  const sorted = [...candidates].sort((left, right) =>
    left.candidateFingerprint.localeCompare(right.candidateFingerprint)
  );
  const ambiguous = ambiguousCandidates(
    sorted.filter((candidate) =>
      policyBaseEligible(candidate, state, context)
    )
  );
  const policyDefinition =
    policy === "safe" ? ACCEPT_SAFE_POLICY_V1 : ACCEPT_RECOMMENDED_POLICY_V1;
  const inputDigest = await digest({
    policy: policyDefinition,
    candidates: sorted.map(
      ({
        candidateFingerprint,
        compatibility,
        confidence,
        kind,
        valueNature,
        adoption,
      }) => ({
        candidateFingerprint,
        compatibility,
        confidence,
        kind,
        valueNature,
        adoption,
      })
    ),
    decisionDigest: await digest(state.decisions),
    catalogDigest: context.catalogDigest,
  });
  const eligible = sorted.filter((candidate) =>
    policyEligible(candidate, state, context, ambiguous, policy)
  );
  const selectedBySemantic = new Map<string, TemplateCandidateV1>();
  for (const candidate of eligible) {
    const selected = selectedBySemantic.get(candidate.semanticKey);
    if (
      !selected ||
      candidate.rank > selected.rank ||
      (candidate.rank === selected.rank &&
        candidate.candidateFingerprint < selected.candidateFingerprint)
    ) {
      selectedBySemantic.set(candidate.semanticKey, candidate);
    }
  }
  let next = state;
  for (const candidate of [...selectedBySemantic.values()].sort((left, right) =>
    left.candidateFingerprint.localeCompare(right.candidateFingerprint)
  )) {
    next = reduceTemplateDecision(
      next,
      {
        kind: "accept-candidate",
        candidate,
        decidedBy: {
          kind: "policy",
          id: policyDefinition.id,
          version: policyDefinition.version,
          inputDigest,
        },
      },
      context
    );
  }
  return next;
}

export function deriveSafeCandidates(
  state: TemplateDecisionStateV1,
  candidates: readonly TemplateCandidateV1[],
  context: TemplateDecisionContextV1
): readonly TemplateCandidateV1[] {
  const ambiguous = ambiguousCandidates(
    candidates.filter((candidate) =>
      policyBaseEligible(candidate, state, context)
    )
  );
  return [...candidates]
    .filter((candidate) =>
      policyEligible(candidate, state, context, ambiguous, "safe")
    )
    .sort((left, right) =>
      left.candidateFingerprint.localeCompare(right.candidateFingerprint)
    );
}

export function deriveRecommendedCandidates(
  state: TemplateDecisionStateV1,
  candidates: readonly TemplateCandidateV1[],
  context: TemplateDecisionContextV1
): readonly TemplateCandidateV1[] {
  const ambiguous = ambiguousCandidates(
    candidates.filter((candidate) =>
      policyBaseEligible(candidate, state, context)
    )
  );
  return [...candidates]
    .filter((candidate) =>
      policyEligible(candidate, state, context, ambiguous, "recommended")
    )
    .sort((left, right) =>
      left.candidateFingerprint.localeCompare(right.candidateFingerprint)
    );
}

export function analyzeCandidatesAgainstCatalog(
  state: TemplateDecisionStateV1,
  candidates: readonly TemplateCandidateV1[],
  context: TemplateDecisionContextV1
): {
  valid: readonly TemplateCandidateV1[];
  invalidCandidateIds: readonly string[];
  ambiguousCandidateIds: readonly string[];
  safeCandidateIds: readonly string[];
  recommendedCandidateIds: readonly string[];
} {
  const sorted = [...candidates].sort((left, right) =>
    left.candidateFingerprint.localeCompare(right.candidateFingerprint)
  );
  const valid = sorted.filter((candidate) =>
    candidateTypeValid(candidate, context)
  );
  const ambiguity = ambiguousCandidates(
    valid.filter((candidate) =>
      policyBaseEligible(candidate, state, context)
    )
  );
  return immutable({
    valid,
    invalidCandidateIds: sorted
      .filter((candidate) => !candidateTypeValid(candidate, context))
      .map(({ id }) => id),
    ambiguousCandidateIds: [...ambiguity].sort(),
    safeCandidateIds: deriveSafeCandidates(state, sorted, context).map(
      ({ id }) => id
    ),
    recommendedCandidateIds: deriveRecommendedCandidates(
      state,
      sorted,
      context
    ).map(({ id }) => id),
  });
}

export function acceptSafeCandidates(
  state: TemplateDecisionStateV1,
  candidates: readonly TemplateCandidateV1[],
  context: TemplateDecisionContextV1
): Promise<TemplateDecisionStateV1> {
  return acceptPolicyCandidates(state, candidates, context, "safe");
}

export function acceptRecommendedCandidates(
  state: TemplateDecisionStateV1,
  candidates: readonly TemplateCandidateV1[],
  context: TemplateDecisionContextV1
): Promise<TemplateDecisionStateV1> {
  return acceptPolicyCandidates(state, candidates, context, "recommended");
}

function acceptedWriteConflicts(
  accepted: readonly AcceptedCandidateDecisionV1[]
): TemplateAmbiguousConflictV1[] {
  const byTarget = new Map<string, { decision: AcceptedCandidateDecisionV1; value: unknown }[]>();
  for (const decision of accepted) {
    for (const write of decision.frozenWrites) {
      const bucket = byTarget.get(write.target) ?? [];
      bucket.push({ decision, value: write.value });
      byTarget.set(write.target, bucket);
    }
  }
  const conflicts: TemplateAmbiguousConflictV1[] = [];
  for (const [target, entries] of byTarget) {
    const maxRank = Math.max(...entries.map(({ decision }) => decision.rank));
    const top = entries.filter(({ decision }) => decision.rank === maxRank);
    const values = new Map(
      top.map(({ value }) => [canonicalCapabilityJson(value), value])
    );
    if (values.size > 1) {
      conflicts.push({
        kind: "ambiguous-conflict",
        rank: maxRank,
        target,
        decisionIds: top.map(({ decision }) => decision.id).sort(),
        values: [...values.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, value]) => value),
      });
    }
  }
  return conflicts.sort((left, right) => left.target.localeCompare(right.target));
}

export interface ResolveTemplateLayersInputV1 {
  catalog: TemplateDecisionContextV1["catalog"];
  catalogDigest: string;
  baseline: {
    id: string;
    version: string;
    design: Readonly<Record<string, unknown>>;
  };
  sourceDigest: string;
  decisions: TemplateDecisionStateV1;
  candidates?: readonly TemplateCandidateV1[];
  mappingVersion?: string;
}

/**
 * Resolve explicit layers. Candidate rank is a declared rule priority; equal
 * rank with unequal values is an error, never input-order or last-write-wins.
 */
export async function resolveTemplateLayers(
  input: ResolveTemplateLayersInputV1
): Promise<AuthoringResolutionSnapshotV1> {
  const baseline = validateCompleteBaseline(input.baseline.design, input.catalog);
  const baselineFlat = flattenDesign(baseline);
  const flat: Record<string, unknown> = { ...baselineFlat };
  const trace: Record<string, AuthoringTraceEntryV1> = Object.fromEntries(
    Object.keys(baselineFlat)
      .sort()
      .map((target) => [target, { source: "baseline" as const }])
  );
  const accepted = input.decisions.decisions.filter(
    (decision): decision is AcceptedCandidateDecisionV1 =>
      decision.kind === "accept-candidate"
  );
  const conflicts = acceptedWriteConflicts(accepted);
  if (conflicts.length > 0) throw new TemplateLayerConflictError(conflicts);

  const winners = new Map<
    string,
    { decision: AcceptedCandidateDecisionV1; value: unknown }
  >();
  for (const decision of [...accepted].sort((left, right) =>
    left.id.localeCompare(right.id)
  )) {
    for (const write of decision.frozenWrites) {
      const existing = winners.get(write.target);
      if (!existing || decision.rank > existing.decision.rank) {
        winners.set(write.target, { decision, value: write.value });
      }
    }
  }
  for (const [target, { decision, value }] of [...winners].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    flat[target] = canonicalClone(value);
    trace[target] = {
      source: decision.decidedBy.kind === "policy" ? "policy" : "candidate",
      decisionId: decision.id,
    };
  }
  for (const decision of input.decisions.decisions) {
    if (decision.kind === "clear-optional") {
      delete flat[decision.target];
      delete trace[decision.target];
    }
  }
  for (const decision of input.decisions.decisions) {
    if (decision.kind !== "override") continue;
    flat[decision.target] = canonicalClone(decision.value);
    trace[decision.target] = { source: "override", decisionId: decision.id };
  }

  const design = unflattenDesign(flat);
  const validation = validateDesignAgainstCatalog(design, input.catalog, "authoring");
  if (validation.missingCapabilities.length > 0) {
    throw new TemplateAuthoringError(
      "decision-invalid",
      `Resolution is missing ${validation.missingCapabilities[0]}`
    );
  }
  const assets = Object.fromEntries(
    input.decisions.decisions
      .filter((decision) => decision.kind === "accept-asset")
      .sort((left, right) => left.role.localeCompare(right.role))
      .map((decision) => [decision.role, canonicalClone(decision)])
  );
  const baselineDigest = await digest(baseline);
  // Preview/build markers are derived artifacts, not authoring decisions. If
  // they participated here, marking a preview would change the digest it is
  // meant to attest and make freshness self-invalidating.
  const decisionDigest = await digest(input.decisions.decisions);
  const staleness = input.candidates
    ? reconcileTemplateDecisions(input.decisions, {
        candidates: input.candidates,
        sourceDigest: input.sourceDigest,
        mappingVersion: input.mappingVersion ?? "",
        catalogDigest: input.catalogDigest,
      }).staleness
    : accepted.map((decision) => ({
        decisionId: decision.id,
        state: "current" as const,
      }));
  const withoutDigest = {
    schema: AUTHORING_RESOLUTION_SCHEMA_V1,
    catalog: {
      id: input.catalog.id,
      version: input.catalog.version,
      digest: input.catalogDigest,
    },
    baseline: {
      id: input.baseline.id,
      version: input.baseline.version,
      digest: baselineDigest,
    },
    sourceDigest: input.sourceDigest,
    decisionDigest,
    design,
    assets,
    staleness,
    trace,
  };
  return immutable({
    ...withoutDigest,
    snapshotDigest: await digest(withoutDigest),
  });
}

export function diffTemplateLayers(
  baseline: Readonly<Record<string, unknown>>,
  snapshot: AuthoringResolutionSnapshotV1
): readonly TemplateLayerDiffEntryV1[] {
  const baselineFlat = flattenDesign(baseline);
  const effectiveFlat = flattenDesign(snapshot.design);
  return Object.keys({ ...baselineFlat, ...effectiveFlat })
    .sort()
    .filter((target) => !valuesEqual(baselineFlat[target], effectiveFlat[target]))
    .map((target) => ({
      target,
      baseline: canonicalClone(baselineFlat[target]),
      effective: canonicalClone(effectiveFlat[target]),
      source: snapshot.trace[target]?.source ?? "baseline",
    }));
}

export interface ReconcileTemplateDecisionsInputV1 {
  candidates: readonly TemplateCandidateV1[];
  sourceDigest: string;
  mappingVersion: string;
  catalogDigest: string;
}

/**
 * Reconcile identities only. Frozen writes are returned byte-for-byte and are
 * never replaced by a newer candidate value.
 */
export function reconcileTemplateDecisions(
  state: TemplateDecisionStateV1,
  input: ReconcileTemplateDecisionsInputV1
): {
  decisions: TemplateDecisionStateV1;
  staleness: readonly TemplateDecisionStalenessEntryV1[];
} {
  const staleness = state.decisions
    .filter(
      (
        decision
      ): decision is AcceptedCandidateDecisionV1 | AcceptedAssetDecisionV1 =>
        decision.kind === "accept-candidate" ||
        decision.kind === "accept-asset"
    )
    .map((decision): TemplateDecisionStalenessEntryV1 => {
      if (decision.catalogDigest !== input.catalogDigest) {
        return { decisionId: decision.id, state: "catalog-migration-required" };
      }
      if (decision.mappingVersion !== input.mappingVersion) {
        return { decisionId: decision.id, state: "mapping-changed" };
      }
      const sortedCandidates = [...input.candidates].sort((left, right) =>
        left.candidateFingerprint.localeCompare(right.candidateFingerprint)
      );
      const sameFingerprint = sortedCandidates.find(
        (candidate) =>
          candidate.candidateFingerprint === decision.candidateFingerprint
      );
      const sameSemantic =
        sameFingerprint ??
        sortedCandidates.find(
          (candidate) => candidate.semanticKey === decision.semanticKey
        );
      if (!sameSemantic) {
        return { decisionId: decision.id, state: "candidate-missing" };
      }
      if (
        decision.sourceDigest !== input.sourceDigest &&
        (decision.kind === "accept-asset"
          ? sameFingerprint !== undefined
          : sameSemantic.writes.length === decision.frozenWrites.length &&
            sameSemantic.writes.every((write) =>
              decision.frozenWrites.some(
                (frozen) =>
                  frozen.target === write.target &&
                  valuesEqual(frozen.value, write.value)
              )
            ))
      ) {
        return {
          decisionId: decision.id,
          state: "source-changed-same-value",
        };
      }
      if (!sameFingerprint) {
        return { decisionId: decision.id, state: "candidate-changed" };
      }
      return { decisionId: decision.id, state: "current" };
    })
    .sort((left, right) => left.decisionId.localeCompare(right.decisionId));
  return { decisions: state, staleness: immutable(staleness) };
}

function assertMessageDefinition(
  registry: TemplateMessageRegistryV1,
  message: TemplateMessageV1
): void {
  const definitions = registry.definitions.filter(
    (definition) => definition.code === message.code
  );
  if (definitions.length !== 1) {
    throw new TemplateAuthoringError(
      "message-invalid",
      `${message.code} must have exactly one definition in ${registry.id}`
    );
  }
  const definition = definitions[0] as TemplateMessageDefinitionV1;
  const expected = Object.keys(definition.params).sort();
  const actual = Object.keys(message.params).sort();
  if (canonicalCapabilityJson(expected) !== canonicalCapabilityJson(actual)) {
    throw new TemplateAuthoringError(
      "message-invalid",
      `${message.code} has unknown or missing parameters`
    );
  }
  for (const [name, value] of Object.entries(message.params)) {
    const rule = definition.params[name];
    if (!rule || typeof value !== rule.type || !["string", "number", "boolean"].includes(typeof value)) {
      throw new TemplateAuthoringError(
        "message-invalid",
        `${message.code}.${name} has the wrong type`
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TemplateAuthoringError(
        "message-invalid",
        `${message.code}.${name} must be finite`
      );
    }
    if (typeof value === "string") {
      if ((rule.maxLength ?? 0) < value.length) {
        throw new TemplateAuthoringError(
          "message-invalid",
          `${message.code}.${name} is too long`
        );
      }
      if (UNSAFE_MESSAGE_STRING_RE.test(value)) {
        throw new TemplateAuthoringError(
          "message-invalid",
          `${message.code}.${name} contains unsafe host or document data`
        );
      }
      if (rule.format === "stable-id" && !STABLE_ID_RE.test(value)) {
        throw new TemplateAuthoringError(
          "message-invalid",
          `${message.code}.${name} must be a stable identifier`
        );
      }
      if (rule.format === "fingerprint" && !FINGERPRINT_RE.test(value)) {
        throw new TemplateAuthoringError(
          "message-invalid",
          `${message.code}.${name} must be a fingerprint`
        );
      }
    }
  }
}

export function validateTemplateMessageOwnership(
  message: TemplateMessageV1,
  registries: readonly TemplateMessageRegistryV1[]
): void {
  const owners = registries.filter((registry) =>
    registry.definitions.some((definition) => definition.code === message.code)
  );
  if (owners.length !== 1) {
    throw new TemplateAuthoringError(
      "message-invalid",
      `${message.code} must be owned by exactly one registry`
    );
  }
  assertMessageDefinition(owners[0] as TemplateMessageRegistryV1, message);
}

export function validateTemplateDiagnostic(
  diagnostic: TemplateDiagnosticV1,
  registries: readonly TemplateMessageRegistryV1[]
): void {
  validateTemplateMessageOwnership(diagnostic, registries);
  if (
    diagnostic.severity === "error" &&
    diagnostic.code !== "AUTHORING_SOURCE_UNREADABLE" &&
    diagnostic.recoveryActions.length === 0
  ) {
    throw new TemplateAuthoringError(
      "message-invalid",
      "Blocking diagnostics require a recovery action"
    );
  }
  if (
    diagnostic.technicalRef !== undefined &&
    !STABLE_ID_RE.test(diagnostic.technicalRef)
  ) {
    throw new TemplateAuthoringError(
      "message-invalid",
      "technicalRef must be an opaque stable identifier"
    );
  }
}

export function validateTemplateExplanation(
  explanation: TemplateExplanationV1,
  registries: readonly TemplateMessageRegistryV1[]
): void {
  validateTemplateMessageOwnership(explanation, registries);
  for (const reference of explanation.evidenceRefs) assertStableId(reference, "evidenceRef");
}

export function validateTemplateImportProgressEvent(
  event: TemplateImportProgressEventV1,
  registries: readonly TemplateMessageRegistryV1[] = []
): void {
  if (
    event.schema !== TEMPLATE_IMPORT_PROGRESS_SCHEMA_V1 ||
    !STABLE_ID_RE.test(event.operationId) ||
    ![
      "opening",
      "scanning",
      "resolving",
      "matching",
      "extracting-assets",
      "rendering-preview",
      "validating",
      "packing",
    ].includes(event.phase) ||
    !Number.isSafeInteger(event.completed) ||
    event.completed < 0 ||
    (event.total !== null &&
      (!Number.isSafeInteger(event.total) ||
        event.total < event.completed ||
        event.total < 0))
  ) {
    throw new TemplateAuthoringError(
      "message-invalid",
      "Invalid template-import progress event"
    );
  }
  if (event.detailCode === undefined) {
    if (event.detailParams !== undefined) {
      throw new TemplateAuthoringError(
        "message-invalid",
        "Progress detail parameters require a detail code"
      );
    }
    return;
  }
  validateTemplateMessageOwnership(
    { code: event.detailCode, params: event.detailParams ?? {} },
    registries
  );
}

function displayValue(
  value: unknown,
  format:
    | "boolean"
    | "color"
    | "font"
    | "length"
    | "number"
    | "text"
): TemplateDisplayValueV1 {
  if (value === undefined) return { kind: "not-set" };
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean" &&
    value !== null
  ) {
    return { kind: "scalar", format: "text", value: canonicalCapabilityJson(value) };
  }
  return { kind: "scalar", format, value };
}

function diagnostic(
  code: string,
  params: Record<string, string | number | boolean>,
  severity: TemplateDiagnosticV1["severity"],
  recoveryActions: readonly TemplateImportActionKindV1[]
): TemplateDiagnosticV1 {
  const value: TemplateDiagnosticV1 = {
    code,
    params,
    severity,
    recoveryActions,
  };
  validateTemplateDiagnostic(value, [AUTHORING_MESSAGE_REGISTRY_V1]);
  return value;
}

function action(
  kind: TemplateImportActionKindV1,
  enabled: boolean,
  affectedItems: number,
  confirmation: TemplateImportActionDescriptorV1["confirmation"] = "none"
): TemplateImportActionDescriptorV1 {
  const descriptor: TemplateImportActionDescriptorV1 = {
    id: `action:${kind}`,
    kind,
    enabled,
    confirmation,
    affectedItems,
    ...(enabled
      ? {}
      : {
          disabledReason: diagnostic(
            "AUTHORING_ACTION_DISABLED",
            { action: kind },
            "info",
            []
          ),
        }),
  };
  return descriptor;
}

function candidateAnswered(
  candidate: TemplateCandidateV1,
  decisions: TemplateDecisionStateV1
): boolean {
  return decisions.decisions.some((decision) => {
    if (
      decision.kind === "accept-candidate" ||
      decision.kind === "accept-asset"
    ) {
      return decision.semanticKey === candidate.semanticKey;
    }
    if (decision.kind === "use-baseline") {
      return (
        (decision.semanticKey === "*" ||
          decision.semanticKey === candidate.semanticKey) &&
        scopeMatchesCandidate(decision.scope, candidate)
      );
    }
    return (
      decision.kind === "override" &&
      candidate.writes.some(({ target }) => target === decision.target)
    );
  });
}

function previewFreshness(
  actual: string | undefined,
  expected: string
): "missing" | "ready" | "stale" {
  if (!actual) return "missing";
  return actual === expected ? "ready" : "stale";
}

/**
 * Sole journey projection. All fields are derived, sorted, structured, and
 * locale-free; no host may reinterpret action validity.
 */
export function projectTemplateImportView(
  input: TemplateImportProjectionInputV1
): TemplateImportViewV1 {
  const messageRegistries = [
    AUTHORING_MESSAGE_REGISTRY_V1,
    ...(input.messageRegistries ?? []),
  ];
  for (const item of input.diagnostics) {
    validateTemplateDiagnostic(item, messageRegistries);
  }
  const baselineFlat = flattenDesign(input.baseline);
  const effectiveFlat = flattenDesign(input.snapshot.design);
  const presentations = new Map(
    input.presentation.descriptors.map((descriptor) => [
      descriptor.target,
      descriptor,
    ])
  );
  const candidates = [...input.candidates].sort((left, right) => {
    const semantic = left.semanticKey.localeCompare(right.semanticKey);
    return semantic === 0
      ? left.candidateFingerprint.localeCompare(right.candidateFingerprint)
      : semantic;
  });
  const ambiguous = ambiguousCandidates(candidates);
  const groups = new Map<string, TemplateCandidateV1[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.semanticKey) ?? [];
    group.push(candidate);
    groups.set(candidate.semanticKey, group);
  }

  const items = [...groups.entries()]
    .filter(([, groupCandidates]) =>
      groupCandidates.some(
        (candidate) =>
          !candidateIsRejected(input.decisions.decisions, candidate)
      )
    )
    .map(([semanticKey, groupCandidates]) => {
    const visible = groupCandidates.filter(
      (candidate) => !candidateIsRejected(input.decisions.decisions, candidate)
    );
    const primary = (visible[0] ?? groupCandidates[0]) as TemplateCandidateV1;
    const answered = groupCandidates.some((candidate) =>
      candidateAnswered(candidate, input.decisions)
    );
    const cannotTransfer = groupCandidates.every(
      (candidate) =>
        candidate.compatibility === "unsupported" ||
        candidate.confidence === "blocked" ||
        candidate.adoption === "blocked"
    );
    const ready = groupCandidates.some(
      (candidate) =>
        !ambiguous.has(candidate.id) &&
        deriveSafeCandidates(input.decisions, [candidate], {
          catalog: input.catalog,
          baseline: input.baseline,
          catalogDigest: input.snapshot.catalog.digest,
          sourceDigest: input.snapshot.sourceDigest,
          importerVersion: "view",
          mappingVersion: "view",
        }).length === 1
    );
    const state: import("./contracts.js").TemplateReviewItemV1["state"] = answered
      ? "decided"
      : cannotTransfer
        ? "cannot-transfer"
        : ready
          ? "ready"
          : "review";
    const targets = [
      ...new Set(groupCandidates.flatMap((candidate) =>
        candidate.writes.map(({ target }) => target)
      )),
    ].sort();
    const descriptor = targets.map((target) => presentations.get(target)).find(Boolean);
    const target = targets[0] ?? "unknown";
    const format = descriptor?.valueFormat ?? "text";
    const scalarFormat =
      format === "boolean" ||
      format === "color" ||
      format === "font" ||
      format === "length" ||
      format === "number" ||
      format === "text"
        ? format
        : "text";
    const proposed = primary.writes[0]?.value;
    for (const candidate of groupCandidates) {
      if (candidate.conceptCode) {
        validateTemplateMessageOwnership(
          { code: candidate.conceptCode, params: {} },
          messageRegistries
        );
      }
      for (const explanation of candidate.explanations) {
        validateTemplateExplanation(explanation, messageRegistries);
      }
      for (const candidateDiagnostic of candidate.diagnostics) {
        validateTemplateDiagnostic(candidateDiagnostic, messageRegistries);
      }
    }
    const itemAction = (
      kind: TemplateImportActionKindV1,
      enabled: boolean,
      confirmation: TemplateImportActionDescriptorV1["confirmation"] = "none"
    ): TemplateImportActionDescriptorV1 => ({
      ...action(kind, enabled, 1, confirmation),
      id: `action:${kind}:${semanticKey}`,
    });
    const itemActions: TemplateImportActionDescriptorV1[] = [
      itemAction("use-word-value", !answered && !cannotTransfer),
      itemAction("keep-current-design", !answered && !cannotTransfer),
      itemAction("customize", !cannotTransfer && primary.kind !== "asset"),
      itemAction(
        "review-asset",
        !answered && !cannotTransfer && primary.kind === "asset",
        "rights"
      ),
    ];
    return {
      section: descriptor?.section ?? "unsupported",
      order: descriptor?.order ?? Number.MAX_SAFE_INTEGER,
      item: {
        id: `review:${semanticKey}`,
        semanticKey,
        labelCode:
          primary.conceptCode ??
          descriptor?.messageCode ??
          "PDF_CAPABILITY_DETAILS",
        state,
        baseline: displayValue(baselineFlat[target], scalarFormat),
        ...(proposed === undefined
          ? {}
          : { proposed: displayValue(proposed, scalarFormat) }),
        effective: displayValue(effectiveFlat[target], scalarFormat),
        explanations: immutable(primary.explanations),
        diagnostics: immutable(primary.diagnostics),
        actions: itemActions,
        details: {
          candidateIds: visible.map(({ id }) => id).sort(),
          candidateFingerprints: visible
            .map(({ candidateFingerprint }) => candidateFingerprint)
            .sort(),
          targets,
        },
      },
    };
    });
  items.sort((left, right) => {
    const section = left.section.localeCompare(right.section);
    if (section !== 0) return section;
    const order = left.order - right.order;
    return order !== 0 ? order : left.item.id.localeCompare(right.item.id);
  });
  const sections = [...new Set(items.map(({ section }) => section))].map((id) => {
    const sectionItems = items
      .filter(({ section }) => section === id)
      .map(({ item }) => item);
    return {
      id,
      itemCount: sectionItems.length,
      attentionCount: sectionItems.filter(
        ({ state }) => state === "review" || state === "cannot-transfer"
      ).length,
      items: sectionItems,
    };
  });
  const flatItems = sections.flatMap(({ items: sectionItems }) => sectionItems);
  const readyToApply = flatItems.filter(({ state }) => state === "ready").length;
  const needsReview = flatItems.filter(({ state }) => state === "review").length;
  const cannotTransfer = flatItems.filter(
    ({ state }) => state === "cannot-transfer"
  ).length;
  const unanswered = readyToApply + needsReview;
  const blockingDiagnostics = input.diagnostics.filter(
    ({ severity }) => severity === "error"
  );
  const staleDecisions = input.snapshot.staleness.filter(
    ({ state }) => state !== "current"
  );
  const acknowledgement = input.decisions.decisions.find(
    (decision) => decision.kind === "acknowledge-inventory"
  );
  const inventoryAcknowledged =
    input.inventoryDiagnosticCodes.length === 0 ||
    (acknowledgement?.kind === "acknowledge-inventory" &&
      acknowledgement.analysisDigest === input.analysisDigest &&
      canonicalCapabilityJson(acknowledgement.diagnosticCodes) ===
        canonicalCapabilityJson([...input.inventoryDiagnosticCodes].sort()));
  const designReview = previewFreshness(
    input.decisions.preview.designReviewDigest,
    input.previewDigest
  );
  const compatibilityProof = previewFreshness(
    input.decisions.preview.compatibilityProofDigest,
    input.previewDigest
  );
  const previewReady =
    designReview === "ready" && compatibilityProof === "ready";
  const blockers =
    blockingDiagnostics.length +
    staleDecisions.length +
    (inventoryAcknowledged ? 0 : 1);

  let stage: TemplateImportViewV1["stage"];
  if (input.analyzing) stage = "analyzing";
  else if (blockingDiagnostics.length > 0) stage = "blocked";
  else if (staleDecisions.length > 0) stage = "source-changed";
  else if (unanswered > 0 || !inventoryAcknowledged) stage = "review-required";
  else if (!previewReady) stage = "ready-to-preview";
  else if (input.decisions.builtFromDigest === input.previewDigest) stage = "built";
  else stage = "ready-to-build";

  const availableActions = [
    action("apply-ready", readyToApply > 0, readyToApply),
    action("keep-current-for-remaining", unanswered > 0, unanswered, "summary"),
    action(
      "acknowledge-inventory",
      input.inventoryDiagnosticCodes.length > 0 && !inventoryAcknowledged,
      input.inventoryDiagnosticCodes.length,
      "summary"
    ),
    action(
      "preview",
      !input.analyzing &&
        unanswered === 0 &&
        blockers === 0 &&
        !previewReady,
      1
    ),
    action("build", stage === "ready-to-build", 1, "summary"),
    action("reanalyze", !input.analyzing, 1),
    action("undo", input.hasHistory, 1),
  ];
  const nextActions =
    stage === "analyzing"
      ? []
      : stage === "blocked" || stage === "source-changed"
        ? ["action:reanalyze"]
        : stage === "review-required"
          ? [
              ...(readyToApply > 0 ? ["action:apply-ready"] : []),
              "action:keep-current-for-remaining",
              ...(inventoryAcknowledged
                ? []
                : ["action:acknowledge-inventory"]),
            ]
          : stage === "ready-to-preview"
            ? ["action:preview"]
            : stage === "ready-to-build"
              ? ["action:build"]
              : [];
  return immutable({
    schema: TEMPLATE_IMPORT_VIEW_SCHEMA_V1,
    generation: input.generation,
    stage,
    summary: {
      readyToApply,
      needsReview,
      cannotTransfer,
      blockers,
      unanswered,
    },
    sections,
    diagnostics: [...input.diagnostics].sort((left, right) =>
      `${left.code}:${canonicalCapabilityJson(left.params)}`.localeCompare(
        `${right.code}:${canonicalCapabilityJson(right.params)}`
      )
    ),
    availableActions,
    nextActions,
    preview: { designReview, compatibilityProof },
  });
}

function enabledAction(
  view: TemplateImportViewV1,
  actionValue: TemplateImportActionV1
): TemplateImportActionDescriptorV1 {
  const descriptor = [
    ...view.availableActions,
    ...view.sections.flatMap(({ items }) =>
      items.flatMap(({ actions }) => actions)
    ),
  ].find(
    (candidate) =>
      candidate.id === actionValue.id && candidate.kind === actionValue.kind
  );
  if (!descriptor?.enabled) {
    throw new TemplateAuthoringError(
      "action-disabled",
      `${actionValue.kind} is not enabled in generation ${view.generation}`
    );
  }
  return descriptor;
}

function enabledReviewItem(
  view: TemplateImportViewV1,
  actionValue: TemplateImportActionV1
): import("./contracts.js").TemplateReviewItemV1 {
  const item = view.sections
    .flatMap(({ items }) => items)
    .find(({ actions }) =>
      actions.some(
        ({ id, kind, enabled }) =>
          id === actionValue.id && kind === actionValue.kind && enabled
      )
    );
  if (!item) {
    throw new TemplateAuthoringError(
      "action-disabled",
      `${actionValue.kind} is not enabled for a review item`
    );
  }
  return item;
}

export async function reduceTemplateImportAction(
  state: TemplateDecisionStateV1,
  actionValue: TemplateImportActionV1,
  context: TemplateImportActionContextV1
): Promise<TemplateDecisionStateV1> {
  const view = projectTemplateImportView(context.projection);
  enabledAction(view, actionValue);
  const decisionContext = context.decisionContext;
  switch (actionValue.kind) {
    case "apply-ready":
      return acceptSafeCandidates(
        state,
        context.projection.candidates,
        decisionContext
      );
    case "use-word-value": {
      const item = enabledReviewItem(view, actionValue);
      if (!item.details.candidateIds.includes(actionValue.candidateId)) {
        throw new TemplateAuthoringError(
          "action-disabled",
          "Candidate does not belong to the enabled review item"
        );
      }
      const candidate = context.projection.candidates.find(
        ({ id }) => id === actionValue.candidateId
      );
      if (!candidate) {
        throw new TemplateAuthoringError("action-disabled", "Candidate is unavailable");
      }
      return reduceTemplateDecision(
        state,
        { kind: "accept-candidate", candidate, decidedBy: { kind: "user" } },
        decisionContext
      );
    }
    case "keep-current-design":
      if (
        enabledReviewItem(view, actionValue).semanticKey !==
        actionValue.semanticKey
      ) {
        throw new TemplateAuthoringError(
          "action-disabled",
          "Tombstone does not belong to the enabled review item"
        );
      }
      return reduceTemplateDecision(
        state,
        {
          kind: "use-baseline",
          semanticKey: actionValue.semanticKey,
          scope: actionValue.scope,
        },
        decisionContext
      );
    case "customize":
      if (
        !enabledReviewItem(view, actionValue).details.targets.includes(
          actionValue.target
        )
      ) {
        throw new TemplateAuthoringError(
          "action-disabled",
          "Override target does not belong to the enabled review item"
        );
      }
      return reduceTemplateDecision(
        state,
        {
          kind: "override",
          target: actionValue.target,
          value: actionValue.value,
        },
        decisionContext
      );
    case "review-asset": {
      const item = enabledReviewItem(view, actionValue);
      if (!item.details.candidateIds.includes(actionValue.candidateId)) {
        throw new TemplateAuthoringError(
          "action-disabled",
          "Asset does not belong to the enabled review item"
        );
      }
      const candidate = context.projection.candidates.find(
        ({ id }) => id === actionValue.candidateId
      );
      if (!candidate) {
        throw new TemplateAuthoringError("action-disabled", "Asset candidate is unavailable");
      }
      return reduceTemplateDecision(
        state,
        {
          kind: "accept-asset",
          candidate,
          assetSha256: actionValue.assetSha256,
          role: actionValue.role,
          useConfirmed: actionValue.useConfirmed,
          rightsConfirmed: actionValue.rightsConfirmed,
          accessibility: actionValue.accessibility,
          rendering: actionValue.rendering,
        },
        decisionContext
      );
    }
    case "keep-current-for-remaining": {
      let next = state;
      for (const section of view.sections) {
        for (const item of section.items) {
          if (item.state !== "ready" && item.state !== "review") continue;
          const groupId =
            context.projection.candidates.find(
              ({ semanticKey }) => semanticKey === item.semanticKey
            )?.group.id ?? item.semanticKey;
          next = reduceTemplateDecision(
            next,
            {
              kind: "use-baseline",
              semanticKey: item.semanticKey,
              scope: { kind: "group", groupId },
            },
            decisionContext
          );
        }
      }
      return next;
    }
    case "acknowledge-inventory":
      return reduceTemplateDecision(
        state,
        {
          kind: "acknowledge-inventory",
          analysisDigest: context.projection.analysisDigest,
          diagnosticCodes: context.projection.inventoryDiagnosticCodes,
        },
        decisionContext
      );
    case "reanalyze":
      return reduceTemplateDecision(
        state,
        { kind: "invalidate-derived-artifacts" },
        decisionContext
      );
    case "preview":
      return reduceTemplateDecision(
        state,
        { kind: "mark-preview", digest: context.projection.previewDigest },
        decisionContext
      );
    case "build":
      return reduceTemplateDecision(
        state,
        { kind: "mark-built", digest: context.projection.previewDigest },
        decisionContext
      );
    case "undo":
      return reduceTemplateDecision(
        state,
        { kind: "restore", state: actionValue.previousState },
        decisionContext
      );
  }
}

export function canonicalTemplateImportViewJson(
  view: TemplateImportViewV1
): string {
  return canonicalCapabilityJson(view);
}

export function deriveTemplateImportActions(
  input: TemplateImportProjectionInputV1
): readonly TemplateImportActionDescriptorV1[] {
  return projectTemplateImportView(input).availableActions;
}
