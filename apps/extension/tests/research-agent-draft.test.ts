import { describe, expect, it } from "bun:test";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  normalizeResearchRequestV1,
  type ResearchRunSummaryV1,
  type ResearchSourceReferenceV1,
} from "../utils/research/contracts.js";
import { finalizeResearchAgentDraftV1 } from "@atlcli/research";
import type { ResearchDetailEvidenceV1 } from "@atlcli/research";

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
    executiveSummary: "DEMO-1 and wiki:1001 describe the same guarded research flow.",
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
    expect(report.markdown).toContain(
      "[DEMO-1](https://example.atlassian.net/browse/DEMO-1)"
    );
    expect(report.markdown).toContain(
      "[Research design](https://example.atlassian.net/wiki/spaces/KB/pages/1001)"
    );
    expect(report.markdown).not.toContain("wiki:1001");
    expect(report.executiveSummary).toContain(
      "The implementation is documented. (wiki:1001)"
    );
    expect(report.executiveSummary).not.toContain(
      "describe the same guarded research flow"
    );
  });

  it("allows link-only Jira detail solely for an explicit verified relationship", () => {
    const evidence: ResearchDetailEvidenceV1[] = [
      {
        source: sources[0]!,
        content: {
          text: "",
          linkTargets: [
            "https://example.atlassian.net/wiki/spaces/KB/pages/1001",
          ],
          truncated: false,
          inputBytes: 88,
        },
      },
      {
        source: sources[1]!,
        content: {
          text: "Complete page without an issue key.",
          linkTargets: [],
          truncated: false,
          inputBytes: 35,
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

    expect(report.findings).toHaveLength(1);
    expect(report.relationships[0]?.classification).toBe("verified");
    expect(report.limitations.at(-1)).toContain(
      "1 link-only detail response was eligible only for explicit relationship verification"
    );
  });

  it("derives a verified relationship when the synthesizer misfiles an explicit link", () => {
    const misfiled = draft();
    misfiled.relationships = [];
    const report = finalizeResearchAgentDraftV1({
      draft: misfiled,
      request,
      sources,
      detailEvidence: [
        {
          source: sources[0]!,
          content: {
            text: "Summary: Implement guarded research",
            linkTargets: [
              "https://example.atlassian.net/wiki/spaces/KB/pages/1001",
            ],
            truncated: false,
            inputBytes: 90,
          },
        },
        {
          source: sources[1]!,
          content: {
            text: "Complete research design.",
            linkTargets: [],
            truncated: false,
            inputBytes: 25,
          },
        },
      ],
      run,
    });

    expect(report.relationships).toEqual([
      {
        id: "relationship-1",
        classification: "verified",
        jiraIssueKey: "DEMO-1",
        confluenceContentId: "1001",
        summary:
          "Retrieved Jira and Confluence detail evidence contains an explicit cross-reference.",
        sourceIds: ["jira:DEMO-1", "wiki:1001"],
      },
    ]);
  });

  it("drops a relationship when either endpoint was not read in full", () => {
    const report = finalizeResearchAgentDraftV1({
      draft: draft(),
      request,
      sources,
      detailEvidence: [],
      run,
    });

    expect(report.relationships).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.sources).toEqual([]);
    expect(report.executiveSummary).toContain("No non-empty, non-truncated");
  });

  it("excludes truncated evidence from published claims", () => {
    const report = finalizeResearchAgentDraftV1({
      draft: draft(),
      request,
      sources,
      detailEvidence: [
        {
          source: sources[1]!,
          content: {
            text: "Captured prefix without a Jira link.",
            linkTargets: [],
            truncated: true,
            inputBytes: 20_000,
          },
        },
      ],
      run: { ...run, complete: false },
    });

    expect(report.findings).toEqual([]);
    expect(report.relationships).toEqual([]);
    expect(report.sources).toEqual([]);
    expect(report.executiveSummary).toContain("No non-empty, non-truncated");
    expect(report.limitations.at(-1)).toStartWith(
      "1 truncated detail projection was excluded from published findings."
    );
    expect(report.limitations.at(-1)).toContain(
      "Candidate screening reached a configured search limit"
    );
    expect(report.markdown).not.toContain("captured excerpt");
  });

  it("keeps empty detail responses only as linked limitations", () => {
    const emptyDetailDraft = draft("hypothesis");
    emptyDetailDraft.limitations = [
      "DEMO-1 returned an empty description; wiki:1001 was readable.",
    ];
    const report = finalizeResearchAgentDraftV1({
      draft: emptyDetailDraft,
      request,
      sources,
      detailEvidence: [
        {
          source: sources[0]!,
          content: {
            text: "",
            linkTargets: [],
            truncated: false,
            inputBytes: 0,
          },
        },
        {
          source: sources[1]!,
          content: {
            text: "Complete wiki detail.",
            linkTargets: [],
            truncated: false,
            inputBytes: 21,
          },
        },
      ],
      run,
    });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.sourceIds).toEqual(["wiki:1001"]);
    expect(report.relationships).toEqual([]);
    expect(report.sources.map((source) => source.id)).toEqual([
      "jira:DEMO-1",
      "wiki:1001",
    ]);
    expect(report.limitations.at(-1)).toContain(
      "1 empty detail response was excluded"
    );
    expect(report.markdown).toContain(
      "[DEMO-1](https://example.atlassian.net/browse/DEMO-1) returned"
    );
  });

  it("drops a time-only relationship guess with no semantic or detail evidence", () => {
    const unrelatedSources: ResearchSourceReferenceV1[] = [
      { ...sources[0]!, title: "Code quality review" },
      { ...sources[1]!, title: "Munich conversations" },
    ];
    const report = finalizeResearchAgentDraftV1({
      draft: draft("hypothesis"),
      request,
      sources: unrelatedSources,
      detailEvidence: [],
      run,
    });

    expect(report.relationships).toEqual([]);
    expect(report.markdown).toContain("Relationship hypotheses\n\n_None._");
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

  it("deterministically clamps provider-native arrays before strict host validation", () => {
    const oversized = draft();
    oversized.findings[0]!.sourceIds = [
      "wiki:1001",
      ...Array.from({ length: 20 }, (_, index) => `unknown:${index}`),
    ];
    const report = finalizeResearchAgentDraftV1({
      draft: oversized,
      request,
      sources,
      detailEvidence: [
        {
          source: sources[1]!,
          content: {
            text: "Complete page detail.",
            linkTargets: [],
            truncated: false,
            inputBytes: 21,
          },
        },
      ],
      run,
    });
    expect(report.findings[0]?.sourceIds).toEqual(["wiki:1001"]);
  });
});
