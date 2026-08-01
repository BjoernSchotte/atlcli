import { describe, expect, test } from "bun:test";
import { fakeModel } from "@langchain/core/testing";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { runResearchAgent } from "../agent-runtime.node.js";
import {
  normalizeResearchRequestV1,
  type ResearchOneShotEventV1,
} from "../contracts.js";
import type { ResearchReadProviders } from "../broker.js";
import { createResearchBriefV1 } from "../brief.js";
import { composeResearchGraphV1, type ResearchGraphV1, type ResearchGraphNodeV1 } from "../graph.js";
import {
  RESEARCH_ANALYSIS_PACKET_SCHEMA_V1,
  RESEARCH_CRITIQUE_SCHEMA_V1,
  RESEARCH_WORKER_PACKET_SCHEMA_V1,
  researchSubagentTypeForNodeV1,
  researchTaskIdForNodeV1,
} from "../dynamic-subagents.js";
import { RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1 } from "../agent-draft.js";
import {
  RESEARCH_EVALUATION_SCHEMA_V1,
  type ResearchEvaluationGoldV1,
  type ResearchEvaluationObservationV1,
} from "./evaluation.js";
import {
  RESEARCH_T3_COMPARISON_SCHEMA_V1,
  runResearchT3ComparisonV1,
  type ResearchT3ComparisonRunEvidenceV1,
  type ResearchT3ComparisonVariantV1,
} from "./t3-comparison.js";

const request = normalizeResearchRequestV1({
  schema: "atlcli.research-request/v1",
  question: "Which DEMO issues relate to KB pages, and which relationship is explicitly evidenced?",
  scope: {
    siteOrigin: "https://synthetic-comparison.atlassian.net",
    jiraProjectKeys: ["DEMO"],
    confluenceSpaceKeys: ["KB"],
    timeWindow: { from: "2026-07-01", to: "2026-07-31" },
  },
  limits: {
    pageSize: 4,
    maxSearchPagesPerProduct: 2,
    maxItemsPerProduct: 8,
    maxDetailItemsPerProduct: 2,
    maxBodyCharsPerItem: 2_000,
    maxPtcCalls: 12,
    maxHttpCalls: 12,
    maxConcurrentCalls: 3,
    maxPtcInputBytes: 32_000,
    maxPtcOutputBytes: 128_000,
    maxTotalResponseBytes: 1_000_000,
    maxInterpreterMemoryBytes: 64_000_000,
    maxInterpreterMs: 10_000,
    maxModelInputTokens: 20_000,
    maxModelOutputTokens: 4_000,
    maxReportChars: 20_000,
    maxRunMs: 60_000,
  },
  wikiProvider: "rest",
});

const gold: ResearchEvaluationGoldV1 = {
  schema: RESEARCH_EVALUATION_SCHEMA_V1,
  relevantSourceIds: ["jira:DEMO-1", "wiki:1001"],
  requiredDetailSourceIds: ["jira:DEMO-1", "wiki:1001"],
  claimSupport: {},
  verifiedRelationshipSupport: {
    "relationship:DEMO-1:1001": ["jira:DEMO-1", "wiki:1001"],
  },
  expectedAbstentions: {},
  requiredCompletenessCriteria: ["bounded-source-read"],
  requiredBranchIds: ["jira", "wiki", "report"],
  expectedScopeEntityIds: ["jira:project:DEMO", "wiki:space:KB"],
  catalogEntityIds: [],
  necessaryScopeExpansionIds: [],
};

const emptyPacket = (answeredQuestion: string) => ({
  schema: "atlcli.research-packet-body/v1",
  answeredQuestion,
  sourceIds: [],
  findingCandidates: [],
  relationshipCandidates: [],
  gaps: [],
  proposedFollowUps: [],
  coverageLimits: ["Synthetic runtime-comparison packet."],
});

const emptyCritique = {
  schema: "atlcli.reconciliation-body/v1",
  defects: [],
  proposedFollowUps: [],
};

const draft = {
  title: "Synthetic S0–S3 runtime comparison",
  executiveSummary: "The host verifies explicit Jira and Confluence links during deterministic finalization.",
  findings: [],
  relationships: [],
  limitations: ["Customer-free deterministic runtime comparison."],
};

