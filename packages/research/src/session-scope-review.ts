import type { ResearchPlanDiffV1, ResearchGraphV1 } from "./graph.js";
import type { ResearchScopeBindingV1 } from "./contracts.js";
import type { ResearchScopeCandidateV1 } from "./scope-discovery.js";
import type {
  ResearchSessionScopeRevisionV1,
  ResearchSessionStatusV1,
  ResearchSessionTurnV1,
  ResearchSessionV1,
} from "./session.js";

/**
 * A tenant-filtered, body-free projection for reviewing a persisted scope
 * expansion. It deliberately omits the tenant origin, entity reference,
 * source bodies, packet bodies, task prompts, provider data, and model
 * trajectories. A host must still bind the projection to its active tenant
 * before it presents an approval control.
 */
export const RESEARCH_SESSION_SCOPE_REVIEW_SCHEMA_V1 =
  "atlcli.research-session-scope-review/v1" as const;

export interface ResearchSessionScopeReviewCandidateV1 {
  id: string;
  product: ResearchScopeCandidateV1["product"];
  entityKind: ResearchScopeCandidateV1["entityKind"];
  key?: string;
  name: string;
  canonicalUrl?: string;
  status?: "current" | "archived";
  match?: "exact_key" | "exact_name" | "alias" | "current_context" | "exact_link" | "prefix" | "fuzzy";
}

export interface ResearchSessionScopeReviewBindingV1 {
  id: string;
  product: ResearchScopeBindingV1["product"];
  entityKind: ResearchScopeBindingV1["entityKind"];
  key?: string;
  name: string;
  source: ResearchScopeBindingV1["source"];
  authority: ResearchScopeBindingV1["authority"];
  candidateId?: string;
  approvedAt?: string;
}

export interface ResearchSessionScopeReviewProposalV1 {
  id: string;
  candidateId: string;
  expansionKind: "exact_entity" | "whole_scope";
  basedOnBriefRevision: number;
  basedOnGraphRevision: number;
  reason: string;
  status: "proposed" | "approved" | "rejected" | "expired";
  approvedBindingId?: string;
}

/** Body-free central-supervisor outcome for a discovered related candidate. */
export interface ResearchSessionScopeReviewDiscoveryDispositionV1 {
  id: string;
  discoveryId: string;
  candidateId: string;
  decision: "accept_metadata" | "reject" | "propose_exact_entity" | "propose_whole_scope";
  reasonCode: "metadata_sufficient" | "not_material" | "out_of_scope" | "insufficient_budget" | "coverage_gap" | "exact_reference";
  coverageGapId?: string;
  proposedExpansionId?: string;
  recordedAt: string;
}

export interface ResearchSessionScopeReviewRevisionV1 {
  id: string;
  proposalId: string;
  basedOnBriefRevision: number;
  basedOnGraphRevision: number;
  revisedBriefRevision: number;
  proposedGraphRevision?: number;
  state: "proposed" | "approved";
  planDiff?: ResearchPlanDiffV1;
}

export interface ResearchSessionScopeReviewV1 {
  schema: typeof RESEARCH_SESSION_SCOPE_REVIEW_SCHEMA_V1;
  sessionId: string;
  revision: number;
  status: ResearchSessionStatusV1;
  updatedAt: string;
  turn: {
    id: string;
    briefRevision: number;
    graphRevision: number;
    candidates: ResearchSessionScopeReviewCandidateV1[];
    bindings: ResearchSessionScopeReviewBindingV1[];
    discoveryDispositions: ResearchSessionScopeReviewDiscoveryDispositionV1[];
    expansionProposals: ResearchSessionScopeReviewProposalV1[];
    scopeRevisions: ResearchSessionScopeReviewRevisionV1[];
  };
}

function activeTurn(session: ResearchSessionV1): ResearchSessionTurnV1 | undefined {
  return session.turns.find((turn) => turn.id === session.activeTurnId) ?? session.turns.at(-1);
}

