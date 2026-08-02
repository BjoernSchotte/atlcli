import { describe, expect, test } from "bun:test";
import {
  RESEARCH_GRAPH_PROPOSAL_SCHEMA_V1,
  acceptResearchGraphProposalV1,
  composeResearchGraphV1,
  composeStandardResearchGraphV1,
  projectSelectedResearchRolesV1,
  researchPlanApprovalRequiredV1,
  reduceResearchGraphV1,
  validateResearchGraphV1,
  type ResearchGraphProposalV1,
  type ResearchGraphV1,
} from "./graph.js";
import { createResearchBriefV1 } from "./brief.js";
import { DEFAULT_RESEARCH_LIMITS_V1 } from "./contracts.js";
import {
  RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
} from "./contracts.js";
import {
  RESEARCH_PACKET_BODY_SCHEMA_V1,
  RESEARCH_PACKET_BODY_SCHEMA_V2,
  RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2,
} from "./workflow-contracts.js";

const brief = (
  question: string,
  products: ("jira" | "confluence")[],
  reconciliation: "off" | "auto" | "required" = "auto",
  effort: "lookup" | "analysis" | "deep" = "analysis",
  planApproval: "automatic" | "required" = "automatic",
) => createResearchBriefV1({
  sessionId: "research-session:test",
  turnId: "research-turn:test",
  objective: question,
  scope: {
    siteOrigin: "https://example.atlassian.net",
    jiraProjectKeys: products.includes("jira") ? ["DEMO"] : [],
    confluenceSpaceKeys: products.includes("confluence") ? ["DOCS"] : [],
  },
  sourceClasses: products,
  asOf: "2026-01-01T00:00:00.000Z",
  timezone: "UTC",
  requestedEffort: effort,
  requestedPlanApproval: planApproval,
  requestedReconciliation: reconciliation,
});

function proposalFor(
  graph: ResearchGraphV1,
  selectedIds: readonly string[],
): ResearchGraphProposalV1 {
  const selected = graph.nodes.filter((node) => selectedIds.includes(node.id));
  const acquisitions = selected
    .filter((node) => node.kind === "search" || node.kind === "resolve_scope")
    .map((node) => node.id);
  return {
    schema: RESEARCH_GRAPH_PROPOSAL_SCHEMA_V1,
    basedOnBriefRevision: graph.basedOnBriefRevision,
    basedOnGraphRevision: graph.revision,
    nodes: selected.map((node) => ({
      nodeId: node.id,
      dependencies: node.roleId === "synthesizer"
        ? selected.filter((candidate) => candidate.id !== node.id).map((candidate) => candidate.id)
        : node.roleId === "reconciler"
          ? selected.filter((candidate) =>
              candidate.id !== node.id && candidate.roleId !== "synthesizer"
            ).map((candidate) => candidate.id)
        : node.roleId === "document-distiller" ||
              node.roleId === "contradiction-verifier" ||
              node.roleId === "coverage-moderator"
            ? acquisitions
            : node.roleId === "outline-planner"
              ? selected.filter((candidate) =>
                  candidate.id !== node.id &&
                  candidate.roleId !== "reconciler" &&
                  candidate.roleId !== "synthesizer"
                ).map((candidate) => candidate.id)
            : [],
      reasonCodes: [node.reasonCodes[0]!],
    })),
  };
}