const SINGLE_AGENT_PROGRAM = `
const read = async (search, detail) => {
  const page = JSON.parse(await search({ query: {} }));
  const details = await Promise.all(page.items.slice(0, 1).map(async (item) =>
    JSON.parse(await detail({ entityRef: item.entityRef }))
  ));
  return { page, details };
};
const [jira, wiki] = await Promise.all([
  read(tools.jiraIssueSearch, tools.jiraIssueGet),
  read(tools.wikiSearch, tools.wikiPageGet)
]);
({ jira, wiki });
`.trim();

const WORKER_ACQUISITION_PROGRAM = `
const search = tools.jiraIssueSearch ?? tools.wikiSearch;
const detail = tools.jiraIssueGet ?? tools.wikiPageGet;
const page = JSON.parse(await search({ query: {} }));
const details = await Promise.all(page.items.slice(0, 1).map(async (item) =>
  JSON.parse(await detail({ entityRef: item.entityRef }))
));
({ page, details });
`.trim();

interface ProviderObservation {
  retrieved: Set<string>;
  detailed: Set<string>;
  providerBytes: number;
  active: number;
  maxConcurrent: number;
}

function observedProviders(): {
  providers: ResearchReadProviders;
  observation: ProviderObservation;
} {
  const observation: ProviderObservation = {
    retrieved: new Set<string>(),
    detailed: new Set<string>(),
    providerBytes: 0,
    active: 0,
    maxConcurrent: 0,
  };
  const record = async <T>(sourceIds: readonly string[], body: unknown, value: T): Promise<T> => {
    observation.active += 1;
    observation.maxConcurrent = Math.max(observation.maxConcurrent, observation.active);
    sourceIds.forEach((sourceId) => observation.retrieved.add(sourceId));
    observation.providerBytes += new TextEncoder().encode(JSON.stringify(body)).byteLength;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    observation.active -= 1;
    return value;
  };
  return {
    observation,
    providers: {
      jira: {
        searchPage: ({ signal }) => {
          signal.throwIfAborted();
          return record(["jira:DEMO-1"], { kind: "jira-search" }, {
            items: [{
              issueKey: "DEMO-1",
              projectKey: "DEMO",
              title: "Bounded pagination implementation",
              updatedAt: "2026-07-30T10:00:00.000Z",
              excerpt: "Implementation is linked to the KB design.",
            }],
          });
        },
        getIssue: ({ issueKey, signal }) => {
          signal.throwIfAborted();
          const content = {
            text: "DEMO-1 implements https://synthetic-comparison.atlassian.net/wiki/spaces/KB/pages/1001.",
            linkTargets: ["https://synthetic-comparison.atlassian.net/wiki/spaces/KB/pages/1001"],
            truncated: false,
            inputBytes: 102,
          };
          return record([`jira:${issueKey}`], content, {
            issueKey,
            projectKey: "DEMO",
            title: "Bounded pagination implementation",
            updatedAt: "2026-07-30T10:00:00.000Z",
            content,
          }).then((value) => {
            observation.detailed.add(`jira:${issueKey}`);
            return value;
          });
        },
      },
      wiki: {
        searchPage: ({ signal }) => {
          signal.throwIfAborted();
          return record(["wiki:1001"], { kind: "wiki-search" }, {
            items: [{
              contentId: "1001",
              spaceKey: "KB",
              title: "Bounded pagination design",
              updatedAt: "2026-07-30T09:00:00.000Z",
              excerpt: "The page identifies its Jira implementation.",
            }],
          });
        },
        getPage: ({ contentId, signal }) => {
          signal.throwIfAborted();
          const content = {
            text: "The implementation ticket is DEMO-1.",
            linkTargets: ["https://synthetic-comparison.atlassian.net/browse/DEMO-1"],
            truncated: false,
            inputBytes: 38,
          };
          return record([`wiki:${contentId}`], content, {
            contentId,
            spaceKey: "KB",
            title: "Bounded pagination design",
            updatedAt: "2026-07-30T09:00:00.000Z",
            content,
          }).then((value) => {
            observation.detailed.add(`wiki:${contentId}`);
            return value;
          });
        },
      },
    },
  };
}

function graphFor(variant: Exclude<ResearchT3ComparisonVariantV1, "S0">): ResearchGraphV1 {
  const sourceClasses = variant === "S1" ? ["jira"] as const : ["jira", "confluence"] as const;
  return composeResearchGraphV1(createResearchBriefV1({
    sessionId: `research-session:t3-${variant.toLowerCase()}`,
    turnId: `research-turn:t3-${variant.toLowerCase()}`,
    objective: request.question,
    scope: request.scope,
    asOf: "2026-08-01T12:00:00.000Z",
    timezone: "UTC",
    requestedEffort: variant === "S1" ? "lookup" : "analysis",
    requestedPlanApproval: "automatic",
    requestedReconciliation: variant === "S3" ? "auto" : "off",
    sourceClasses,
    limits: request.limits,
  }));
}

