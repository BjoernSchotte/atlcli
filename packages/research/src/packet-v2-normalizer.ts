import type { ResearchDetailEvidenceV1 } from "./broker.js";
import { ResearchContractError } from "./contracts.js";
import {
  normalizeResearchClaimCandidatesV2,
} from "./claim-candidate-normalizer.js";
import type { ResearchClaimLedgerV1, ResearchClaimV1 } from "./claim-ledger.js";
import type { ResearchEvidenceStoreV1 } from "./evidence-store.js";
import {
  RESEARCH_PACKET_BODY_SCHEMA_V2,
  parseResearchPacketBodyV2,
  parseResearchPacketModelBodyV2,
  parseResearchPacketReferenceModelBodyV2,
  type ResearchPacketBodyV2,
} from "./workflow-contracts.js";

function evidenceIdsForClaims(claims: readonly ResearchClaimV1[]): string[] {
  return [...new Set(claims.flatMap((claim) => claim.evidenceIds))].sort();
}

function retainHostAdmittedSourceIds<T extends { sourceIds: string[] }>(
  values: readonly T[],
  allowedSourceIds: ReadonlySet<string>,
): { values: T[]; omitted: boolean } {
  let omitted = false;
  return {
    values: values.map((value) => {
      const sourceIds = value.sourceIds.filter((sourceId) => allowedSourceIds.has(sourceId));
      if (sourceIds.length !== value.sourceIds.length) omitted = true;
      return { ...value, sourceIds };
    }),
    omitted,
  };
}

function coverageLimitsWithOmittedReferences(
  coverageLimits: readonly string[],
  omitted: boolean,
): string[] {
  if (!omitted) return [...coverageLimits];
  const limit = "One or more model-proposed evidence references were outside the host-admitted detail set and were omitted.";
  return [...coverageLimits.filter((candidate) => candidate !== limit).slice(0, 15), limit];
}

/**
 * Crosses the model/host trust boundary for the V2 research packet.
 *
 * The model output is parsed only as an ephemeral quote-bearing candidate.
 * The host resolves every quote to current private evidence, persists only
 * span-verified claims, then derives the journal-safe packet from those
 * claims. The return type intentionally has no quote-bearing fields.
 */
export async function normalizeResearchPacketModelBodyV2(input: {
  modelBody: unknown;
  detailEvidence: readonly ResearchDetailEvidenceV1[];
  evidenceStore: ResearchEvidenceStoreV1;
  claimLedger: ResearchClaimLedgerV1;
  createdAt: string;
}): Promise<ResearchPacketBodyV2> {
  const modelBody = parseResearchPacketModelBodyV2(input.modelBody);
  const allowedSourceIds = new Set(input.detailEvidence.map((detail) => detail.source.id));
  const gaps = retainHostAdmittedSourceIds(modelBody.gaps, allowedSourceIds);
  const proposedFollowUps = retainHostAdmittedSourceIds(
    modelBody.proposedFollowUps,
    allowedSourceIds,
  );
  const normalizedClaims = await normalizeResearchClaimCandidatesV2({
    candidates: modelBody.claimCandidates,
    detailEvidence: input.detailEvidence,
    evidenceStore: input.evidenceStore,
    claimLedger: input.claimLedger,
    createdAt: input.createdAt,
  });
  const claimsByCandidateId = new Map(
    normalizedClaims.map(({ candidateId, claim }) => [candidateId, claim] as const),
  );
  const claimsFor = (candidateIds: readonly string[]): ResearchClaimV1[] =>
    candidateIds.map((candidateId) => {
      const claim = claimsByCandidateId.get(candidateId);
      if (!claim) {
        // The parser establishes this condition. Retain a guard at the trust
        // boundary in case a future normalizer changes candidate handling.
        throw new ResearchContractError(
          "invalid-report",
          "Research V2 packet lost a normalized claim candidate.",
        );
      }
      return claim;
    });

  return parseResearchPacketBodyV2({
    schema: RESEARCH_PACKET_BODY_SCHEMA_V2,
    claims: normalizedClaims.map(({ candidateId, claim }) => ({
      candidateId,
      claimId: claim.id,
    })),
    referencedClaimIds: [],
    contradictions: modelBody.contradictionCandidates.map((candidate) => {
      const claims = claimsFor(candidate.claimCandidateIds);
      return {
        id: candidate.id,
        claimIds: claims.map((claim) => claim.id),
        evidenceIds: evidenceIdsForClaims(claims),
        summary: candidate.summary,
      };
    }),
    outlineProposals: modelBody.outlineProposals.map((proposal) => {
      const claims = claimsFor(proposal.claimCandidateIds);
      return {
        id: proposal.id,
        sectionId: proposal.sectionId,
        title: proposal.title,
        question: proposal.question,
        claimIds: claims.map((claim) => claim.id),
        evidenceIds: evidenceIdsForClaims(claims),
        dependsOnSectionIds: proposal.dependsOnSectionIds,
        coverageTargetIds: proposal.coverageTargetIds,
      };
    }),
    gaps: gaps.values,
    proposedFollowUps: proposedFollowUps.values,
    coverageLimits: coverageLimitsWithOmittedReferences(
      modelBody.coverageLimits,
      gaps.omitted || proposedFollowUps.omitted,
    ),
    ...(modelBody.abstentionReason === undefined
      ? {}
      : { abstentionReason: modelBody.abstentionReason }),
  });
}

