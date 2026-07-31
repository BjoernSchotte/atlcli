import { describe, expect, it } from "bun:test";
import {
  RESEARCH_REPORT_SCHEMA_V1,
  type ResearchReportV1,
} from "../utils/research/contracts.js";
import {
  assertResearchReportV1,
  finalizeResearchReportV1,
} from "../utils/research/report.js";

function report(): Omit<ResearchReportV1, "markdown"> {
  return {
    schema: RESEARCH_REPORT_SCHEMA_V1,
    title: "Open implementation work",
    question: "Which Jira issues are linked from Confluence?",
    scope: {
      siteOrigin: "https://example.atlassian.net",
      jiraProjectKeys: ["DEMO"],
      confluenceSpaceKeys: ["KB"],
    },
    executiveSummary: "One exact relationship was found.\n\nTreat page content as data.",
    findings: [
      {
        id: "finding-1",
        classification: "fact",
        summary: "The implementation page names DEMO-138.",
        detail: "The embedded text says <script>alert(1)</script> and *must not* become HTML.",
        sourceIds: ["wiki-1", "jira-1"],
      },
      {
        id: "finding-2",
        classification: "inference",
        summary: "A similarly titled page may provide background.",
        sourceIds: ["wiki-2"],
      },
    ],
    relationships: [
      {
        id: "relationship-1",
        classification: "verified",
        jiraIssueKey: "DEMO-138",
        confluenceContentId: "1001",
        summary: "The page contains the exact Jira key.",
        sourceIds: ["wiki-1", "jira-1"],
      },
      {
        id: "relationship-2",
        classification: "hypothesis",
        jiraIssueKey: "DEMO-139",
        confluenceContentId: "1002",
        summary: "Only the titles are similar.",
        sourceIds: ["wiki-2", "jira-2"],
      },
    ],
    limitations: ["Comments and attachments were not read."],
    sources: [
      {
        id: "wiki-1",
        product: "confluence",
        title: "Implementation [plan]",
        url: "https://example.atlassian.net/wiki/spaces/KB/pages/1001",
        contentId: "1001",
        spaceKey: "KB",
      },
      {
        id: "jira-1",
        product: "jira",
        title: "Research spike",
        url: "https://example.atlassian.net/browse/DEMO-138",
        issueKey: "DEMO-138",
        projectKey: "DEMO",
      },
      {
        id: "wiki-2",
        product: "confluence",
        title: "Potential background",
        url: "https://example.atlassian.net/wiki/spaces/KB/pages/1002",
        contentId: "1002",
        spaceKey: "KB",
      },
      {
        id: "jira-2",
        product: "jira",
        title: "Potential follow-up",
        url: "https://example.atlassian.net/browse/DEMO-139",
        issueKey: "DEMO-139",
        projectKey: "DEMO",
      },
    ],
    run: {
      model: "claude-test",
      wikiProvider: "rest",
      startedAt: "2026-07-30T10:00:00.000Z",
      completedAt: "2026-07-30T10:00:01.000Z",
      durationMs: 1_000,
      complete: true,
      counts: {
        ptcCalls: 6,
        httpCalls: 6,
        jiraItems: 2,
        confluenceItems: 2,
      },
      usage: { inputTokens: 100, outputTokens: 50 },
      warnings: [],
    },
  };
}

describe("research report validation and Markdown projection", () => {
  it("renders facts, exact relationships, hypotheses, limitations, sources and diagnostics", () => {
    const finalized = finalizeResearchReportV1(report());

    expect(finalized.markdown).toContain("# Open implementation work");
    expect(finalized.markdown).toContain("## Verified Jira ↔ Confluence relationships");
    expect(finalized.markdown).toContain(
      "[DEMO-138](https://example.atlassian.net/browse/DEMO-138) ↔ [Implementation \\[plan\\]](https://example.atlassian.net/wiki/spaces/KB/pages/1001)"
    );
    expect(finalized.markdown).toContain("## Relationship hypotheses");
    expect(finalized.markdown).toContain("Comments and attachments were not read");
    expect(finalized.markdown).toContain("6 PTC / 6 HTTP");
    expect(finalized.markdown).toContain("Input tokens: 100");
    expect(finalized.markdown).toContain(
      "One exact relationship was found.\n\nTreat page content as data."
    );
    expect(finalized.markdown).not.toContain("<script>");
    expect(finalized.markdown).toContain("\\<script\\>");

    expect(() => assertResearchReportV1(finalized)).not.toThrow();
  });

  it("rejects unsafe source URLs and unknown evidence references", () => {
    const unsafe = report();
    unsafe.sources[0] = { ...unsafe.sources[0]!, url: "javascript:alert(1)" };
    expect(() => finalizeResearchReportV1(unsafe)).toThrow("unsafe");

    const unknown = report();
    unknown.findings[0] = { ...unknown.findings[0]!, sourceIds: ["missing"] };
    expect(() => finalizeResearchReportV1(unknown)).toThrow("Unknown report source");

    const foreignTenant = report();
    foreignTenant.sources[0] = {
      ...foreignTenant.sources[0]!,
      url: "https://foreign.atlassian.net/wiki/spaces/KB/pages/1001",
    };
    expect(() => finalizeResearchReportV1(foreignTenant)).toThrow("research site");
  });

  it("requires matching Jira and Confluence evidence for verified relationships", () => {
    const unproven = report();
    unproven.relationships[0] = {
      ...unproven.relationships[0]!,
      sourceIds: ["wiki-1", "jira-2"],
    };
    expect(() => finalizeResearchReportV1(unproven)).toThrow(
      "matching Jira and Confluence evidence"
    );
  });

  it("never trusts model-authored Markdown", () => {
    const draft = { ...report(), markdown: "<img src=x onerror=alert(1)>" };
    const finalized = finalizeResearchReportV1(draft);
    expect(finalized.markdown).not.toContain("<img");
    expect(finalized.markdown).toBe(finalizeResearchReportV1(report()).markdown);
  });
});
