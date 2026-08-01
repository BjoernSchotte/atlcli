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
  type ResearchPacketBodyV2,
} from "./workflow-contracts.js";

function evidenceIdsForClaims(claims: readonly ResearchClaimV1[]): string[] {
  return [...new Set(claims.flatMap((claim) => claim.evidenceIds))].sort();
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
    gaps: modelBody.gaps,
    proposedFollowUps: modelBody.proposedFollowUps,
    coverageLimits: modelBody.coverageLimits,
    ...(modelBody.abstentionReason === undefined
      ? {}
      : { abstentionReason: modelBody.abstentionReason }),
  });
}
