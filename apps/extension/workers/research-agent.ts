import type { Profile } from "@atlcli/core";
import {
  ResearchRunBudget,
  ResearchScopeCatalogBroker,
  ResearchContractError,
  classifyResearchError,
  createRestResearchProviders,
  createRestScopeCatalogProviders,
  normalizeResearchOneShotPolicyV1,
  normalizeResearchRequestV1,
  prepareResearchBriefPreflightV1,
  IndexedDbResearchSessionStoreV1,
  createResearchSessionV1,
  initializeResearchSessionTurnV1,
  type ResearchOneShotEventV1,
  type ResearchProgressV1,
} from "@atlcli/research/browser";
import { runResearchAgent } from "@atlcli/research/browser/agent";
import {
  assertResearchGraphExecutableV1,
  composeResearchGraphV1,
  createStandardResearchBriefV1,
} from "@atlcli/research/graph";
import type {
  ResearchWorkerRequestV1,
  ResearchWorkerResponseV1,
} from "../utils/research/worker-protocol.js";

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
  void (async () => {
    try {
      const request = normalizeResearchRequestV1(message.request);
      const policy = normalizeResearchOneShotPolicyV1(message.policy);
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
      const researchGraph = composeResearchGraphV1(briefOutcome.brief);
      assertResearchGraphExecutableV1(researchGraph);
      const store = await IndexedDbResearchSessionStoreV1.open();
      try {
        const now = new Date().toISOString();
        const durableSession = await initializeResearchSessionTurnV1({
          store,
          session: createResearchSessionV1({
            sessionId,
            ownerId: `owner:browser-${runId}`,
            createdAt: now,
            leaseExpiresAt: new Date(Date.parse(now) + request.limits.maxRunMs).toISOString(),
          }),
          brief: briefOutcome.brief,
          graph: researchGraph,
          approveAutomatically: true,
          at: now,
        });
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
          brief: briefOutcome.brief,
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
