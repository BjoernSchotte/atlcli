import { ResearchContractError, type ResearchProduct } from "./contracts.js";
import type { ResearchCoverageTargetV1 } from "./brief.js";
import type { ResearchClaimLedgerV1, ResearchClaimV1 } from "./claim-ledger.js";
import type { ResearchEvidenceRecordV1, ResearchEvidenceStoreV1 } from "./evidence-store.js";
import type { ResearchPacketBodyV2 } from "./workflow-contracts.js";
import type { ResearchWorkspace } from "./workspace.js";

export const RESEARCH_CONTRADICTION_SCHEMA_V1 = "atlcli.research-contradiction/v1" as const;
export const RESEARCH_COVERAGE_ASSESSMENT_SCHEMA_V1 = "atlcli.research-coverage-assessment/v1" as const;
export const RESEARCH_OUTLINE_SCHEMA_V1 = "atlcli.research-outline/v1" as const;
export const RESEARCH_OUTLINE_STORE_INDEX_SCHEMA_V1 = "atlcli.research-outline-store-index/v1" as const;

const ROOT_PATH = "/.atlcli/outlines/v1";
const INDEX_PATH = `${ROOT_PATH}/index.json`;
const MAXIMUM_OUTLINES = 256;
const MAXIMUM_SECTIONS = 24;
const MAXIMUM_CONTRADICTIONS = 64;
const MAXIMUM_COVERAGE_TARGETS = 64;
const MAXIMUM_CLAIMS_PER_REFERENCE = 48;
const MAXIMUM_EVIDENCE_PER_REFERENCE = 96;
const MAXIMUM_INDEX_BYTES = 1_500_000;

export type ResearchCoverageStatusV1 = "covered" | "partial" | "uncovered";
export type ResearchContradictionStatusV1 = "open" | "resolved" | "abstained";

/**
 * Host-validated disagreement between two or more current claims. It is not
 * source evidence itself and a report section cannot use an open conflict's
 * claims as support.
 */
export interface ResearchContradictionV1 {
  schema: typeof RESEARCH_CONTRADICTION_SCHEMA_V1;
  id: string;
  claimIds: string[];
  evidenceIds: string[];
  status: ResearchContradictionStatusV1;
  summary: string;
  detectedAt: string;
  resolution?: string;
  resolvedAt?: string;
}

/** Host-derived assessment for exactly one brief coverage target. */
export interface ResearchCoverageAssessmentV1 {
  schema: typeof RESEARCH_COVERAGE_ASSESSMENT_SCHEMA_V1;
  targetId: string;
  status: ResearchCoverageStatusV1;
  claimIds: string[];
  evidenceIds: string[];
  distinctSourceCount: number;
  assessedAt: string;
}

/** One evidence/claim-bounded report section. */
export interface ResearchOutlineSectionV1 {
  id: string;
  title: string;
  question: string;
  claimIds: string[];
  evidenceIds: string[];
  contradictionIds: string[];
  coverageTargetIds: string[];
  dependsOnSectionIds: string[];
}

/**
 * Immutable, evidence-linked plan for one report revision. The report writer
 * receives a host projection of one section, not this whole durable object.
 */
export interface ResearchOutlineV1 {
  schema: typeof RESEARCH_OUTLINE_SCHEMA_V1;
  id: string;
  revision: number;
  basedOnBriefRevision: number;
  supersedesOutlineId?: string;
  createdAt: string;
  sections: ResearchOutlineSectionV1[];
  contradictions: ResearchContradictionV1[];
  coverage: ResearchCoverageAssessmentV1[];
}

interface PersistedOutlineIndexV1 {
  schema: typeof RESEARCH_OUTLINE_STORE_INDEX_SCHEMA_V1;
  outlineIds: string[];
  currentOutlineId?: string;
}

export interface ResearchOutlineStoreV1 {
  put(outline: ResearchOutlineV1): Promise<ResearchOutlineV1>;
  get(outlineId: string): Promise<ResearchOutlineV1 | undefined>;
  current(): Promise<ResearchOutlineV1 | undefined>;
  /** Rechecks live claim/evidence references before report publication. */
  validateCurrent(): Promise<ResearchOutlineV1 | undefined>;
  list(input?: { limit?: number; cursor?: string }): Promise<{ outlines: ResearchOutlineV1[]; nextCursor?: string }>;
  clear(): Promise<void>;
}

