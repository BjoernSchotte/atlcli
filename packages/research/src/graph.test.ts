import { describe, expect, test } from "bun:test";
import {
  RESEARCH_BRIEF_SCHEMA_V1,
  composeResearchGraphV1,
  validateResearchGraphV1,
  type ResearchGraphV1,
} from "./graph.js";

const brief = (question: string, products: ("jira" | "confluence")[], reconciliation: "off" | "auto" | "required" = "auto") => ({
  schema: RESEARCH_BRIEF_SCHEMA_V1,
  question,
  products,
  effort: "standard" as const,
  reconciliation,
});

describe("dynamic research graph composition", () => {
  test("selects structurally different roles for Jira-only and cross-product briefs", () => {
    const jiraOnly = composeResearchGraphV1(brief("List open Jira tickets", ["jira"], "off"));
    const crossProduct = composeResearchGraphV1(brief("Which Confluence content is related to Jira tickets?", ["jira", "confluence"]));
    expect(jiraOnly.selectedRoleIds).toEqual(["jira-retrieval"]);
    expect(crossProduct.selectedRoleIds).toEqual([
      "jira-retrieval",
      "wiki-retrieval",
      "cross-product-join",
      "reconciler",
    ]);
    expect(crossProduct.nodes.find((node) => node.role === "cross-product-join")?.dependsOn).toEqual([
      "research-node:jira-retrieval",
      "research-node:wiki-retrieval",
    ]);
  });

  test("persists the host-granted intersection rather than widening model requests", () => {
    const graph = composeResearchGraphV1(
      brief("Which wiki pages relate to Jira tickets?", ["jira", "confluence"]),
      { grants: { "jira-retrieval": ["jira.issue.search"] } },
    );
    const jira = graph.nodes.find((node) => node.role === "jira-retrieval")!;
    expect(jira.requestedCapabilityIds).toEqual(["jira.issue.search", "jira.issue.get"]);
    expect(jira.grantedCapabilityIds).toEqual(["jira.issue.search"]);
  });

  test("recognizes funnel and correspondence questions as cross-product joins", () => {
    const graph = composeResearchGraphV1(brief(
      "How do these pages describe the funnel, and which GROW work items correspond to each stage?",
      ["jira", "confluence"],
    ));
    expect(graph.selectedRoleIds).toContain("cross-product-join");
  });

  test("rejects cycles, unknown dependencies, and model-authored role projections", () => {
    const graph = composeResearchGraphV1(brief("List Jira tickets", ["jira"], "off"));
    const cyclic = { ...graph, nodes: graph.nodes.map((node) => ({ ...node, dependsOn: [node.id] })) };
    expect(() => validateResearchGraphV1(cyclic)).toThrow("acyclic");
    const unknown = { ...graph, nodes: graph.nodes.map((node) => ({ ...node, dependsOn: ["missing"] })) };
    expect(() => validateResearchGraphV1(unknown)).toThrow("dependency");
    const inconsistent = { ...graph, selectedRoleIds: ["wiki-retrieval"] } as ResearchGraphV1;
    expect(() => validateResearchGraphV1(inconsistent)).toThrow("derive");
  });
});