function responseSchema(node: ResearchGraphNodeV1): Record<string, unknown> {
  if (node.roleId === "synthesizer") return RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1;
  if (node.roleId === "reconciler") return RESEARCH_CRITIQUE_SCHEMA_V1;
  return node.kind === "search"
    ? RESEARCH_WORKER_PACKET_SCHEMA_V1
    : RESEARCH_ANALYSIS_PACKET_SCHEMA_V1;
}

function nodeVariable(node: ResearchGraphNodeV1): string {
  return `result_${node.id.replace(/[^a-z0-9]/gi, "_")}`;
}

function taskExpression(graph: ResearchGraphV1, node: ResearchGraphNodeV1): string {
  const dependencyResults = node.dependencies
    // The repair node is a latent authorization slot. It is absent from this
    // no-defect S3 proposal and therefore cannot be referenced by synthesis.
    .filter((dependencyId) => graph.nodes.find((candidate) => candidate.id === dependencyId)?.kind !== "repair")
    .map((dependencyId) => {
    const dependency = graph.nodes.find((candidate) => candidate.id === dependencyId)!;
    return `{ taskId: ${JSON.stringify(researchTaskIdForNodeV1(graph, dependency))}, result: ${nodeVariable(dependency)} }`;
  });
  return `task({
    description: JSON.stringify({
      schema: "atlcli.research-task-dispatch/v1",
      taskId: ${JSON.stringify(researchTaskIdForNodeV1(graph, node))},
      objective: ${JSON.stringify(node.objective)},
      ${dependencyResults.length > 0 ? `dependencyResults: [${dependencyResults.join(", ")}]` : ""}
    }),
    subagentType: ${JSON.stringify(researchSubagentTypeForNodeV1(node))},
    responseSchema: ${JSON.stringify(responseSchema(node))}
  })`;
}

function workflowProgram(graph: ResearchGraphV1): string {
  const selected = graph.nodes.filter((node) => node.kind !== "repair");
  const proposal = {
    basedOnBriefRevision: graph.basedOnBriefRevision,
    basedOnGraphRevision: graph.revision,
    nodes: selected.map((node) => ({
      nodeId: node.id,
      dependencies: node.dependencies.filter((dependency) => selected.some((candidate) => candidate.id === dependency)),
      reasonCodes: [node.reasonCodes[0]!],
    })),
  };
  const synthesizer = selected.find((node) => node.roleId === "synthesizer")!;
  const nonSynthesizer = selected.filter((node) => node !== synthesizer);
  const waveByNode = new Map<string, number>();
  const wave = (node: ResearchGraphNodeV1): number => {
    const existing = waveByNode.get(node.id);
    if (existing !== undefined) return existing;
    const dependencyWaves = node.dependencies
      .map((id) => selected.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is ResearchGraphNodeV1 => Boolean(candidate))
      .map(wave);
    const value = dependencyWaves.length === 0 ? 1 : Math.max(...dependencyWaves) + 1;
    waveByNode.set(node.id, value);
    return value;
  };
  const byWave = new Map<number, ResearchGraphNodeV1[]>();
  nonSynthesizer.forEach((node) => {
    const value = wave(node);
    byWave.set(value, [...(byWave.get(value) ?? []), node]);
  });
  const statements: string[] = [
    `const acceptedGraph = JSON.parse(await tools.researchGraphPropose(${JSON.stringify(proposal)}));`,
    `if (acceptedGraph.schema !== "atlcli.accepted-research-graph/v1") throw new Error("Graph proposal was not accepted.");`,
  ];
  [...byWave.entries()].sort(([left], [right]) => left - right).forEach(([, nodes]) => {
    if (nodes.length === 1) {
      const node = nodes[0]!;
      statements.push(`const ${nodeVariable(node)} = await ${taskExpression(graph, node)};`);
      return;
    }
    statements.push(`const [${nodes.map(nodeVariable).join(", ")}] = await Promise.all([${nodes.map((node) => taskExpression(graph, node)).join(", ")}]);`);
  });
  const reconciler = selected.find((node) => node.roleId === "reconciler");
  if (reconciler) {
    statements.push(`JSON.parse(await tools.researchReconciliationDispositions({
      basedOnGraphRevision: ${graph.revision},
      reconciliationTaskId: ${JSON.stringify(researchTaskIdForNodeV1(graph, reconciler))},
      decisions: []
    }));`);
  }
  statements.push(`const ${nodeVariable(synthesizer)} = await ${taskExpression(graph, synthesizer)};`);
  statements.push(`${nodeVariable(synthesizer)};`);
  return statements.join("\n");
}

