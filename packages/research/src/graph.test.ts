import { describe, expect, test } from "bun:test";
import {
  RESEARCH_BRIEF_SCHEMA_V1,
  composeResearchGraphV1,
  composeStandardResearchGraphV1,
  validateResearchGraphV1,
  type ResearchGraphV1,
} from "./graph.js";

const brief = (
  question: string,
  products: ("jira" | "confluence")[],
  reconciliation: "off" | "auto" | "required" = "auto",
  effort: "shallow" | "standard" | "deep" = "standard",
) => ({
  schema: RESEARCH_BRIEF_SCHEMA_V1,
  question,
  products,
  effort,
  reconciliation,
});

describe("dynamic research graph composition", () => {
  test("gives every productive host the same standard cross-product graph", () => {
    const graph = composeStandardResearchGraphV1(
      "Which Confluence pages correspond to Jira work items?",
    );
    expect(graph.selectedRoleIds).toEqual([
      "jira-retrieval",
      "wiki-retrieval",
      "reconciler",
      "synthesizer",
    ]);
  });

  test("selects structurally different roles for Jira-only and cross-product briefs", () => {
    const jiraOnly = composeResearchGraphV1(brief("List open Jira tickets", ["jira"], "off"));
    const crossProduct = composeResearchGraphV1(brief("Which Confluence content is related to Jira tickets?", ["jira", "confluence"]));
    expect(jiraOnly.selectedRoleIds).toEqual(["jira-retrieval", "synthesizer"]);
    expect(crossProduct.selectedRoleIds).toEqual([
      "jira-retrieval",
      "wiki-retrieval",
      "reconciler",
      "synthesizer",
    ]);
    expect(crossProduct.nodes.find((node) => node.role === "synthesizer")?.dependsOn).toEqual([
      "research-node:jira-retrieval",
      "research-node:wiki-retrieval",
      "research-node:reconciler",
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

  test("reserves dedicated joins for deep or explicitly adversarial relation research", () => {
    const standard = composeResearchGraphV1(brief(
      "How do these pages describe the funnel, and which DEMO work items correspond to each stage?",
      ["jira", "confluence"],
    ));
    expect(standard.selectedRoleIds).not.toContain("cross-product-join");
    const deep = composeResearchGraphV1(brief(
      "How do these pages describe the funnel, and which DEMO work items correspond to each stage?",
      ["jira", "confluence"],
      "auto",
      "deep",
    ));
    expect(deep.selectedRoleIds).toContain("cross-product-join");
    expect(composeResearchGraphV1(brief(
      "Which Confluence content explicitly relates to Jira tickets?",
      ["jira", "confluence"],
    )).selectedRoleIds).toContain("cross-product-join");
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