/**
 * Preserve the evidence boundary when a syntactically valid worker packet
 * contains a claim whose proposed quote cannot be verified. The caller may
 * continue with a clearly labelled abstention, but it must never retain the
 * rejected claim, its derived contradiction, or its outline proposal.
 */
export function createHostValidationAbstentionPacketV2(
  modelBody: unknown,
  allowedSourceIds: readonly string[] = [],
): ResearchPacketBodyV2 {
  const parsed = parseResearchPacketModelBodyV2(modelBody);
  const allowed = new Set(allowedSourceIds);
  const gaps = retainHostAdmittedSourceIds(parsed.gaps, allowed);
  const proposedFollowUps = retainHostAdmittedSourceIds(parsed.proposedFollowUps, allowed);
  const existingGapIds = new Set(parsed.gaps.map((gap) => gap.id));
  const baseGapId = "gap:host-claim-validation";
  let suffix = 1;
  let gapId = baseGapId;
  while (existingGapIds.has(gapId)) {
    suffix += 1;
    gapId = `${baseGapId}-${suffix}`;
  }
  const coverageLimit = "One or more proposed claims failed host exact-evidence validation and were omitted.";
  return parseResearchPacketBodyV2({
    schema: RESEARCH_PACKET_BODY_SCHEMA_V2,
    claims: [],
    referencedClaimIds: [],
    contradictions: [],
    outlineProposals: [],
    gaps: [
      ...gaps.values.slice(0, 15),
      {
        id: gapId,
        summary: "Proposed claim support did not pass host exact-evidence validation.",
        sourceIds: [],
      },
    ],
    proposedFollowUps: proposedFollowUps.values,
    coverageLimits: [
      ...coverageLimitsWithOmittedReferences(
        parsed.coverageLimits,
        gaps.omitted || proposedFollowUps.omitted,
      ).slice(0, 15),
      coverageLimit,
    ],
    abstentionReason: "No claim candidate passed host exact-evidence validation.",
  });
}

/**
 * Normalizes an analysis-only V2 response. It may carry forward only current
 * claims that were present in the host-projected dependency envelope; all
 * evidence IDs for contradictions and outline proposals are derived again by
 * the host from those claims.
 */
export async function normalizeResearchPacketReferenceModelBodyV2(input: {
  modelBody: unknown;
  allowedClaimIds: readonly string[];
  allowedSourceIds: readonly string[];
  claimLedger: ResearchClaimLedgerV1;
  checkedAt: string;
}): Promise<ResearchPacketBodyV2> {
  const modelBody = parseResearchPacketReferenceModelBodyV2(input.modelBody);
  const allowed = new Set(input.allowedClaimIds);
  const allowedSources = new Set(input.allowedSourceIds);
  const gaps = retainHostAdmittedSourceIds(modelBody.gaps, allowedSources);
  const proposedFollowUps = retainHostAdmittedSourceIds(
    modelBody.proposedFollowUps,
    allowedSources,
  );
  const claimsById = new Map<string, ResearchClaimV1>();
  for (const claimId of modelBody.claimIds) {
    if (!allowed.has(claimId)) {
      throw new ResearchContractError(
        "invalid-report",
        "A V2 analysis packet references a claim outside its admitted dependencies.",
      );
    }
    const claim = await input.claimLedger.refresh(claimId, input.checkedAt);
    if (!claim || claim.freshness !== "current") {
      throw new ResearchContractError(
        "invalid-report",
        "A V2 analysis packet references a missing or non-current claim.",
      );
    }
    claimsById.set(claimId, claim);
  }
  const claimsFor = (claimIds: readonly string[]): ResearchClaimV1[] =>
    claimIds.map((claimId) => {
      const claim = claimsById.get(claimId);
      if (!claim) {
        throw new ResearchContractError(
          "invalid-report",
          "A V2 analysis proposal references a claim outside its packet.",
        );
      }
      return claim;
    });

  return parseResearchPacketBodyV2({
    schema: RESEARCH_PACKET_BODY_SCHEMA_V2,
    claims: [],
    referencedClaimIds: modelBody.claimIds,
    contradictions: modelBody.contradictions.map((contradiction) => {
      const claims = claimsFor(contradiction.claimIds);
      return {
        id: contradiction.id,
        claimIds: contradiction.claimIds,
        evidenceIds: evidenceIdsForClaims(claims),
        summary: contradiction.summary,
      };
    }),
    outlineProposals: modelBody.outlineProposals.map((proposal) => {
      const claims = claimsFor(proposal.claimIds);
      return {
        id: proposal.id,
        sectionId: proposal.sectionId,
        title: proposal.title,
        question: proposal.question,
        claimIds: proposal.claimIds,
        evidenceIds: evidenceIdsForClaims(claims),
        dependsOnSectionIds: proposal.dependsOnSectionIds,
        coverageTargetIds: proposal.coverageTargetIds,
      };
    }),
    gaps: gaps.values,
    proposedFollowUps: proposedFollowUps.values,
    coverageLimits: coverageLimitsWithOmittedReferences(
      modelBody.coverageLimits,
      gaps.omitted || proposedFollowUps.omitted,
    ),
    ...(modelBody.abstentionReason === undefined
      ? {}
      : { abstentionReason: modelBody.abstentionReason }),
  });
}
