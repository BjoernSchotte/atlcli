import { describe, expect, it } from "bun:test";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  normalizeResearchRequestV1,
  type ResearchRunSummaryV1,
  type ResearchSourceReferenceV1,
} from "../utils/research/contracts.js";
import { finalizeResearchAgentDraftV1 } from "../utils/research/agent-draft.js";
import type { ResearchDetailEvidenceV1 } from "../utils/research/broker.js";

const request = normalizeResearchRequestV1({
  schema: RESEARCH_REQUEST_SCHEMA_V1,
  question: "How does DEMO-1 relate to the KB implementation page?",
  scope: {
    siteOrigin: "https://example.atlassian.net",
    jiraProjectKeys: ["DEMO"],
    confluenceSpaceKeys: ["KB"],
  },
  limits: DEFAULT_RESEARCH_LIMITS_V1,
  wikiProvider: "rest",
});

const sources: ResearchSourceReferenceV1[] = [
  {
    id: "jira:DEMO-1",
    product: "jira",
    title: "Implement guarded research",
    url: "https://example.atlassian.net/browse/DEMO-1",
    issueKey: "DEMO-1",
    projectKey: "DEMO",
  },
  {
    id: "wiki:1001",
    product: "confluence",
    title: "Research design",
    url: "https://example.atlassian.net/wiki/spaces/KB/pages/1001",
    contentId: "1001",
    spaceKey: "KB",
  },
];

const run: ResearchRunSummaryV1 = {
  model: "claude-sonnet-4-6",
  wikiProvider: "rest",
  startedAt: "2026-07-30T10:00:00.000Z",
  completedAt: "2026-07-30T10:00:01.000Z",
  durationMs: 1_000,
  complete: true,
  counts: {
    ptcCalls: 4,
    httpCalls: 4,
    jiraItems: 1,
    confluenceItems: 1,
  },
  warnings: [],
};

function draft(classification: "verified" | "hypothesis" = "verified") {
  return {
    title: "DEMO research",
    executiveSummary: "The issue and page describe the same guarded research flow.",
    findings: [
      {
        classification: "fact",
        summary: "The implementation is documented.",
        sourceIds: ["wiki:1001", "not-in-ledger"],
      },
    ],
    relationships: [
      {
        classification,
        jiraIssueKey: "DEMO-1",
        confluenceContentId: "1001",
        summary: "The page explicitly names the issue.",
        sourceIds: ["jira:DEMO-1", "wiki:1001"],
      },
    ],
    limitations: ["Synthetic evidence only."],
  };
}

describe("research agent draft finalization", () => {
  it("keeps verified relationships only when host-held detail evidence proves the join", () => {
    const evidence: ResearchDetailEvidenceV1[] = [
      {
        source: sources[0]!,
        content: {
          text: "See the research design page.",
          linkTargets: [
            "https://example.atlassian.net/wiki/spaces/KB/pages/1001",
          ],
          truncated: false,
          inputBytes: 40,
        },
      },
      {
        source: sources[1]!,
        content: {
          text: "This design implements DEMO-1.",
          linkTargets: [],
          truncated: false,
          inputBytes: 31,
        },
      },
    ];

    const report = finalizeResearchAgentDraftV1({
      draft: draft(),
      request,
      sources,
      detailEvidence: evidence,
      run,
    });

    expect(report.relationships[0]?.classification).toBe("verified");
    expect(report.findings[0]?.sourceIds).toEqual(["wiki:1001"]);
    expect(report.markdown).toContain("Verified Jira ↔ Confluence relationships");
    expect(report.markdown).toContain("`DEMO-1`");
  });

  it("downgrades an unproven model claim to a hypothesis", () => {
    const report = finalizeResearchAgentDraftV1({
      draft: draft(),
      request,
      sources,
      detailEvidence: [],
      run,
    });

    expect(report.relationships[0]?.classification).toBe("hypothesis");
    expect(report.markdown).toContain("Relationship hypotheses");
  });

  it("rejects model-authored fields outside the narrow structured draft", () => {
    expect(() =>
      finalizeResearchAgentDraftV1({
        draft: { ...draft(), markdown: "# untrusted" },
        request,
        sources,
        detailEvidence: [],
        run,
      })
    ).toThrow();
  });
});
