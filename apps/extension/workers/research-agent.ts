import type { Profile } from "@atlcli/core";
import {
  ResearchRunBudget,
  classifyResearchError,
  createRestResearchProviders,
  normalizeResearchRequestV1,
  createMemoryResearchWorkspace,
  type ResearchOneShotEventV1,
  type ResearchProgressV1,
} from "@atlcli/research/browser";
import { runResearchAgent } from "@atlcli/research/browser/agent";
import { composeStandardResearchGraphV1 } from "@atlcli/research/graph";
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
    typeof message.apiKey !== "string"
  ) {
    return;
  }
  const runId = message.runId;
  void (async () => {
    try {
      const request = normalizeResearchRequestV1(message.request);
      const profile: Profile = {
        name: "research-session",
        baseUrl: request.scope.siteOrigin,
        deploymentType: "cloud",
        auth: { type: "session" },
      };
      const budget = new ResearchRunBudget(request.limits);
      const providers = createRestResearchProviders(profile, request, budget);
      const researchGraph = composeStandardResearchGraphV1(request.question);
      const workspace = createMemoryResearchWorkspace();
      const onProgress = (progress: ResearchProgressV1): void =>
        post({ kind: "research-worker:progress", runId, progress });
      const onEvent = (event: ResearchOneShotEventV1): void =>
        post({ kind: "research-worker:event", runId, event });
      const report = await runResearchAgent({
        apiKey: message.apiKey,
        request,
        providers,
        budget,
        runId,
        researchGraph,
        workspace,
        options: { onProgress, onEvent },
      });
      post({ kind: "research-worker:complete", runId, report });
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