describe("dynamic research graph composition", () => {
  test("rejects an unresolved empty scope before graph composition", () => {
    expect(() => composeStandardResearchGraphV1("Research the relevant work.", {
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: [],
        confluenceSpaceKeys: [],
      },
    })).toThrow("scope must be resolved");
  });
  test("gives every productive host the same standard cross-product graph", () => {
    const graph = composeStandardResearchGraphV1(
      "Which Confluence pages correspond to Jira work items?",
    );
    expect(projectSelectedResearchRolesV1(graph)).toEqual([
      "focused-researcher",
      "document-distiller",
      "reconciler",
      "synthesizer",
    ]);
    expect(graph.nodes.filter((node) => node.roleId === "focused-researcher")).toHaveLength(2);
  });

  test("binds productive graph budgets and scope to the normalized host request", () => {
    const graph = composeStandardResearchGraphV1(
      "Which Confluence pages are related to Jira work items?",
      {
        scope: {
          siteOrigin: "https://tenant.example",
          jiraProjectKeys: ["SAFE"],
          confluenceSpaceKeys: ["DOCS"],
        },
        limits: {
          ...DEFAULT_RESEARCH_LIMITS_V1,
          maxRunMs: 600_000,
        },
        asOf: "2026-07-31T12:00:00.000Z",
      },
    );

    expect(graph.nodes.find((node) => node.roleId === "focused-researcher")?.budget.maxDurationMs).toBe(180_000);
    expect(graph.approvalEnvelope.scopeFingerprint).not.toBe(
      composeStandardResearchGraphV1("Which Confluence pages are related to Jira work items?")
        .approvalEnvelope.scopeFingerprint,
    );
  });

  test("selects structurally different nodes for lookup, Jira-only, and cross-product briefs", () => {
    const lookup = composeResearchGraphV1(brief("Get Jira issue DEMO-1", ["jira"], "off", "lookup"));
    const jiraOnly = composeResearchGraphV1(brief("List open Jira tickets", ["jira"], "off"));
    const crossProduct = composeResearchGraphV1(brief("Which Confluence content is related to Jira tickets?", ["jira", "confluence"]));
    expect(projectSelectedResearchRolesV1(lookup)).toEqual(["focused-researcher", "synthesizer"]);
    expect(lookup.nodes.filter((node) => node.roleId === "focused-researcher")).toHaveLength(1);
    expect(lookup.nodes.find((node) => node.id === "research-node:jira-lookup")?.grantedCapabilityIds)
      .toEqual(["jira.issue.search", "jira.issue.get"]);
    expect(projectSelectedResearchRolesV1(jiraOnly)).toEqual(["focused-researcher", "synthesizer"]);
    expect(projectSelectedResearchRolesV1(crossProduct)).toEqual([
      "focused-researcher",
      "document-distiller",
      "reconciler",
      "synthesizer",
    ]);
    expect(crossProduct.nodes.find((node) => node.roleId === "synthesizer")?.dependencies).toEqual([
      "research-node:jira-research",
      "research-node:wiki-research",
      "research-node:cross-product-join",
      "research-node:reconciler",
      "research-node:reconciliation-repair",
    ]);
  });

  test("uses quote-bearing V2 for detail reads and references-only V2 for analysis", () => {
    const graph = composeResearchGraphV1(
      brief("Join bounded Jira and Confluence evidence.", ["jira", "confluence"]),
      { packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2 },
    );
    validateResearchGraphV1(graph);
    const detailNodes = graph.nodes.filter((node) =>
      node.requestedCapabilityIds.includes("jira.issue.get") ||
      node.requestedCapabilityIds.includes("wiki.page.get"),
    );
    expect(detailNodes.length).toBeGreaterThanOrEqual(2);
    expect(detailNodes.every((node) => node.outputSchema === RESEARCH_PACKET_BODY_SCHEMA_V2)).toBe(true);
    expect(graph.nodes.find((node) => node.roleId === "document-distiller")?.outputSchema)
      .toBe(RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2);
    expect(graph.nodes.find((node) => node.roleId === "reconciler")?.outputSchema)
      .toBe("atlcli.reconciliation-body/v1");
    expect(graph.nodes.find((node) => node.roleId === "synthesizer")?.outputSchema)
      .toBe("atlcli.research-agent-draft/v1");
    const invalid = {
      ...graph,
      nodes: graph.nodes.map((node) => node.roleId === "synthesizer"
        ? { ...node, outputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2 }
        : node),
    };
    expect(() => validateResearchGraphV1(invalid)).toThrow("output schema");
  });

  test("offers an optional T5 outline planner only to V2 graphs and fences it before critique", () => {
    const graph = composeResearchGraphV1(
      brief(
        "Which Jira and Confluence items correspond and contradict each other?",
        ["jira", "confluence"],
        "auto",
        "deep",
      ),
      { packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2 },
    );
    validateResearchGraphV1(graph);
    expect(graph.nodes).toHaveLength(9);
    expect(graph.maxResearchWaves).toBe(5);
    const planner = graph.nodes.find((node) => node.roleId === "outline-planner")!;
    expect(planner).toMatchObject({
      kind: "outline",
      outputSchema: RESEARCH_PACKET_REFERENCE_MODEL_SCHEMA_V2,
      grantedCapabilityIds: [],
    });
    expect(projectSelectedResearchRolesV1(graph)).toContain("outline-planner");

    const selected = graph.nodes
      .filter((node) => node.kind !== "repair")
      .map((node) => node.id);
    const accepted = acceptResearchGraphProposalV1(graph, proposalFor(graph, selected));
    expect(accepted.maxResearchWaves).toBe(3);
    const acceptedPlanner = accepted.nodes.find((node) => node.id === planner.id)!;
    expect(acceptedPlanner.dependencies).toEqual([
      "research-node:jira-research",
      "research-node:wiki-research",
      "research-node:cross-product-join",
      "research-node:contradiction-verification",
      "research-node:coverage-moderation",
    ]);
    expect(accepted.nodes.find((node) => node.roleId === "reconciler")?.dependencies)
      .toContain(planner.id);
  });

  test("persists the host-granted intersection rather than widening model requests", () => {
    const graph = composeResearchGraphV1(
      brief("List Jira tickets", ["jira"], "off"),
      { grants: { "focused-researcher": ["jira.issue.search"] } },
    );
    const jira = graph.nodes.find((node) => node.id === "research-node:jira-research")!;
    expect(jira.requestedCapabilityIds).toEqual(["jira.issue.search", "jira.issue.get"]);
    expect(jira.grantedCapabilityIds).toEqual(["jira.issue.search"]);
    expect(graph.approvalEnvelope.allowedCapabilityIds).toEqual(["jira.issue.search"]);
  });

  test("selects dedicated joining, verification, and moderation for task-shaped briefs", () => {
    const standard = composeResearchGraphV1(brief(
      "How do these pages describe the funnel, and which DEMO work items correspond to each stage?",
      ["jira", "confluence"],
    ));
    expect(projectSelectedResearchRolesV1(standard)).toContain("document-distiller");
    const deep = composeResearchGraphV1(brief(
      "How do these pages describe the funnel, and which DEMO work items correspond to each stage?",
      ["jira", "confluence"],
      "auto",
      "deep",
    ));
    expect(projectSelectedResearchRolesV1(deep)).toEqual([
      "focused-researcher",
      "document-distiller",
      "coverage-moderator",
      "reconciler",
      "synthesizer",
    ]);
    expect(deep.maxResearchWaves).toBe(3);
    const contradiction = composeResearchGraphV1(brief(
      "Which Confluence content explicitly contradicts Jira tickets?",
      ["jira", "confluence"],
    ));
    expect(projectSelectedResearchRolesV1(contradiction)).toContain("contradiction-verifier");

    const explicitRelationship = composeResearchGraphV1(brief(
      "Which Confluence pages are explicitly related to Jira tickets?",
      ["jira", "confluence"],
    ));
    expect(projectSelectedResearchRolesV1(explicitRelationship)).toEqual([
      "focused-researcher",
      "document-distiller",
      "reconciler",
      "synthesizer",
    ]);
  });

  test("derives every visible role decision from executable nodes", () => {
    const graph = composeResearchGraphV1(brief("List Jira tickets", ["jira"], "off"));
    expect(graph.roleDecisions).toHaveLength(6);
    expect(graph.roleDecisions.find((entry) => entry.roleId === "focused-researcher")?.decision).toBe("selected");
    expect(graph.roleDecisions.find((entry) => entry.roleId === "document-distiller")?.decision).toBe("omitted");
    expect(() => validateResearchGraphV1({
      ...graph,
      roleDecisions: graph.roleDecisions.filter((entry) => entry.roleId !== "coverage-moderator"),
    })).toThrow("missing");
    expect(() => validateResearchGraphV1({
      ...graph,
      roleDecisions: graph.roleDecisions.map((entry) => entry.roleId === "focused-researcher" ? { ...entry, decision: "omitted" as const } : entry),
    })).toThrow("derive");
    expect(() => validateResearchGraphV1({
      ...graph,
      roleDecisions: [...graph.roleDecisions, graph.roleDecisions[0]!],
    })).toThrow("duplicated");
  });

  test("accepts structurally different supervisor compositions inside one host envelope", () => {
    const catalog = composeResearchGraphV1(brief(
      "How do Jira and Confluence describe the pipeline, including coverage gaps?",
      ["jira", "confluence"],
      "auto",
      "deep",
    ));
    const requiredIds = [
      "research-node:jira-research",
      "research-node:wiki-research",
      "research-node:synthesizer",
    ];
    const concise = acceptResearchGraphProposalV1(catalog, proposalFor(catalog, requiredIds));
    const critical = acceptResearchGraphProposalV1(catalog, proposalFor(catalog, [
      ...requiredIds.slice(0, 2),
      "research-node:cross-product-join",
      "research-node:coverage-moderation",
      "research-node:reconciler",
      requiredIds[2]!,
    ]));

    expect(projectSelectedResearchRolesV1(concise)).toEqual([
      "focused-researcher",
      "synthesizer",
    ]);
    expect(projectSelectedResearchRolesV1(critical)).toEqual([
      "focused-researcher",
      "document-distiller",
      "coverage-moderator",
      "reconciler",
      "synthesizer",
    ]);
    expect(concise.nodes.find((node) => node.roleId === "synthesizer")?.dependencies)
      .toEqual(requiredIds.slice(0, 2));
    expect(critical.nodes.find((node) => node.roleId === "reconciler")?.dependencies)
      .toEqual([
        "research-node:jira-research",
        "research-node:wiki-research",
        "research-node:cross-product-join",
        "research-node:coverage-moderation",
      ]);
    expect(concise.approvalEnvelope).toEqual({
      ...catalog.approvalEnvelope,
      maxResearchWaves: 2,
    });
    expect(concise.totalBudget.maxInputTokens).toBeLessThan(
      concise.approvalEnvelope.totalBudgetCeiling.maxInputTokens,
    );
  });

  test("rejects supervisor graph widening and invalid critical topology", () => {
    const catalog = composeResearchGraphV1(brief(
      "Which Jira and Confluence items correspond?",
      ["jira", "confluence"],
    ));
    const valid = proposalFor(catalog, [
      "research-node:jira-research",
      "research-node:wiki-research",
      "research-node:cross-product-join",
      "research-node:reconciler",
      "research-node:synthesizer",
    ]);

    expect(() => acceptResearchGraphProposalV1(catalog, {
      ...valid,
      nodes: valid.nodes.map((node) => node.nodeId === "research-node:jira-research"
        ? { ...node, nodeId: "research-node:invented" }
        : node),
    })).toThrow("outside the host catalog");
    expect(() => acceptResearchGraphProposalV1(catalog, {
      ...valid,
      nodes: valid.nodes.filter((node) => node.nodeId !== "research-node:wiki-research"),
    })).toThrow("retain every host-required acquisition");
    expect(() => acceptResearchGraphProposalV1(catalog, {
      ...valid,
      nodes: valid.nodes.map((node) => node.nodeId === "research-node:cross-product-join"
        ? { ...node, dependencies: ["research-node:jira-research"] }
        : node),
    })).toThrow("omits a required dependency");
    expect(() => acceptResearchGraphProposalV1(catalog, {
      ...valid,
      nodes: valid.nodes.map((node) => node.nodeId === "research-node:jira-research"
        ? { ...node, dependencies: ["research-node:synthesizer"] }
        : node),
    })).toThrow("cannot depend");
    expect(() => acceptResearchGraphProposalV1(catalog, {
      ...valid,
      nodes: valid.nodes.map((node) => node.nodeId === "research-node:jira-research"
        ? { ...node, grantedCapabilityIds: ["wiki.page.get"] }
        : node),
    })).toThrow("unsupported fields");
    expect(() => acceptResearchGraphProposalV1(catalog, {
      ...valid,
      basedOnGraphRevision: valid.basedOnGraphRevision + 1,
    })).toThrow("stale");
    expect(() => acceptResearchGraphProposalV1(catalog, proposalFor(catalog, [
      "research-node:jira-research",
      "research-node:wiki-research",
      "research-node:cross-product-join",
      "research-node:reconciler",
      "research-node:reconciliation-repair",
      "research-node:synthesizer",
    ]))).toThrow("cannot be selected before critique");
  });

  test("rejects cycles, unknown dependencies, depth, and capability widening", () => {
    const graph = composeResearchGraphV1(brief("List Jira tickets", ["jira"], "off"));
    const cyclic = { ...graph, nodes: graph.nodes.map((node) => ({ ...node, dependencies: [node.id] })) };
    expect(() => validateResearchGraphV1(cyclic)).toThrow("acyclic");
    const unknown = { ...graph, nodes: graph.nodes.map((node) => ({ ...node, dependencies: ["missing"] })) };
    expect(() => validateResearchGraphV1(unknown)).toThrow("dependency");
    const depth = { ...graph, nodes: graph.nodes.map((node, index) => ({ ...node, depth: index === 0 ? 1 as const : node.depth })) };
    expect(() => validateResearchGraphV1(depth)).toThrow("depth");
    const widened = structuredClone(graph) as ResearchGraphV1;
    widened.nodes[0]!.grantedCapabilityIds.push("wiki.page.get");
    expect(() => validateResearchGraphV1(widened)).toThrow(/unrequested|outside/);
    const incompatible = structuredClone(graph) as ResearchGraphV1;
    incompatible.nodes.find((node) => node.roleId === "focused-researcher")!.dependencies = ["research-node:synthesizer"];
    expect(() => validateResearchGraphV1(incompatible)).toThrow("incompatible");
    const expanded = structuredClone(graph) as ResearchGraphV1;
    expanded.nodes[0]!.kind = "expand";
    expect(() => validateResearchGraphV1(expanded)).toThrow("unavailable");
    expect(() => validateResearchGraphV1({
      ...graph,
      totalBudget: { ...graph.totalBudget, maxCapabilityCalls: graph.totalBudget.maxCapabilityCalls + 1 },
    })).toThrow("derive");
  });

  test("rejects excessive concurrency, waves, and graph fan-out", () => {
    const graph = composeResearchGraphV1(brief("List Jira tickets", ["jira"], "off"));
    for (const limits of [
      { maxParallelNodes: 4, maxResearchWaves: 2, maxReconciliationWaves: 1 },
      { maxParallelNodes: 3, maxResearchWaves: 3, maxReconciliationWaves: 1 },
      { maxParallelNodes: 3, maxResearchWaves: 2, maxReconciliationWaves: 2 },
    ]) {
      expect(() => validateResearchGraphV1({
        ...graph,
        ...limits,
        approvalEnvelope: {
          ...graph.approvalEnvelope,
          ...limits,
        },
      })).toThrow("concurrency or wave limits");
    }

    expect(() => validateResearchGraphV1({
      ...graph,
      nodes: Array.from({ length: 10 }, () => graph.nodes[0]!),
    })).toThrow("node count");
  });

  test("keeps required plan approval proposed until the exact revision is approved", () => {
    const proposed = composeResearchGraphV1(brief(
      "Perform exhaustive contradiction analysis.",
      ["jira", "confluence"],
      "required",
      "deep",
      "required",
    ));
    expect(proposed).toMatchObject({ status: "proposed", approvalEnvelope: { status: "proposed" } });
    expect(proposed.nodes.every((node) => node.status === "proposed")).toBe(true);
    expect(() => reduceResearchGraphV1(proposed, { kind: "approve", expectedRevision: 2, approvedAt: "2026-01-02T00:00:00.000Z" })).toThrow("stale");
    const approved = reduceResearchGraphV1(proposed, { kind: "approve", expectedRevision: 1, approvedAt: "2026-01-02T00:00:00.000Z" });
    expect(approved.status).toBe("approved");
    expect(approved.nodes.filter((node) => node.dependencies.length === 0).every((node) => node.status === "ready")).toBe(true);
  });

  test("preserves default versus explicit automatic approval for an identical deep brief", () => {
    const objective = "Perform exhaustive contradiction analysis across Jira and Confluence.";
    const proposed = composeStandardResearchGraphV1(objective);
    expect(proposed).toMatchObject({
      resolvedEffort: "deep",
      status: "proposed",
      approvalEnvelope: {
        status: "proposed",
        scopeDiscoveryPolicy: { expansionMode: "ask" },
      },
    });
    expect(researchPlanApprovalRequiredV1(proposed)).toMatchObject({
      schema: "atlcli.research-plan-approval-required/v1",
      kind: "plan_approval_required",
      resolvedEffort: "deep",
      resolvedPlanApproval: "required",
      graphRevision: 1,
    });

    const automatic = composeStandardResearchGraphV1(objective, {
      policy: {
        schema: RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
        requestedEffort: "auto",
        requestedPlanApproval: "automatic",
        scopeExpansionMode: "ask",
        requestedReconciliation: "auto",
      },
    });
    expect(automatic).toMatchObject({
      resolvedEffort: "deep",
      status: "approved",
      approvalEnvelope: { status: "approved" },
    });
    expect(researchPlanApprovalRequiredV1(automatic)).toBeUndefined();
  });

  test("uses a pure revision-fenced reducer to unlock dependency barriers", () => {
    let graph = composeResearchGraphV1(brief("List Jira tickets", ["jira"], "off"));
    graph = reduceResearchGraphV1(graph, { kind: "start_node", expectedRevision: 1, nodeId: "research-node:jira-research" });
    expect(graph.nodes.find((node) => node.id === "research-node:synthesizer")?.status).toBe("blocked");
    graph = reduceResearchGraphV1(graph, { kind: "complete_node", expectedRevision: 1, nodeId: "research-node:jira-research", packetRef: "packet:task:1" });
    expect(graph.nodes.find((node) => node.id === "research-node:synthesizer")?.status).toBe("ready");
    graph = reduceResearchGraphV1(graph, { kind: "start_node", expectedRevision: 1, nodeId: "research-node:synthesizer" });
    graph = reduceResearchGraphV1(graph, { kind: "complete_node", expectedRevision: 1, nodeId: "research-node:synthesizer", packetRef: "packet:task:2" });
    expect(graph.status).toBe("complete");
  });

  test("keeps graph failure transitions revision-fenced and immutable", () => {
    const initial = composeResearchGraphV1(brief("List Jira tickets", ["jira"], "off"));
    const snapshot = structuredClone(initial);
    expect(() => reduceResearchGraphV1(initial, {
      kind: "start_node",
      expectedRevision: 2,
      nodeId: "research-node:jira-research",
    })).toThrow("stale");
    expect(() => reduceResearchGraphV1(initial, {
      kind: "start_node",
      expectedRevision: 1,
      nodeId: "research-node:unknown",
    })).toThrow("unknown node");

    const running = reduceResearchGraphV1(initial, {
      kind: "start_node",
      expectedRevision: 1,
      nodeId: "research-node:jira-research",
    });
    expect(initial).toEqual(snapshot);
    expect(() => reduceResearchGraphV1(running, {
      kind: "start_node",
      expectedRevision: 1,
      nodeId: "research-node:jira-research",
    })).toThrow("ready");

    const quarantined = reduceResearchGraphV1(running, {
      kind: "quarantine_node",
      expectedRevision: 1,
      nodeId: "research-node:jira-research",
      stopReason: "late-result",
    });
    expect(quarantined.nodes.find(
      (node) => node.id === "research-node:jira-research",
    )).toMatchObject({ status: "quarantined", stopReason: "late-result" });
    expect(quarantined.nodes.find(
      (node) => node.id === "research-node:synthesizer",
    )?.status).toBe("blocked");
    expect(() => reduceResearchGraphV1(quarantined, {
      kind: "complete_node",
      expectedRevision: 1,
      nodeId: "research-node:jira-research",
      packetRef: "packet:late",
    })).toThrow("running");
  });
});