function invalid(message: string): never {
  throw new ResearchContractError("invalid-request", message);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function text(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0) || value.length > maximum || value.includes("\u0000")) {
    invalid(`${label} is invalid.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!Number.isFinite(Date.parse(result))) invalid(`${label} is invalid.`);
  return result;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    invalid(`${label} is invalid.`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    invalid(`${label} is invalid.`);
  }
  return value as number;
}

function outlineId(value: unknown): string {
  const result = text(value, "Outline ID", 96);
  if (!/^outline:[a-f0-9]{48}$/.test(result)) invalid("Outline ID is invalid.");
  return result;
}

function sectionId(value: unknown): string {
  const result = text(value, "Outline section ID", 160);
  if (!/^outline-section:[A-Za-z0-9._-]{1,128}$/.test(result)) invalid("Outline section ID is invalid.");
  return result;
}

function contradictionId(value: unknown): string {
  const result = text(value, "Contradiction ID", 160);
  if (!/^contradiction:[A-Za-z0-9._-]{1,128}$/.test(result)) invalid("Contradiction ID is invalid.");
  return result;
}

function claimId(value: unknown): string {
  const result = text(value, "Outline claim ID", 96);
  if (!/^claim:[a-f0-9]{48}$/.test(result)) invalid("Outline claim ID is invalid.");
  return result;
}

function evidenceId(value: unknown): string {
  const result = text(value, "Outline evidence ID", 96);
  if (!/^evidence:[a-f0-9]{48}$/.test(result)) invalid("Outline evidence ID is invalid.");
  return result;
}

function coverageTargetId(value: unknown): string {
  const result = text(value, "Coverage target ID", 160);
  if (!/^coverage:[A-Za-z0-9._-]{1,120}$/.test(result)) invalid("Coverage target ID is invalid.");
  return result;
}

function sortedDistinct<T>(
  value: unknown,
  label: string,
  maximum: number,
  parse: (candidate: unknown) => T,
  key: (candidate: T) => string,
): T[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label} is invalid.`);
  const result = value.map(parse);
  const keys = result.map(key);
  if (new Set(keys).size !== keys.length) invalid(`${label} contains duplicates.`);
  return result.sort((left, right) => key(left).localeCompare(key(right)));
}

function parseContradiction(value: unknown): ResearchContradictionV1 {
  if (!value || typeof value !== "object") invalid("Contradiction is invalid.");
  const candidate = value as Partial<ResearchContradictionV1>;
  if (candidate.schema !== RESEARCH_CONTRADICTION_SCHEMA_V1) invalid("Contradiction schema is invalid.");
  if (candidate.status !== "open" && candidate.status !== "resolved" && candidate.status !== "abstained") {
    invalid("Contradiction status is invalid.");
  }
  const claimIds = sortedDistinct(candidate.claimIds, "Contradiction claim IDs", 8, claimId, (id) => id);
  if (claimIds.length < 2) invalid("A contradiction requires at least two claims.");
  const evidenceIds = sortedDistinct(candidate.evidenceIds, "Contradiction evidence IDs", MAXIMUM_EVIDENCE_PER_REFERENCE, evidenceId, (id) => id);
  if (evidenceIds.length === 0) invalid("A contradiction requires evidence.");
  const status = candidate.status;
  if (status === "open") {
    if (candidate.resolution !== undefined || candidate.resolvedAt !== undefined) invalid("An open contradiction cannot have a resolution.");
  } else if (candidate.resolution === undefined || candidate.resolvedAt === undefined) {
    invalid("A closed contradiction requires a resolution.");
  }
  return {
    schema: RESEARCH_CONTRADICTION_SCHEMA_V1,
    id: contradictionId(candidate.id),
    claimIds,
    evidenceIds,
    status,
    summary: text(candidate.summary, "Contradiction summary", 1_200),
    detectedAt: timestamp(candidate.detectedAt, "Contradiction detected time"),
    ...(candidate.resolution === undefined ? {} : { resolution: text(candidate.resolution, "Contradiction resolution", 1_200) }),
    ...(candidate.resolvedAt === undefined ? {} : { resolvedAt: timestamp(candidate.resolvedAt, "Contradiction resolved time") }),
  };
}

function parseCoverage(value: unknown): ResearchCoverageAssessmentV1 {
  if (!value || typeof value !== "object") invalid("Coverage assessment is invalid.");
  const candidate = value as Partial<ResearchCoverageAssessmentV1>;
  if (candidate.schema !== RESEARCH_COVERAGE_ASSESSMENT_SCHEMA_V1) invalid("Coverage assessment schema is invalid.");
  if (candidate.status !== "covered" && candidate.status !== "partial" && candidate.status !== "uncovered") {
    invalid("Coverage assessment status is invalid.");
  }
  return {
    schema: RESEARCH_COVERAGE_ASSESSMENT_SCHEMA_V1,
    targetId: coverageTargetId(candidate.targetId),
    status: candidate.status,
    claimIds: sortedDistinct(candidate.claimIds, "Coverage claim IDs", MAXIMUM_CLAIMS_PER_REFERENCE, claimId, (id) => id),
    evidenceIds: sortedDistinct(candidate.evidenceIds, "Coverage evidence IDs", MAXIMUM_EVIDENCE_PER_REFERENCE, evidenceId, (id) => id),
    distinctSourceCount: nonNegativeInteger(candidate.distinctSourceCount, "Coverage source count", MAXIMUM_EVIDENCE_PER_REFERENCE),
    assessedAt: timestamp(candidate.assessedAt, "Coverage assessment time"),
  };
}