function projectGraphRevision(graph: ResearchGraphV1 | undefined): number | undefined {
  return graph?.revision;
}

function projectScopeRevision(
  revision: ResearchSessionScopeRevisionV1,
): ResearchSessionScopeReviewRevisionV1 {
  return {
    id: revision.id,
    proposalId: revision.proposalId,
    basedOnBriefRevision: revision.basedOnBriefRevision,
    basedOnGraphRevision: revision.basedOnGraphRevision,
    revisedBriefRevision: revision.revisedBriefRevision,
    ...(revision.proposedGraphRevision === undefined
      ? {}
      : { proposedGraphRevision: revision.proposedGraphRevision }),
    state: revision.state,
    ...(revision.planDiff === undefined ? {} : { planDiff: revision.planDiff }),
  };
}

/**
 * Project a session only when its accepted brief belongs to the host's active
 * tenant. An unfinished turn without both a brief and graph cannot expose a
 * scope approval because its revision fence would be ambiguous.
 */
export function projectResearchSessionScopeReviewV1(
  session: ResearchSessionV1,
  expectedTenantOrigin: string,
): ResearchSessionScopeReviewV1 | undefined {
  const turn = activeTurn(session);
  const graphRevision = projectGraphRevision(turn?.graph);
  if (!turn?.brief || graphRevision === undefined || turn.brief.scope.siteOrigin !== expectedTenantOrigin) {
    return undefined;
  }
  return {
    schema: RESEARCH_SESSION_SCOPE_REVIEW_SCHEMA_V1,
    sessionId: session.sessionId,
    revision: session.revision,
    status: session.status,
    updatedAt: session.updatedAt,
    turn: {
      id: turn.id,
      briefRevision: turn.brief.revision,
      graphRevision,
      candidates: turn.scopeCandidates.map((candidate) => ({
        id: candidate.id,
        product: candidate.product,
        entityKind: candidate.entityKind,
        ...(candidate.key === undefined ? {} : { key: candidate.key }),
        name: candidate.name,
        ...(candidate.canonicalUrl === undefined
          ? {}
          : { canonicalUrl: candidate.canonicalUrl }),
        ...(candidate.status === undefined ? {} : { status: candidate.status }),
        ...(candidate.match === undefined ? {} : { match: candidate.match }),
      })),
      bindings: turn.scopeBindings.map((binding) => ({
        id: binding.id,
        product: binding.product,
        entityKind: binding.entityKind,
        ...(binding.key === undefined ? {} : { key: binding.key }),
        name: binding.name,
        source: binding.source,
        authority: binding.authority,
        ...(binding.candidateId === undefined ? {} : { candidateId: binding.candidateId }),
        ...(binding.approvedAt === undefined ? {} : { approvedAt: binding.approvedAt }),
      })),
      discoveryDispositions: (turn.scopeDiscoveryDispositions ?? []).map((disposition) => ({
        id: disposition.id,
        discoveryId: disposition.discoveryId,
        candidateId: disposition.candidateId,
        decision: disposition.decision,
        reasonCode: disposition.reasonCode,
        ...(disposition.coverageGapId === undefined
          ? {}
          : { coverageGapId: disposition.coverageGapId }),
        ...(disposition.proposedExpansionId === undefined
          ? {}
          : { proposedExpansionId: disposition.proposedExpansionId }),
        recordedAt: disposition.recordedAt,
      })),
      expansionProposals: turn.scopeExpansionProposals.map((proposal) => ({
        id: proposal.id,
        candidateId: proposal.candidateId,
        expansionKind: proposal.expansionKind,
        basedOnBriefRevision: proposal.basedOnBriefRevision,
        basedOnGraphRevision: proposal.basedOnGraphRevision,
        reason: proposal.reason,
        status: proposal.status,
        ...(proposal.approvedBindingId === undefined
          ? {}
          : { approvedBindingId: proposal.approvedBindingId }),
      })),
      scopeRevisions: (turn.scopeRevisions ?? []).map(projectScopeRevision),
    },
  };
}