function supervisorModel(graph: ResearchGraphV1): BaseChatModel {
  return fakeModel()
    .respondWithTools([{ name: "eval", args: { code: workflowProgram(graph) } }])
    // The parent retains its provider-native structured publication boundary
    // after the one allowed QuickJS eval returns the synthesizer object.
    .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }]);
}

function subagentModels(graph: ResearchGraphV1): Partial<Record<string, BaseChatModel>> {
  return Object.fromEntries(graph.nodes
    .filter((node) => node.kind !== "repair" && node.roleId)
    .map((node) => [node.id, node.roleId === "focused-researcher"
      ? fakeModel()
          .respondWithTools([{ name: "eval", args: { code: WORKER_ACQUISITION_PROGRAM } }])
          .respondWithTools([{ name: "ResearchPacketBodyV1", args: emptyPacket(node.objective) }])
      : node.roleId === "reconciler"
        ? fakeModel().respondWithTools([{ name: "ReconciliationBodyV1", args: emptyCritique }])
        : node.roleId === "synthesizer"
          ? fakeModel().respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }])
          : fakeModel().respondWithTools([{ name: "ResearchPacketBodyV1", args: emptyPacket(node.objective) }]),
    ]));
}

function maxConcurrentSubagents(events: readonly ResearchOneShotEventV1[]): number {
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    if (event.kind !== "subagent") continue;
    if (event.status === "started") {
      active += 1;
      maximum = Math.max(maximum, active);
    } else if (["completed", "failed", "cancelled", "quarantined", "rejected"].includes(event.status)) {
      active = Math.max(0, active - 1);
    }
  }
  return maximum;
}

async function runtimeEvidence(
  variant: ResearchT3ComparisonVariantV1,
): Promise<ResearchT3ComparisonRunEvidenceV1> {
  const events: ResearchOneShotEventV1[] = [];
  const { providers, observation: provider } = observedProviders();
  const now = (() => {
    let tick = Date.parse("2026-08-01T12:00:00.000Z");
    return () => ++tick;
  })();
  const graph = variant === "S0" ? undefined : graphFor(variant);
  const report = await runResearchAgent({
    request,
    providers,
    model: graph
      ? supervisorModel(graph)
      : fakeModel()
          .respondWithTools([{ name: "eval", args: { code: SINGLE_AGENT_PROGRAM } }])
          .respondWithTools([{ name: "AtlcliResearchAgentDraftV1", args: draft }]),
    ...(graph ? { researchGraph: graph, subagentModelsByNode: subagentModels(graph) } : {}),
    runId: `t3-runtime-${variant.toLowerCase()}`,
    now,
    options: { onEvent: (event) => events.push(event) },
  });
  if (report.schema !== "atlcli.research-report/v1") {
    throw new Error("The T3 comparison harness must retain the V1 report contract.");
  }
  const focusedWorkers = events.filter((event) =>
    event.kind === "subagent" && event.status === "started" && event.roleId === "focused-researcher",
  ).length;
  const relationship = report.relationships.find((candidate) =>
    candidate.classification === "verified" && candidate.jiraIssueKey === "DEMO-1" &&
    candidate.confluenceContentId === "1001",
  );
  const terminalCapabilityEvents = events.filter((event) =>
    event.kind === "capability" && event.status === "completed"
  );
  const branchIds = new Set<string>(["report"]);
  if (provider.retrieved.has("jira:DEMO-1")) branchIds.add("jira");
  if (provider.retrieved.has("wiki:1001")) branchIds.add("wiki");
  const observation: ResearchEvaluationObservationV1 = {
    retrievedSourceIds: [...provider.retrieved],
    detailedSourceIds: [...provider.detailed],
    publishedClaimIds: [],
    publishedVerifiedRelationshipIds: relationship ? ["relationship:DEMO-1:1001"] : [],
    citations: relationship
      ? relationship.sourceIds.map((sourceId) => ({
          targetKind: "verified-relationship" as const,
          targetId: "relationship:DEMO-1:1001",
          sourceId,
        }))
      : [],
    abstentions: {},
    completedCriteria: report.run.complete ? ["bounded-source-read"] : [],
    completedBranchIds: [...branchIds],
    taskFingerprints: events.flatMap((event) =>
      event.kind === "subagent" && event.status === "started" ? [event.taskId] : [],
    ),
    promptInjectionSucceeded: false,
    resolvedScopeEntityIds: ["jira:project:DEMO", "wiki:space:KB"],
    autoResolvedScopeEntityIds: [],
    catalogObservedEntityIds: [],
    scopeExpansionProposalIds: [],
    calls: {
      model: events.filter((event) => event.kind === "decision" && event.decisionId === "central-supervisor-run" && event.status === "started").length,
      ptc: report.run.counts.ptcCalls,
      http: report.run.counts.httpCalls,
    },
    bytes: {
      modelInput: 0,
      modelOutput: 0,
      providerResponse: provider.providerBytes,
    },
    tokens: {
      modelInput: report.run.usage?.inputTokens ?? 0,
      modelOutput: report.run.usage?.outputTokens ?? 0,
    },
    latencySamplesMs: terminalCapabilityEvents.flatMap((event) =>
      event.kind === "capability" ? [event.durationMs ?? 0] : [],
    ),
    modelCostSamplesUsd: [0],
    peakSupervisorContextTokens: report.run.usage?.inputTokens ?? 0,
    peakSupervisorContextBytes: 0,
  };
  return {
    schema: RESEARCH_T3_COMPARISON_SCHEMA_V1,
    scenarioId: "synthetic-runtime-s0-s3",
    variant,
    request,
    observation,
    composition: {
      execution: variant === "S0" ? "single-agent" : "dynamic-graph",
      researchWorkerTaskCount: focusedWorkers,
      synthesizerTaskCount: events.filter((event) =>
        event.kind === "subagent" && event.status === "started" && event.roleId === "synthesizer",
      ).length,
      reconciliation: variant === "S3" ? "not-needed" : "not-admitted",
      maxConcurrentSubagents: maxConcurrentSubagents(events),
      maxConcurrentPtcCalls: provider.maxConcurrent,
      reportPublications: 1,
      markdownChars: report.markdown.length,
    },
  };
}

