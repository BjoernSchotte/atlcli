import { describe, expect, test } from "bun:test";
import {
  composeResearchGraphV1,
  composeStandardResearchGraphV1,
  projectSelectedResearchRolesV1,
  researchPlanApprovalRequiredV1,
  reduceResearchGraphV1,
  validateResearchGraphV1,
  type ResearchGraphV1,
} from "./graph.js";
import { createResearchBriefV1 } from "./brief.js";
import { DEFAULT_RESEARCH_LIMITS_V1 } from "./contracts.js";
import {
  RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
} from "./contracts.js";

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

describe("dynamic research graph composition", () => {
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
    expect(projectSelectedResearchRolesV1(lookup)).toEqual(["synthesizer"]);
    expect(lookup.nodes.filter((node) => node.executor === "ptc")).toHaveLength(1);
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
    ]);
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
});
