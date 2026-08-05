import type { Profile } from "@atlcli/core";
import {
  ResearchRunBudget,
  RESEARCH_PACKET_BODY_SCHEMA_V2,
  ResearchScopeCatalogBroker,
  ResearchContractError,
  classifyResearchError,
  createRestResearchProviders,
  createRestScopeCatalogProviders,
  normalizeResearchOneShotPolicyV1,
  normalizeChatQualityPolicyV1,
  normalizeResearchRequestV1,
  prepareDirectChatRequestV1,
  prepareResearchBriefPreflightV1,
  researchPolicyFromBriefV1,
  researchRequestFromBriefV1,
  IndexedDbResearchSessionStoreV1,
  createResearchSessionV1,
  initializeResearchSessionTurnV1,
  type ResearchBriefV1,
  type ResearchOneShotEventV1,
  type ResearchOneShotPolicyV1,
  type ResearchProgressV1,
  type ResearchRequestV1,
  type ResearchSessionV1,
  type ChatTurnRequestV1,
} from "@atlcli/research/browser";
import { runChatAgent, runResearchAgent } from "@atlcli/research/browser/agent";
import {
  assertResearchGraphExecutableV1,
  composeResearchGraphV1,
  createStandardResearchBriefV1,
  type ResearchGraphV1,
} from "@atlcli/research/graph";
import type {
  ResearchWorkerRequestV1,
  ResearchWorkerResponseV1,
} from "../utils/research/worker-protocol.js";
import { openDurableChatConversationWorkspaceV1 } from "../utils/research/chat-conversation.js";

function post(message: ResearchWorkerResponseV1): void {
  globalThis.postMessage(message);
}

globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data as Partial<ResearchWorkerRequestV1> | null;
  if (
    !message ||
    message.kind !== "research-worker:run" ||
    typeof message.runId !== "string" ||
    typeof message.sessionId !== "string" ||
    typeof message.turnId !== "string" ||
    typeof message.apiKey !== "string"
  ) {
    return;
  }
  const runId = message.runId;
  const sessionId = message.sessionId;
  const turnId = message.turnId;
  const apiKey = message.apiKey;
  const resume = message.resume === true;
  void (async () => {
    try {
      if (!resume && "mode" in message && message.mode === "chat") {
        if (!("request" in message)) {
          throw new ResearchContractError("invalid-request", "A direct chat run requires a request.");
        }
        const request = prepareDirectChatRequestV1(
          normalizeResearchRequestV1(message.request),
        );
        const profile: Profile = {
          name: "chat-session",
          baseUrl: request.scope.siteOrigin,
          deploymentType: "cloud",
          auth: { type: "session" },
        };
        const budget = new ResearchRunBudget(request.limits);
        const providers = createRestResearchProviders(profile, request, budget);
        const onProgress = (progress: ResearchProgressV1): void =>
          post({ kind: "research-worker:progress", runId, progress });
        const onEvent = (event: ResearchOneShotEventV1): void =>
          post({ kind: "research-worker:event", runId, event });
        const store = await IndexedDbResearchSessionStoreV1.open();
        try {
          const now = new Date().toISOString();
          const workspace = await openDurableChatConversationWorkspaceV1({
            store,
            sessionId,
            ownerId: `owner:browser-chat-${runId}`,
            createdAt: now,
            leaseExpiresAt: new Date(
              Date.parse(now) + request.limits.maxRunMs,
            ).toISOString(),
          });
          const turn: ChatTurnRequestV1 = {
            schema: "atlcli.chat-turn-request/v1",
            conversationId: sessionId,
            turnId,
            question: request.question,
            scope: request.scope,
            limits: request.limits,
            wikiProvider: request.wikiProvider,
            ...(request.scopeSeeds ? { scopeSeeds: request.scopeSeeds } : {}),
            ...(request.exactContextProducts
              ? { exactContextProducts: request.exactContextProducts }
              : {}),
          };
          const answer = await runChatAgent({
            apiKey,
            turn,
            brokerRequest: request,
            providers,
            budget,
            workspace,
            ...(message.qualityPolicy
              ? { qualityPolicy: normalizeChatQualityPolicyV1(message.qualityPolicy) }
              : {}),
            onProgress,
            onEvent,
          });
          post({ kind: "research-worker:complete", runId, answer });
        } finally {
          store.close();
        }
        return;
      }
      const store = await IndexedDbResearchSessionStoreV1.open();
      try {
        let request: ResearchRequestV1;
        let policy: ResearchOneShotPolicyV1;
        let brief: ResearchBriefV1;
        let researchGraph: ResearchGraphV1;
        let durableSession: ResearchSessionV1;
        if (resume) {
          const persisted = await store.read(sessionId);
          const turn = persisted?.turns.find((candidate) => candidate.id === turnId);
          if (!persisted || persisted.status !== "running" ||
              persisted.activeTurnId !== turnId ||
              persisted.lease.ownerId !== `owner:browser-${runId}` ||
              !turn?.brief || !turn.graph) {
            throw new ResearchContractError(
              "invalid-request",
              "The browser resume does not own a runnable durable research turn.",
            );
          }
          request = researchRequestFromBriefV1(turn.brief);
          policy = researchPolicyFromBriefV1(turn.brief);
          brief = turn.brief;
          researchGraph = turn.graph;
          durableSession = persisted;
        } else {
          if (!("request" in message)) {
            throw new ResearchContractError("invalid-request", "A new research worker run requires a request.");
          }
          request = normalizeResearchRequestV1(message.request);
          policy = normalizeResearchOneShotPolicyV1(message.policy);
          const briefOutcome = prepareResearchBriefPreflightV1(createStandardResearchBriefV1(request.question, {
            sessionId,
            turnId,
            scope: request.scope,
            scopeBindings: request.scopeSeeds?.map((seed) => seed.binding),
            limits: request.limits,
            asOf: new Date().toISOString(),
            policy,
          }));
          if (briefOutcome.kind === "clarification_required") {
            throw new ResearchContractError(
              "clarification-required",
              "Research brief requires clarification before graph composition.",
            );
          }
          brief = briefOutcome.brief;
          researchGraph = composeResearchGraphV1(brief, {
            packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
          });
          assertResearchGraphExecutableV1(researchGraph);
          const now = new Date().toISOString();
          durableSession = await initializeResearchSessionTurnV1({
            store,
            session: createResearchSessionV1({
              sessionId,
              ownerId: `owner:browser-${runId}`,
              createdAt: now,
              leaseExpiresAt: new Date(Date.parse(now) + request.limits.maxRunMs).toISOString(),
            }),
            brief,
            graph: researchGraph,
            approveAutomatically: true,
            at: now,
          });
        }
        if (durableSession.status !== "running") {
          throw new ResearchContractError(
            "plan-approval-required",
            "Research plan requires approval before execution.",
          );
        }
        const profile: Profile = {
          name: "research-session",
          baseUrl: request.scope.siteOrigin,
          deploymentType: "cloud",
          auth: { type: "session" },
        };
        const budget = new ResearchRunBudget(request.limits);
        const providers = createRestResearchProviders(profile, request, budget);
        const scopeCatalog = {
          tenantOrigin: request.scope.siteOrigin,
          broker: new ResearchScopeCatalogBroker({
            tenantOrigin: request.scope.siteOrigin,
            providers: createRestScopeCatalogProviders(profile, request.scope.siteOrigin),
          }),
        };
        const workspace = await store.workspace(sessionId);
        const onProgress = (progress: ResearchProgressV1): void =>
          post({ kind: "research-worker:progress", runId, progress });
        const onEvent = (event: ResearchOneShotEventV1): void =>
          post({ kind: "research-worker:event", runId, event });
        const report = await runResearchAgent({
          apiKey,
          request,
          providers,
          budget,
          scopeCatalog,
          runId,
          researchGraph,
          brief,
          workspace,
          durableSession: {
            store,
            sessionId,
            turnId,
          },
          options: { onProgress, onEvent, policy },
        });
        post({ kind: "research-worker:complete", runId, report });
      } finally {
        store.close();
      }
    } catch (error) {
      const classified = classifyResearchError(error);
      post({
        kind: "research-worker:error",
        runId,
        code: classified.code,
        error: classified.message,
      });
    }
  })();
});