describe("T3 S0–S3 real runtime comparison", () => {
  test("runs S0 through S3 through the Node host under one immutable scope/budget envelope", async () => {
    const result = await runResearchT3ComparisonV1({
      scenario: {
        schema: RESEARCH_T3_COMPARISON_SCHEMA_V1,
        id: "synthetic-runtime-s0-s3",
        request,
        gold,
      },
      runners: {
        S0: () => runtimeEvidence("S0"),
        S1: () => runtimeEvidence("S1"),
        S2: () => runtimeEvidence("S2"),
        S3: () => runtimeEvidence("S3"),
      },
    });

    expect(result.runs.S0.evidence.composition).toMatchObject({
      execution: "single-agent",
      researchWorkerTaskCount: 0,
      synthesizerTaskCount: 0,
      reconciliation: "not-admitted",
    });
    expect(result.runs.S1.evidence.composition).toMatchObject({
      execution: "dynamic-graph",
      researchWorkerTaskCount: 1,
      synthesizerTaskCount: 1,
      reconciliation: "not-admitted",
    });
    expect(result.runs.S2.evidence.composition.researchWorkerTaskCount).toBe(2);
    expect(result.runs.S2.evidence.composition.maxConcurrentPtcCalls).toBeGreaterThanOrEqual(2);
    expect(result.runs.S3.evidence.composition).toMatchObject({
      researchWorkerTaskCount: 2,
      synthesizerTaskCount: 1,
      reconciliation: "not-needed",
    });
    expect(result.runs.S0.metrics.sourceCoverage).toBe(1);
    expect(result.runs.S1.metrics.sourceCoverage).toBe(0.5);
    expect(result.runs.S2.metrics.sourceCoverage).toBe(1);
    expect(result.runs.S3.metrics.verifiedRelationshipPrecision).toBe(1);
    expect(result.candidateDecisions).toEqual([
      expect.objectContaining({
        variant: "S2",
        accepted: true,
        deterministicGateFailuresAgainstS0: [],
      }),
      expect.objectContaining({
        variant: "S3",
        accepted: true,
        deterministicGateFailuresAgainstS0: [],
      }),
    ]);
    expect(result).toMatchObject({ decision: "go", recommendedDefault: "S3" });
  });
});
