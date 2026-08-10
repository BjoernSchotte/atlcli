import {
  normalizeResearchRequestV1,
  type ResearchRequestV1,
} from "../contracts.js";
import type {
  ResearchScopeCandidateSelectionV1,
} from "../scope-resolution.js";
import type {
  ResearchSessionV1,
} from "../session.js";
import type { ResearchSessionStoreV1 } from "../session-store.js";

export const CHAT_SCOPE_CLARIFICATION_REVIEW_SCHEMA_V1 =
  "atlcli.chat-scope-clarification-review/v1" as const;

export interface ChatScopeClarificationReviewV1 {
  schema: typeof CHAT_SCOPE_CLARIFICATION_REVIEW_SCHEMA_V1;
  sessionId: string;
  revision: number;
  status: "waiting_scope_clarification";
  updatedAt: string;
  clarification: {
    mentionId: string;
    reason: "ambiguous" | "weak_match" | "archived_only" | "unavailable" | "incomplete" | "not_found";
    rerunGuidance: string[];
    candidates: Array<{
      id: string;
      product: "jira" | "confluence";
      entityKind: "project" | "space" | "issue" | "page";
      key?: string;
      name: string;
      canonicalUrl?: string;
      status?: "current" | "archived";
    }>;
  };
}

export function projectChatScopeClarificationReviewV1(
  session: ResearchSessionV1,
  expectedTenantOrigin: string,
): ChatScopeClarificationReviewV1 | undefined {
  const state = session.scopeClarification;
  if (session.status !== "waiting_scope_clarification" ||
      session.activeTurnId || state?.state !== "waiting_choice" ||
      state.purpose !== "chat" ||
      state.request.scope.siteOrigin !== expectedTenantOrigin) {
    return undefined;
  }
  return {
    schema: CHAT_SCOPE_CLARIFICATION_REVIEW_SCHEMA_V1,
    sessionId: session.sessionId,
    revision: session.revision,
    status: "waiting_scope_clarification",
    updatedAt: session.updatedAt,
    clarification: {
      mentionId: state.clarification.mentionId,
      reason: state.clarification.reason,
      rerunGuidance: [...state.clarification.rerunGuidance],
      candidates: state.candidateChoices.map((candidate) => ({
        id: candidate.id,
        product: candidate.product,
        entityKind: candidate.entityKind,
        ...(candidate.key === undefined ? {} : { key: candidate.key }),
        name: candidate.name,
        ...(candidate.canonicalUrl === undefined ? {} : { canonicalUrl: candidate.canonicalUrl }),
        ...(candidate.status === undefined ? {} : { status: candidate.status }),
      })),
    },
  };
}

/**
 * Accept one freshly catalog-validated choice and turn the durable
 * clarification aggregate into the ordinary Chat conversation. Reusing the
 * same aggregate keeps the selected scope, Chat checkpointer, and host-owned
 * conversation identity atomic and does not consume a second store slot. No
 * Research brief, graph, worker, or report is constructed.
 */
export async function resolveChatScopeClarificationV1(input: {
  store: ResearchSessionStoreV1;
  sessionId: string;
  expectedRevision: number;
  expectedLeaseEpoch: number;
  selection: ResearchScopeCandidateSelectionV1;
  resolvedRequest: ResearchRequestV1;
  at: string;
}): Promise<{ request: ResearchRequestV1; conversationSession: ResearchSessionV1 }> {
  const current = await input.store.read(input.sessionId);
  if (!current || current.revision !== input.expectedRevision ||
      current.lease.epoch !== input.expectedLeaseEpoch ||
      current.status !== "waiting_scope_clarification" ||
      current.scopeClarification?.purpose !== "chat") {
    throw new Error("Chat scope clarification revision or lease epoch is stale.");
  }
  const request = normalizeResearchRequestV1(input.resolvedRequest);
  const resolved = (await input.store.commit(input.sessionId, {
    kind: "resolve_scope_clarification",
    selection: input.selection,
    resolvedRequest: request,
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at: input.at,
  })).session;
  return { request, conversationSession: resolved };
}
