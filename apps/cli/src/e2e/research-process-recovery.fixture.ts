import type { Profile } from "@atlcli/core";
import {
  RESEARCH_PACKET_BODY_SCHEMA_V2,
  RESEARCH_SCOPE_PREFLIGHT_OUTCOME_SCHEMA_V1,
  ResearchSessionDispatchJournalV1,
  SqliteResearchSessionStoreV1,
  assessResearchRetrievalV1,
  createStandardResearchBriefV1,
  prepareResearchBriefPreflightV1,
  type ResearchReportV1,
} from "@atlcli/research/bun";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  handleResearch,
  type ResearchCliDependencies,
} from "../commands/research.js";

const SESSION_ID = "research-session:process-recovery";
const TURN_ID = "research-turn:process-recovery";

const profile: Profile = {
  name: "synthetic",
  baseUrl: "https://synthetic.atlassian.net",
  project: "ATLCLI",
  space: "DOCSY",
  auth: { type: "apiToken", email: "test@example.invalid", token: "test" },
};

function argument(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index === -1 ? undefined : Bun.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function report(): ResearchReportV1 {
  return {
    schema: "atlcli.research-report/v1",
    title: "Recovered process report",
    question: "Recover a synthetic process interruption.",
    scope: {
      siteOrigin: profile.baseUrl,
      jiraProjectKeys: ["ATLCLI"],
      confluenceSpaceKeys: ["DOCSY"],
    },
    executiveSummary: "The interrupted checkpoint was resumed without duplicating its accepted work.",
    findings: [],
    relationships: [],
    limitations: ["Synthetic process-recovery fixture."],
    sources: [],
    run: {
      model: "synthetic-process-fixture",
      wikiProvider: "rest",
      startedAt: "2026-08-02T12:00:00.000Z",
      completedAt: "2026-08-02T12:00:01.000Z",
      durationMs: 1_000,
      complete: true,
      counts: { ptcCalls: 0, httpCalls: 0, jiraItems: 0, confluenceItems: 0 },
      warnings: [],
    },
    markdown: "# Recovered process report\n\n## Sources\n\nNo synthetic source bodies were retained.\n",
  };
}

function emptyV2Packet() {
  return {
    schema: RESEARCH_PACKET_BODY_SCHEMA_V2,
    claims: [],
    referencedClaimIds: [],
    contradictions: [],
    outlineProposals: [],
    gaps: [],
    proposedFollowUps: [],
    coverageLimits: ["The first synthetic retrieval wave is complete."],
    abstentionReason: "The fixture intentionally has no source evidence.",
  };
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

async function createDependencies(
  root: string,
  mode: "interrupt" | "consume-and-kill" | "resume",
): Promise<ResearchCliDependencies> {
  const databasePath = join(root, "catalog.sqlite");
  const workspaceRoot = join(root, "sessions");
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  return {
    resolveProfile: async () => profile,
    resolveScope: async ({ request }) => ({
      schema: RESEARCH_SCOPE_PREFLIGHT_OUTCOME_SCHEMA_V1,
      kind: "ready",
      request,
      mentions: [],
      resolutions: [],
    }),
    prepareBrief: ({ request, policy, asOf, timezone, sessionId, turnId }) =>
      prepareResearchBriefPreflightV1(createStandardResearchBriefV1(request.question, {
        ...(sessionId ? { sessionId } : {}),
        ...(turnId ? { turnId } : {}),
        scope: request.scope,
        scopeBindings: request.scopeSeeds?.map((seed) => seed.binding),
        limits: request.limits,
        asOf,
        timezone,
        policy,
      })),
    readApiKey: () => "synthetic-key-not-a-secret",
    createWorkspace: async () => {
      throw new Error("The process-recovery fixture must use the retained SQLite workspace.");
    },
    runAgent: async (input) => {
      const journal = new ResearchSessionDispatchJournalV1({
        store: input.durableSession.store,
        sessionId: input.sessionId,
        turnId: input.durableSession.turnId,
        now: () => "2026-08-02T12:00:00.000Z",
      });
      if (mode === "consume-and-kill" || mode === "resume") {
        const stored = await input.durableSession.store.read(input.sessionId);
        const checkpoint = stored?.turns.find((turn) => turn.id === input.durableSession.turnId)
          ?.retrievalAssessments?.find((assessment) => assessment.continuation?.status === "issued");
        if (!checkpoint?.continuation || checkpoint.wave === undefined) {
          throw new Error("The recovery fixture expected one issued continuation.");
        }
        await journal.consumeRetrievalContinuation({
          graphRevision: checkpoint.graphRevision,
          wave: checkpoint.wave,
          continuationId: checkpoint.continuation.id,
        });
        if (mode === "consume-and-kill") {
          const at = new Date(Date.now() + 10).toISOString();
          await input.durableSession.store.commit(input.sessionId, {
            kind: "heartbeat",
            leaseExpiresAt: new Date(Date.parse(at) + 1).toISOString(),
            expectedRevision: stored!.revision + 1,
            expectedLeaseEpoch: stored!.lease.epoch,
            at,
          });
          process.kill(process.pid, "SIGKILL");
          throw new Error("SIGKILL should have stopped the consumed-continuation process.");
        }
        const recovered = report();
        await input.workspace.writeFile("/artifacts/report.md", recovered.markdown);
        return recovered;
      }

      const selectedNodes = input.researchGraph.nodes.filter((node) => node.kind !== "repair");
      const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
      const graph = await journal.commitGraphSelection({
        schema: "atlcli.research-graph-proposal/v1",
        basedOnBriefRevision: input.researchGraph.basedOnBriefRevision,
        basedOnGraphRevision: input.researchGraph.revision,
        nodes: selectedNodes
          .map((node) => ({
            nodeId: node.id,
            dependencies: node.dependencies.filter((dependency) => selectedNodeIds.has(dependency)),
            reasonCodes: [...node.reasonCodes],
          })),
      });
      const readyNodes = graph.nodes.filter((node) => node.status === "ready");
      if (readyNodes.length === 0) throw new Error("The process-recovery fixture expected an initial frontier.");
      for (const node of readyNodes) {
        const taskId = `research-task:process-${node.id.replace("research-node:", "")}`;
        const body = emptyV2Packet();
        await journal.admitAndStart({
          schema: "atlcli.research-task-attempt/v1",
          taskId,
          nodeId: node.id,
          graphRevision: graph.revision,
          attempt: 1,
          executor: node.executor,
          ...(node.roleId ? { roleId: node.roleId } : {}),
          grantedCapabilityIds: [...node.grantedCapabilityIds],
          typedIntentRefs: [...node.typedIntentRefs],
          expectedOutputSchema: node.outputSchema,
          budget: { ...node.budget },
          status: "ready",
          dispatchState: "not_started",
          createdAt: graph.createdAt,
        });
        await journal.acceptPacket({
          taskId,
          graphRevision: graph.revision,
          body,
          usage: {
            capabilityCalls: 0,
            inputTokens: 1,
            outputTokens: 1,
            resultBytes: bytes(body),
            durationMs: 1,
            costMicros: 0,
          },
          availableSourceIds: [],
          maximumResultBytes: node.budget.maxResultBytes,
        });
      }
      await journal.recordRetrievalAssessment({
        graphRevision: graph.revision,
        assessment: assessResearchRetrievalV1({
          products: [{
            product: "jira",
            rankedSourceIds: ["jira:synthetic:1", "jira:synthetic:2"],
            detailedSourceIds: ["jira:synthetic:1"],
            searchAttempted: true,
            searchComplete: true,
            canSearchMore: false,
            canReadMoreDetails: true,
          }],
          ptcCallsRemaining: 2,
          httpAttemptsRemaining: 2,
        }),
        issueContinuation: true,
        budgetState: {
          schema: "atlcli.research-run-budget/v1",
          ptcCalls: 1,
          httpAttempts: 1,
          responseBytes: 128,
          pages: { jira: 1, confluence: 0 },
          items: { jira: 1, confluence: 0 },
          details: { jira: 1, confluence: 0 },
        },
      });
      const checkpointed = await input.durableSession.store.read(input.sessionId);
      if (!checkpointed) throw new Error("The process-recovery checkpoint did not persist.");
      await input.durableSession.store.commit(input.sessionId, {
        kind: "wait_authentication",
        expectedRevision: checkpointed.revision,
        expectedLeaseEpoch: checkpointed.lease.epoch,
        at: "2026-08-02T12:00:00.001Z",
      });
      process.kill(process.pid, "SIGKILL");
      throw new Error("SIGKILL should have stopped the interrupted process.");
    },
    runChatAgent: async () => {
      throw new Error("The research process-recovery fixture does not run chat.");
    },
    writeAtomic: async (path, contents) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await Bun.write(path, contents);
    },
    artifactPath: () => join(root, "automatic-report.md"),
    createDurableSessionId: () => SESSION_ID,
    createDurableTurnId: () => TURN_ID,
    openSessionStore: async () => {
      const store = new SqliteResearchSessionStoreV1({ databasePath, root: workspaceRoot });
      return {
        store,
        workspace: (sessionId) => store.workspace(sessionId),
        close: () => store.close(),
      };
    },
    writeStdout: (contents) => process.stdout.write(contents),
    writeStderr: (contents) => process.stderr.write(contents),
    emitOutput: (data) => process.stdout.write(`${JSON.stringify(data)}\n`),
    fail: (_opts, _code, _errCode, message): never => { throw new Error(message); },
    scheduleAbort: (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancelScheduledAbort: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    listenForInterrupt: (callback) => {
      process.once("SIGINT", callback);
      return () => process.removeListener("SIGINT", callback);
    },
  };
}

async function main(): Promise<void> {
  const mode = argument("--mode");
  if (mode !== "interrupt" && mode !== "consume-and-kill" && mode !== "resume") {
    throw new Error("--mode must be interrupt, consume-and-kill, or resume.");
  }
  const root = argument("--root");
  const dependencies = await createDependencies(root, mode);
  if (mode === "interrupt") {
    await handleResearch(
      ["Recover a synthetic process interruption."],
      {
        profile: profile.name,
        project: "ATLCLI",
        space: "DOCSY",
        effort: "deep",
        "plan-approval": "automatic",
        "max-run-minutes": "1",
      },
      { json: false },
      dependencies,
    );
    return;
  }
  await handleResearch(
    [],
    { profile: profile.name, resume: SESSION_ID, output: argument("--output") },
    { json: false },
    dependencies,
  );
}

await main();