function parseSection(value: unknown): ResearchOutlineSectionV1 {
  if (!value || typeof value !== "object") invalid("Outline section is invalid.");
  const candidate = value as Partial<ResearchOutlineSectionV1>;
  const claimIds = sortedDistinct(candidate.claimIds, "Outline section claim IDs", MAXIMUM_CLAIMS_PER_REFERENCE, claimId, (id) => id);
  const evidenceIds = sortedDistinct(candidate.evidenceIds, "Outline section evidence IDs", MAXIMUM_EVIDENCE_PER_REFERENCE, evidenceId, (id) => id);
  const contradictionIds = sortedDistinct(candidate.contradictionIds, "Outline section contradiction IDs", MAXIMUM_CONTRADICTIONS, contradictionId, (id) => id);
  const coverageTargetIds = sortedDistinct(candidate.coverageTargetIds, "Outline section coverage target IDs", MAXIMUM_COVERAGE_TARGETS, coverageTargetId, (id) => id);
  if (claimIds.length === 0 && evidenceIds.length === 0 && contradictionIds.length === 0 && coverageTargetIds.length === 0) {
    invalid("Outline section has no evidence, claim, contradiction, or coverage link.");
  }
  return {
    id: sectionId(candidate.id),
    title: text(candidate.title, "Outline section title", 240),
    question: text(candidate.question, "Outline section question", 1_200),
    claimIds,
    evidenceIds,
    contradictionIds,
    coverageTargetIds,
    dependsOnSectionIds: sortedDistinct(candidate.dependsOnSectionIds, "Outline section dependencies", MAXIMUM_SECTIONS, sectionId, (id) => id),
  };
}

