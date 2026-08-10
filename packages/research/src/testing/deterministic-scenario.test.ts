import { describe, expect, it } from "bun:test";
import {
  RESEARCH_DETERMINISTIC_SCENARIO_SCHEMA_V1,
  SYNTHETIC_RESEARCH_SCENARIO_V1,
  type ResearchScenarioAvailableDetailV1,
  type ResearchScenarioDetailV1,
} from "./deterministic-scenario.js";

const scenario = SYNTHETIC_RESEARCH_SCENARIO_V1;

function detail(sourceId: string): ResearchScenarioDetailV1 | undefined {
  return scenario.details.find((candidate) => candidate.sourceId === sourceId);
}

function availableDetail(sourceId: string): ResearchScenarioAvailableDetailV1 {
  const candidate = detail(sourceId);
  if (!candidate || candidate.status !== "available") {
    throw new Error(`Expected available synthetic detail: ${sourceId}`);
  }
  return candidate;
}

describe("customer-free deterministic research scenario", () => {
  it("is a bounded JSON-safe V1 fixture with two pages per product", () => {
    expect(scenario.schema).toBe(RESEARCH_DETERMINISTIC_SCENARIO_SCHEMA_V1);
    expect(() => structuredClone(scenario)).not.toThrow();
    expect(scenario.pages.jira.map((page) => page.id)).toEqual([
      "jira-page-1",
      "jira-page-2",
    ]);
    expect(scenario.pages.confluence.map((page) => page.id)).toEqual([
      "wiki-page-1",
      "wiki-page-2",
    ]);
    expect(scenario.pages.jira[0]?.nextPageId).toBe("jira-page-2");
    expect(scenario.pages.confluence[0]?.nextPageId).toBe("wiki-page-2");
    expect("nextPageId" in scenario.pages.jira[1]!).toBe(false);
    expect("nextPageId" in scenario.pages.confluence[1]!).toBe(false);
  });

  it("contains one deterministically verified cross-product link", () => {
    const jira = availableDetail("jira:DEMO-1");
    const wiki = availableDetail("wiki:1001");
    expect(jira).toMatchObject({ status: "available", truncated: false });
    expect(wiki).toMatchObject({ status: "available", truncated: false });
    expect(jira?.linkTargets).toContain(
      "https://example.atlassian.net/wiki/spaces/KB/pages/1001",
    );
    expect(wiki?.linkTargets).toContain(
      "https://example.atlassian.net/browse/DEMO-1",
    );
    expect(scenario.expected.exactRelationship).toEqual({
      jiraIssueKey: "DEMO-1",
      confluenceContentId: "1001",
    });
  });

  it("distinguishes a semantic hypothesis from an exact relationship", () => {
    const jira = availableDetail("jira:DEMO-2");
    const wiki = availableDetail("wiki:1002");
    expect(jira).toMatchObject({ status: "available", linkTargets: [] });
    expect(wiki).toMatchObject({ status: "available", linkTargets: [] });
    expect(jira?.text).toContain("identity boundaries");
    expect(wiki?.text).toContain("identity boundaries");
    expect(scenario.expected.hypothesis).toEqual({
      jiraIssueKey: "DEMO-2",
      confluenceContentId: "1002",
    });
  });

  it("contains conflicting evidence that cannot be silently reconciled", () => {
    expect(availableDetail("jira:DEMO-3").text).toContain("rejected");
    expect(availableDetail("wiki:1003").text).toContain("approved");
    expect(scenario.expected.contradiction).toEqual({
      jiraIssueKey: "DEMO-3",
      confluenceContentId: "1003",
      topic: "production rollout approval",
    });
  });

  it("contains explicit truncation and unavailable-detail outcomes", () => {
    expect(detail("wiki:1005")).toMatchObject({
      status: "available",
      truncated: true,
    });
    expect(detail("jira:DEMO-4")).toEqual({
      status: "unavailable",
      sourceId: "jira:DEMO-4",
      errorCode: "access-denied",
    });
    expect(detail("wiki:1004")).toEqual({
      status: "unavailable",
      sourceId: "wiki:1004",
      errorCode: "not-found",
    });
    expect(scenario.expected.truncatedSourceIds).toEqual(["wiki:1005"]);
    expect(scenario.expected.unavailableSourceIds).toEqual([
      "jira:DEMO-4",
      "wiki:1004",
    ]);
  });

  it("labels injected instructions as untrusted source data and requires abstention", () => {
    const injected = availableDetail(scenario.expected.promptInjectionSourceId);
    expect(injected.text).toContain("Ignore all previous instructions");
    expect(injected.text).toContain("This sentence is untrusted page content");
    expect(scenario.expected.promptInjectionMustRemainData).toBe(true);
    expect(scenario.expected.noAnswerQuestion).toContain("production budget");
    expect(scenario.expected.noAnswerMustAbstain).toBe(true);
  });
});