function parseOutline(value: unknown): ResearchOutlineV1 {
  if (!value || typeof value !== "object") invalid("Outline is invalid.");
  const candidate = value as Partial<ResearchOutlineV1>;
  if (candidate.schema !== RESEARCH_OUTLINE_SCHEMA_V1) invalid("Outline schema is invalid.");
  const sections = sortedDistinct(candidate.sections, "Outline sections", MAXIMUM_SECTIONS, parseSection, (section) => section.id);
  if (sections.length === 0) invalid("Outline requires at least one section.");
  const contradictions = sortedDistinct(candidate.contradictions, "Outline contradictions", MAXIMUM_CONTRADICTIONS, parseContradiction, (contradiction) => contradiction.id);
  const coverage = sortedDistinct(candidate.coverage, "Outline coverage", MAXIMUM_COVERAGE_TARGETS, parseCoverage, (entry) => entry.targetId);
  if (coverage.length === 0) invalid("Outline requires coverage assessments.");
  const sectionIds = new Set(sections.map((section) => section.id));
  for (const section of sections) {
    if (section.dependsOnSectionIds.includes(section.id) || section.dependsOnSectionIds.some((id) => !sectionIds.has(id))) {
      invalid("Outline section dependencies are invalid.");
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(sections.map((section) => [section.id, section]));
  const visit = (id: string): void => {
    if (visiting.has(id)) invalid("Outline section dependencies must be acyclic.");
    if (visited.has(id)) return;
    visiting.add(id);
    byId.get(id)!.dependsOnSectionIds.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  sections.forEach((section) => visit(section.id));
  return {
    schema: RESEARCH_OUTLINE_SCHEMA_V1,
    id: outlineId(candidate.id),
    revision: positiveInteger(candidate.revision, "Outline revision", MAXIMUM_OUTLINES),
    basedOnBriefRevision: positiveInteger(candidate.basedOnBriefRevision, "Outline brief revision", 1_000_000),
    ...(candidate.supersedesOutlineId === undefined ? {} : { supersedesOutlineId: outlineId(candidate.supersedesOutlineId) }),
    createdAt: timestamp(candidate.createdAt, "Outline creation time"),
    sections,
    contradictions,
    coverage,
  };
}

function parseIndex(value: string): PersistedOutlineIndexV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid("Outline index is not JSON.");
  }
  if (!parsed || typeof parsed !== "object") invalid("Outline index is invalid.");
  const candidate = parsed as Partial<PersistedOutlineIndexV1>;
  if (candidate.schema !== RESEARCH_OUTLINE_STORE_INDEX_SCHEMA_V1) invalid("Outline index is invalid.");
  const outlineIds = sortedDistinct(candidate.outlineIds, "Outline index IDs", MAXIMUM_OUTLINES, outlineId, (id) => id);
  const currentOutlineId = candidate.currentOutlineId === undefined ? undefined : outlineId(candidate.currentOutlineId);
  if (currentOutlineId !== undefined && !outlineIds.includes(currentOutlineId)) invalid("Outline index current ID is invalid.");
  return { schema: RESEARCH_OUTLINE_STORE_INDEX_SCHEMA_V1, outlineIds, ...(currentOutlineId === undefined ? {} : { currentOutlineId }) };
}

function outlinePath(id: string): string {
  return `${ROOT_PATH}/outlines/${encodeURIComponent(id)}.json`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Creates the stable outline ID from the complete immutable revision. The host
 * must still persist it through `ResearchOutlineStoreV1`, which validates all
 * live evidence, claim, and coverage references before publication.
 */
export async function createResearchOutlineV1(input: Omit<ResearchOutlineV1, "schema" | "id">): Promise<ResearchOutlineV1> {
  const normalized = parseOutline({
    schema: RESEARCH_OUTLINE_SCHEMA_V1,
    id: `outline:${"0".repeat(48)}`,
    ...input,
  });
  const canonical = {
    revision: normalized.revision,
    basedOnBriefRevision: normalized.basedOnBriefRevision,
    ...(normalized.supersedesOutlineId === undefined ? {} : { supersedesOutlineId: normalized.supersedesOutlineId }),
    createdAt: normalized.createdAt,
    sections: normalized.sections,
    contradictions: normalized.contradictions,
    coverage: normalized.coverage,
  };
  const id = `outline:${(await sha256(JSON.stringify(canonical))).slice(0, 48)}`;
  return parseOutline({ schema: RESEARCH_OUTLINE_SCHEMA_V1, id, ...canonical });
}

function coverageTargetMap(targets: readonly ResearchCoverageTargetV1[]): Map<string, ResearchCoverageTargetV1> {
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAXIMUM_COVERAGE_TARGETS) {
    invalid("Outline coverage targets are invalid.");
  }
  const entries = targets.map((target) => {
    const candidate = target as unknown as Partial<ResearchCoverageTargetV1>;
    if (!candidate || typeof candidate !== "object") invalid("Outline coverage target is invalid.");
    const id = coverageTargetId(candidate.id);
    const question = text(candidate.question, "Outline coverage target question", 1_000);
    const sourceClasses = candidate.sourceClasses;
    const minimumDistinctSources = candidate.minimumDistinctSources;
    if (typeof minimumDistinctSources !== "number" || !Number.isSafeInteger(minimumDistinctSources) || minimumDistinctSources < 1 || minimumDistinctSources > MAXIMUM_EVIDENCE_PER_REFERENCE || !Array.isArray(sourceClasses) || sourceClasses.length === 0 || sourceClasses.some((product: ResearchProduct) => product !== "jira" && product !== "confluence") || typeof candidate.required !== "boolean") {
      invalid("Outline coverage target is invalid.");
    }
    return [id, {
      id,
      question,
      required: candidate.required,
      sourceClasses: [...sourceClasses] as ResearchProduct[],
      minimumDistinctSources,
    }] as const;
  });
  if (new Set(entries.map(([id]) => id)).size !== entries.length) invalid("Outline coverage targets contain duplicates.");
  return new Map(entries);
}

function expectedCoverageStatus(target: ResearchCoverageTargetV1, records: readonly ResearchEvidenceRecordV1[]): ResearchCoverageStatusV1 {
  const completeRecords = records.filter((record) => !record.version.truncated);
  const sources = new Set(completeRecords.map((record) => record.identity.canonicalId));
  const products = new Set(completeRecords.map((record) => record.identity.product as ResearchProduct));
  if (sources.size >= target.minimumDistinctSources && target.sourceClasses.every((product) => products.has(product))) return "covered";
  return records.length === 0 ? "uncovered" : "partial";
}

/**
 * Produces the initial authoritative outline for a V2 run from current host
 * claims. It deliberately accepts no model prose or model-derived coverage:
 * section membership, evidence links, and coverage status all come from the
 * private claim and evidence ledgers. A later outline-planner may propose a
 * different arrangement, but it must still pass the same store validation.
 */
export async function createResearchOutlineFromClaimsV1(input: {
  claimIds: readonly string[];
  claimLedger: ResearchClaimLedgerV1;
  evidenceStore: ResearchEvidenceStoreV1;
  coverageTargets: readonly ResearchCoverageTargetV1[];
  basedOnBriefRevision: number;
  createdAt: string;
  previousOutline?: ResearchOutlineV1;
}): Promise<ResearchOutlineV1> {
  const targets = coverageTargetMap(input.coverageTargets);
  const uniqueClaimIds = [...new Set(input.claimIds)];
  const selectedClaims: ResearchClaimV1[] = [];
  const selectedEvidenceIds = new Set<string>();
  for (const id of uniqueClaimIds) {
    if (selectedClaims.length >= MAXIMUM_CLAIMS_PER_REFERENCE) break;
    const claim = await input.claimLedger.refresh(id, input.createdAt);
    if (!claim || claim.freshness !== "current") continue;
    const additions = claim.evidenceIds.filter((evidenceId) => !selectedEvidenceIds.has(evidenceId));
    if (selectedEvidenceIds.size + additions.length > MAXIMUM_EVIDENCE_PER_REFERENCE) continue;
    selectedClaims.push(claim);
    additions.forEach((evidenceId) => selectedEvidenceIds.add(evidenceId));
  }
  const records = new Map<string, ResearchEvidenceRecordV1>();
  for (const evidenceId of selectedEvidenceIds) {
    const record = await input.evidenceStore.get(evidenceId);
    if (!record) invalid("A selected claim has no retained evidence.");
    records.set(evidenceId, record);
  }
  const claimIds = selectedClaims.map((claim) => claim.id);
  const evidenceIds = [...selectedEvidenceIds].sort();
  const coverage = [...targets.values()].map((target): ResearchCoverageAssessmentV1 => {
    const matchingEvidenceIds = evidenceIds.filter((evidenceId) =>
      target.sourceClasses.includes(records.get(evidenceId)!.identity.product),
    );
    const matchingEvidence = matchingEvidenceIds.map((evidenceId) => records.get(evidenceId)!);
    const matchingClaimIds = selectedClaims
      .filter((claim) => claim.evidenceIds.some((evidenceId) => matchingEvidenceIds.includes(evidenceId)))
      .map((claim) => claim.id);
    return {
      schema: RESEARCH_COVERAGE_ASSESSMENT_SCHEMA_V1,
      targetId: target.id,
      status: expectedCoverageStatus(target, matchingEvidence),
      claimIds: matchingClaimIds,
      evidenceIds: matchingEvidenceIds,
      distinctSourceCount: new Set(matchingEvidence.map((record) => record.identity.canonicalId)).size,
      assessedAt: input.createdAt,
    };
  });
  const previous = input.previousOutline;
  return createResearchOutlineV1({
    revision: previous ? previous.revision + 1 : 1,
    basedOnBriefRevision: input.basedOnBriefRevision,
    ...(previous ? { supersedesOutlineId: previous.id } : {}),
    createdAt: input.createdAt,
    sections: [{
      id: "outline-section:validated-findings",
      title: "Evidence-backed findings",
      question: "What do the currently validated claims establish?",
      claimIds,
      evidenceIds,
      contradictionIds: [],
      coverageTargetIds: [...targets.keys()].sort(),
      dependsOnSectionIds: [],
    }],
    contradictions: [],
    coverage,
  });
}

export interface ResearchOutlineProposalResolutionV1 {
  disposition: "accepted" | "revised" | "rejected";
  reason: string;
  outline: ResearchOutlineV1;
}

/**
 * Crosses the final structural trust boundary for the optional T5 outline
 * planner. Its accepted packet may influence grouping and non-factual labels,
 * but never evidence, coverage, contradictions, or the set of publishable
 * claims. A malformed or incomplete proposal falls back to the deterministic
 * host outline instead of blocking report publication.
 */
export async function resolveResearchOutlineProposalV1(input: {
  baseline: ResearchOutlineV1;
  proposals: readonly ResearchPacketBodyV2["outlineProposals"][number][];
  claimLedger: ResearchClaimLedgerV1;
  checkedAt: string;
}): Promise<ResearchOutlineProposalResolutionV1> {
  const baseline = parseOutline(input.baseline);
  if (!Number.isFinite(Date.parse(input.checkedAt))) invalid("Outline proposal check time is invalid.");
  if (input.proposals.length === 0) {
    return { disposition: "rejected", reason: "no-proposals", outline: clone(baseline) };
  }
  if (input.proposals.length > 12) {
    return { disposition: "rejected", reason: "too-many-proposals", outline: clone(baseline) };
  }

  try {
    const permittedClaimIds = new Set([
      ...baseline.sections.flatMap((section) => section.claimIds),
      ...baseline.coverage.flatMap((coverage) => coverage.claimIds),
    ]);
    const permittedCoverageTargetIds = new Set(baseline.coverage.map((coverage) => coverage.targetId));
    const modelSectionIds = new Set<string>();
    const proposedClaimIds = new Set<string>();
    const normalized = input.proposals.map((proposal) => {
      const modelSectionId = text(proposal.sectionId, "Outline proposal section ID", 160);
      if (modelSectionIds.has(modelSectionId)) invalid("Outline proposal section IDs are duplicated.");
      modelSectionIds.add(modelSectionId);
      const claimIds = sortedDistinct(
        proposal.claimIds,
        "Outline proposal claim IDs",
        MAXIMUM_CLAIMS_PER_REFERENCE,
        claimId,
        (id) => id,
      );
      if (claimIds.length === 0 || claimIds.some((id) => !permittedClaimIds.has(id))) {
        invalid("Outline proposal references unavailable claims.");
      }
      if (claimIds.some((id) => proposedClaimIds.has(id))) {
        invalid("Outline proposal assigns one claim more than once.");
      }
      claimIds.forEach((id) => proposedClaimIds.add(id));
      const coverageTargetIds = sortedDistinct(
        proposal.coverageTargetIds,
        "Outline proposal coverage targets",
        MAXIMUM_COVERAGE_TARGETS,
        coverageTargetId,
        (id) => id,
      );
      if (coverageTargetIds.some((id) => !permittedCoverageTargetIds.has(id))) {
        invalid("Outline proposal references an unavailable coverage target.");
      }
      return {
        modelSectionId,
        title: text(proposal.title, "Outline proposal title", 240),
        question: text(proposal.question, "Outline proposal question", 1_200),
        claimIds,
        coverageTargetIds,
        dependsOnSectionIds: sortedDistinct(
          proposal.dependsOnSectionIds,
          "Outline proposal dependencies",
          12,
          (value) => text(value, "Outline proposal dependency", 160),
          (id) => id,
        ),
      };
    });
    if (normalized.some((proposal) => proposal.dependsOnSectionIds.includes(proposal.modelSectionId) ||
        proposal.dependsOnSectionIds.some((id) => !modelSectionIds.has(id)))) {
      return { disposition: "rejected", reason: "invalid-dependencies", outline: clone(baseline) };
    }

    const claims = new Map<string, ResearchClaimV1>();
    for (const id of permittedClaimIds) {
      const claim = await input.claimLedger.refresh(id, input.checkedAt);
      if (!claim || claim.freshness !== "current") {
        throw new ResearchContractError("invalid-report", "Outline proposal references a claim that is no longer current.");
      }
      claims.set(id, claim);
    }
    const hostSectionIdByModelId = new Map(
      normalized.map((proposal, index) => [proposal.modelSectionId, `outline-section:planned-${index + 1}`]),
    );
    const evidenceIdsFor = (claimIds: readonly string[]): string[] => [
      ...new Set(claimIds.flatMap((id) => claims.get(id)!.evidenceIds)),
    ].sort();
    const sections: ResearchOutlineSectionV1[] = normalized.map((proposal) => ({
      id: hostSectionIdByModelId.get(proposal.modelSectionId)!,
      title: proposal.title,
      question: proposal.question,
      claimIds: proposal.claimIds,
      evidenceIds: evidenceIdsFor(proposal.claimIds),
      contradictionIds: [],
      coverageTargetIds: proposal.coverageTargetIds,
      dependsOnSectionIds: proposal.dependsOnSectionIds.map((id) => hostSectionIdByModelId.get(id)!),
    }));
    const unassignedClaimIds = [...permittedClaimIds].filter((id) => !proposedClaimIds.has(id)).sort();
    const assignedCoverageTargetIds = new Set(sections.flatMap((section) => section.coverageTargetIds));
    const unassignedCoverageTargetIds = [...permittedCoverageTargetIds]
      .filter((id) => !assignedCoverageTargetIds.has(id))
      .sort();
    const revised = unassignedClaimIds.length > 0 || unassignedCoverageTargetIds.length > 0;
    if (revised) {
      sections.push({
        id: "outline-section:host-unassigned",
        title: "Additional evidence-backed findings",
        question: "What additional evidence-backed findings matter to the question?",
        claimIds: unassignedClaimIds,
        evidenceIds: evidenceIdsFor(unassignedClaimIds),
        contradictionIds: [],
        coverageTargetIds: unassignedCoverageTargetIds,
        dependsOnSectionIds: [],
      });
    }
    return {
      disposition: revised ? "revised" : "accepted",
      reason: revised ? "host-completed-coverage" : "proposal-complete",
      outline: await createResearchOutlineV1({
        revision: baseline.revision,
        basedOnBriefRevision: baseline.basedOnBriefRevision,
        ...(baseline.supersedesOutlineId === undefined ? {} : { supersedesOutlineId: baseline.supersedesOutlineId }),
        createdAt: baseline.createdAt,
        sections,
        contradictions: baseline.contradictions,
        coverage: baseline.coverage,
      }),
    };
  } catch (error) {
    if (error instanceof ResearchContractError && error.code === "invalid-request") {
      return { disposition: "rejected", reason: "invalid-proposal", outline: clone(baseline) };
    }
    throw error;
  }
}

/**
 * Private immutable outline store. It writes a complete revision before the
 * compact current-pointer index, so a new instance recovers the previous
 * published outline if a pointer publication is interrupted.
 */
export class WorkspaceResearchOutlineStoreV1 implements ResearchOutlineStoreV1 {
  readonly #workspace: ResearchWorkspace;
  readonly #evidenceStore: ResearchEvidenceStoreV1;
  readonly #claimLedger: ResearchClaimLedgerV1;
  readonly #coverageTargets: Map<string, ResearchCoverageTargetV1>;
  #index: PersistedOutlineIndexV1 = { schema: RESEARCH_OUTLINE_STORE_INDEX_SCHEMA_V1, outlineIds: [] };
  #loaded = false;
  #tail: Promise<void> = Promise.resolve();
  #writeFailure: unknown;

  constructor(input: {
    workspace: ResearchWorkspace;
    evidenceStore: ResearchEvidenceStoreV1;
    claimLedger: ResearchClaimLedgerV1;
    coverageTargets: readonly ResearchCoverageTargetV1[];
  }) {
    this.#workspace = input.workspace;
    this.#evidenceStore = input.evidenceStore;
    this.#claimLedger = input.claimLedger;
    this.#coverageTargets = coverageTargetMap(input.coverageTargets);
  }

  async #exclusive<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.#writeFailure) throw this.#writeFailure;
      return await callback();
    } finally {
      release();
    }
  }

  async #hydrate(): Promise<void> {
    if (this.#loaded) return;
    const contents = await this.#workspace.readFile(INDEX_PATH);
    this.#index = contents === undefined
      ? { schema: RESEARCH_OUTLINE_STORE_INDEX_SCHEMA_V1, outlineIds: [] }
      : parseIndex(contents);
    this.#loaded = true;
  }

  async #persistIndex(): Promise<void> {
    const contents = JSON.stringify(this.#index);
    if (bytes(contents) > MAXIMUM_INDEX_BYTES) {
      throw new ResearchContractError("limit-exceeded", "Outline store index is too large.");
    }
    await this.#workspace.writeFile(INDEX_PATH, contents);
  }

  async #readOutline(id: string): Promise<ResearchOutlineV1 | undefined> {
    const contents = await this.#workspace.readFile(outlinePath(id));
    if (contents === undefined) return undefined;
    try {
      return parseOutline(JSON.parse(contents));
    } catch (error) {
      if (error instanceof ResearchContractError) throw error;
      invalid("Stored outline is not JSON.");
    }
  }

  async #claims(ids: readonly string[]): Promise<Map<string, ResearchClaimV1>> {
    const checkedAt = new Date().toISOString();
    const entries = await Promise.all(ids.map(async (id) => [id, await this.#claimLedger.refresh(id, checkedAt)] as const));
    const claims = new Map<string, ResearchClaimV1>();
    for (const [id, claim] of entries) {
      if (!claim) invalid("Outline references a claim that is not retained.");
      if (claim.freshness !== "current") {
        throw new ResearchContractError("invalid-report", "Outline references a claim that is not current.");
      }
      claims.set(id, claim);
    }
    return claims;
  }

  async #evidence(ids: readonly string[]): Promise<Map<string, ResearchEvidenceRecordV1>> {
    const entries = await Promise.all(ids.map(async (id) => [id, await this.#evidenceStore.get(id)] as const));
    const records = new Map<string, ResearchEvidenceRecordV1>();
    for (const [id, record] of entries) {
      if (!record) invalid("Outline references evidence that is not retained.");
      records.set(id, record);
    }
    return records;
  }

  async #validateReferences(outline: ResearchOutlineV1): Promise<ResearchOutlineV1> {
    const validated = parseOutline(outline);
    const coverageIds = new Set(validated.coverage.map((entry) => entry.targetId));
    const expectedCoverageIds = new Set(this.#coverageTargets.keys());
    if (coverageIds.size !== expectedCoverageIds.size || [...expectedCoverageIds].some((id) => !coverageIds.has(id))) {
      invalid("Outline coverage does not match the accepted brief targets.");
    }
    const allClaimIds = new Set<string>();
    const allEvidenceIds = new Set<string>();
    for (const section of validated.sections) {
      section.claimIds.forEach((id) => allClaimIds.add(id));
      section.evidenceIds.forEach((id) => allEvidenceIds.add(id));
    }
    for (const contradiction of validated.contradictions) {
      contradiction.claimIds.forEach((id) => allClaimIds.add(id));
      contradiction.evidenceIds.forEach((id) => allEvidenceIds.add(id));
    }
    for (const coverage of validated.coverage) {
      coverage.claimIds.forEach((id) => allClaimIds.add(id));
      coverage.evidenceIds.forEach((id) => allEvidenceIds.add(id));
    }
    const claims = await this.#claims([...allClaimIds]);
    for (const claim of claims.values()) claim.evidenceIds.forEach((id) => allEvidenceIds.add(id));
    const records = await this.#evidence([...allEvidenceIds]);
    if (new Set([...records.values()].map((record) => record.identity.tenantOrigin)).size > 1) {
      invalid("Outline evidence cannot mix tenants.");
    }
    const contradictions = new Map(validated.contradictions.map((entry) => [entry.id, entry]));
    for (const contradiction of validated.contradictions) {
      const permittedEvidence = new Set(contradiction.claimIds.flatMap((id) => claims.get(id)!.evidenceIds));
      if (contradiction.evidenceIds.some((id) => !permittedEvidence.has(id))) {
        invalid("Contradiction evidence is not linked to its claims.");
      }
    }
    for (const coverage of validated.coverage) {
      const target = this.#coverageTargets.get(coverage.targetId)!;
      const coverageRecords = coverage.evidenceIds.map((id) => records.get(id)!);
      const permittedEvidence = new Set(coverage.claimIds.flatMap((id) => claims.get(id)!.evidenceIds));
      if (coverage.claimIds.length > 0 && coverage.evidenceIds.some((id) => !permittedEvidence.has(id))) {
        invalid("Coverage evidence is not linked to its claims.");
      }
      const expectedStatus = expectedCoverageStatus(target, coverageRecords);
      const expectedSources = new Set(coverageRecords.map((record) => record.identity.canonicalId)).size;
      if (coverage.status !== expectedStatus || coverage.distinctSourceCount !== expectedSources) {
        invalid("Coverage assessment must be derived from retained evidence.");
      }
    }
    for (const section of validated.sections) {
      if (section.contradictionIds.some((id) => !contradictions.has(id))) invalid("Outline section references an unknown contradiction.");
      if (section.coverageTargetIds.some((id) => !expectedCoverageIds.has(id))) invalid("Outline section references an unknown coverage target.");
      const permittedEvidence = new Set(section.claimIds.flatMap((id) => claims.get(id)!.evidenceIds));
      if (section.evidenceIds.some((id) => !permittedEvidence.has(id))) {
        invalid("Outline section evidence is not linked to its claims.");
      }
      const openClaimIds = new Set(section.contradictionIds
        .map((id) => contradictions.get(id)!)
        .filter((contradiction) => contradiction.status === "open")
        .flatMap((contradiction) => contradiction.claimIds));
      if (section.claimIds.some((id) => openClaimIds.has(id))) {
        invalid("Outline section cannot publish a claim with an open contradiction.");
      }
      const unknownOpenContradiction = validated.contradictions.find((contradiction) =>
        contradiction.status === "open" && contradiction.claimIds.some((id) => section.claimIds.includes(id)) && !section.contradictionIds.includes(contradiction.id),
      );
      if (unknownOpenContradiction) {
        invalid("Outline section cannot use a claim affected by an open contradiction.");
      }
    }
    return validated;
  }

  async put(outline: ResearchOutlineV1): Promise<ResearchOutlineV1> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const validated = await this.#validateReferences(outline);
      const existing = await this.#readOutline(validated.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(validated)) invalid("Outline ID collides with a different revision.");
        return clone(existing);
      }
      if (this.#index.outlineIds.length >= MAXIMUM_OUTLINES) {
        throw new ResearchContractError("limit-exceeded", "Outline store limit is exhausted.");
      }
      const previous = this.#index.currentOutlineId === undefined
        ? undefined
        : await this.#readOutline(this.#index.currentOutlineId);
      if (this.#index.currentOutlineId !== undefined && !previous) invalid("Outline index references a missing outline.");
      if (!previous) {
        if (validated.revision !== 1 || validated.supersedesOutlineId !== undefined) {
          invalid("The first outline must be revision one without a predecessor.");
        }
      } else if (validated.revision !== previous.revision + 1 || validated.supersedesOutlineId !== previous.id) {
        invalid("Outline revisions must directly supersede the current revision.");
      }
      try {
        await this.#workspace.writeFile(outlinePath(validated.id), JSON.stringify(validated));
        this.#index = {
          schema: RESEARCH_OUTLINE_STORE_INDEX_SCHEMA_V1,
          outlineIds: [...this.#index.outlineIds, validated.id].sort(),
          currentOutlineId: validated.id,
        };
        await this.#persistIndex();
      } catch (error) {
        this.#writeFailure = error;
        throw error;
      }
      return clone(validated);
    });
  }

  async get(id: string): Promise<ResearchOutlineV1 | undefined> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const validatedId = outlineId(id);
      if (!this.#index.outlineIds.includes(validatedId)) return undefined;
      const outline = await this.#readOutline(validatedId);
      if (!outline) invalid("Outline index references a missing outline.");
      return clone(outline);
    });
  }

  async current(): Promise<ResearchOutlineV1 | undefined> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      if (!this.#index.currentOutlineId) return undefined;
      const outline = await this.#readOutline(this.#index.currentOutlineId);
      if (!outline) invalid("Outline index references a missing outline.");
      return clone(outline);
    });
  }

  async validateCurrent(): Promise<ResearchOutlineV1 | undefined> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      if (!this.#index.currentOutlineId) return undefined;
      const outline = await this.#readOutline(this.#index.currentOutlineId);
      if (!outline) invalid("Outline index references a missing outline.");
      return clone(await this.#validateReferences(outline));
    });
  }

  async list(input: { limit?: number; cursor?: string } = {}): Promise<{ outlines: ResearchOutlineV1[]; nextCursor?: string }> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      const limit = input.limit === undefined ? 100 : positiveInteger(input.limit, "Outline list limit", MAXIMUM_OUTLINES);
      const cursor = input.cursor === undefined ? undefined : outlineId(input.cursor);
      const start = cursor === undefined ? 0 : this.#index.outlineIds.indexOf(cursor) + 1;
      if (cursor !== undefined && start === 0) invalid("Outline list cursor is invalid.");
      const ids = this.#index.outlineIds.slice(start, start + limit);
      const outlines: ResearchOutlineV1[] = [];
      for (const id of ids) {
        const outline = await this.#readOutline(id);
        if (!outline) invalid("Outline index references a missing outline.");
        outlines.push(clone(outline));
      }
      return { outlines, ...(start + limit < this.#index.outlineIds.length ? { nextCursor: ids.at(-1)! } : {}) };
    });
  }

  async clear(): Promise<void> {
    return this.#exclusive(async () => {
      await this.#hydrate();
      try {
        await this.#workspace.remove(ROOT_PATH);
        this.#index = { schema: RESEARCH_OUTLINE_STORE_INDEX_SCHEMA_V1, outlineIds: [] };
        this.#loaded = true;
      } catch (error) {
        this.#writeFailure = error;
        throw error;
      }
    });
  }
}
