import { describe, expect, it } from "bun:test";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REPORT_SCHEMA_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  normalizeResearchRequestV1,
  type ResearchErrorCode,
  type ResearchReportV1,
} from "../utils/research/contracts.js";
import { RESEARCH_CAPABILITY_SCHEMAS } from "../utils/research/capability-contracts.js";
import { finalizeResearchReportV1 } from "../utils/research/report.js";
import type { ResearchWorkerResponseV1 } from "../utils/research/worker-protocol.js";

const EXPECTED_ERROR_CODES = [
  "invalid-request",
  "missing-key",
  "invalid-key",
  "not-atlassian",
  "not-authenticated",
  "access-denied",
  "rate-limited",
  "provider-error",
  "limit-exceeded",
  "cancelled",
  "invalid-report",
  "unknown",
] as const satisfies readonly ResearchErrorCode[];

type MissingResearchErrorCode = Exclude<
  ResearchErrorCode,
  (typeof EXPECTED_ERROR_CODES)[number]
>;
const ERROR_CODES_ARE_EXHAUSTIVE: MissingResearchErrorCode extends never
  ? true
  : never = true;

const REPORT_INPUT = {
  schema: RESEARCH_REPORT_SCHEMA_V1,
  title: "Synthetic V1 research report",
  question: "Which issue is implemented by the design page?",
  scope: {
    siteOrigin: "https://example.atlassian.net",
    jiraProjectKeys: ["DEMO"],
    confluenceSpaceKeys: ["KB"],
    timeWindow: { from: "2026-07-01", to: "2026-07-31" },
  },
  executiveSummary: "The implementation relationship is explicit.",
  findings: [
    {
      id: "finding:exact-link",
      classification: "fact",
      summary: "The design page names the issue.",
      detail: "The captured source contains an exact issue key.",
      sourceIds: ["jira:DEMO-1", "wiki:1001"],
    },
  ],
  relationships: [
    {
      id: "relationship:DEMO-1:1001",
      classification: "verified",
      jiraIssueKey: "DEMO-1",
      confluenceContentId: "1001",
      summary: "The Jira issue is explicitly linked to the design page.",
      sourceIds: ["jira:DEMO-1", "wiki:1001"],
    },
  ],
  limitations: ["Synthetic fixture only."],
  sources: [
    {
      id: "jira:DEMO-1",
      product: "jira",
      title: "Design issue",
      url: "https://example.atlassian.net/browse/DEMO-1",
      issueKey: "DEMO-1",
      projectKey: "DEMO",
      updatedAt: "2026-07-30T12:00:00.000Z",
    },
    {
      id: "wiki:1001",
      product: "confluence",
      title: "Design page",
      url: "https://example.atlassian.net/wiki/spaces/KB/pages/1001",
      contentId: "1001",
      spaceKey: "KB",
      updatedAt: "2026-07-29T12:00:00.000Z",
    },
  ],
  run: {
    model: "fixture-model",
    wikiProvider: "rest",
    startedAt: "2026-07-31T12:00:00.000Z",
    completedAt: "2026-07-31T12:00:01.000Z",
    durationMs: 1_000,
    complete: true,
    counts: {
      ptcCalls: 2,
      httpCalls: 4,
      jiraItems: 1,
      confluenceItems: 1,
    },
    usage: { inputTokens: 100, outputTokens: 50 },
    warnings: [],
  },
} as const satisfies Omit<ResearchReportV1, "markdown">;

const EXPECTED_MARKDOWN = `# Synthetic V1 research report

> Question: Which issue is implemented by the design page?

## Executive summary

The implementation relationship is explicit.

## Findings

### 1. The design page names the issue.

The captured source contains an exact issue key.

Sources: [Design issue](https://example.atlassian.net/browse/DEMO-1), [Design page](https://example.atlassian.net/wiki/spaces/KB/pages/1001)

## Verified Jira ↔ Confluence relationships

- [DEMO-1](https://example.atlassian.net/browse/DEMO-1) ↔ [Design page](https://example.atlassian.net/wiki/spaces/KB/pages/1001): The Jira issue is explicitly linked to the design page. — Evidence: [Design issue](https://example.atlassian.net/browse/DEMO-1), [Design page](https://example.atlassian.net/wiki/spaces/KB/pages/1001)

## Inferences

_None._

## Relationship hypotheses

_None._

## Limitations

- Synthetic fixture only.

## Sources

1. [Design issue](https://example.atlassian.net/browse/DEMO-1) — jira \`DEMO-1\`
2. [Design page](https://example.atlassian.net/wiki/spaces/KB/pages/1001) — confluence \`1001\`

## Run

- Model: \`fixture-model\`
- Confluence provider: \`rest\`
- Complete: yes
- Duration: 1000 ms
- Calls: 2 PTC / 4 HTTP
- Items: 1 Jira / 1 Confluence
- Input tokens: 100
- Output tokens: 50
`;

describe("issue-138 V1 compatibility fixtures", () => {
  it("freezes the normalized request and every bounded limit", () => {
    expect(
      normalizeResearchRequestV1({
        schema: RESEARCH_REQUEST_SCHEMA_V1,
        question: "  Which issue is implemented by the design page?  ",
        scope: REPORT_INPUT.scope,
        limits: {},
        wikiProvider: "rest",
      }),
    ).toEqual({
      schema: "atlcli.research-request/v1",
      question: "Which issue is implemented by the design page?",
      scope: REPORT_INPUT.scope,
      limits: {
        ...DEFAULT_RESEARCH_LIMITS_V1,
      },
      wikiProvider: "rest",
    });
  });

  it("freezes the four read capability schema pairs", () => {
    expect(RESEARCH_CAPABILITY_SCHEMAS).toEqual({
      "jira.issue.search": {
        input: "atlcli.ptc/jira.issue.search.input/v1",
        output: "atlcli.ptc/jira.issue.search.output/v1",
      },
      "jira.issue.get": {
        input: "atlcli.ptc/jira.issue.get.input/v1",
        output: "atlcli.ptc/jira.issue.get.output/v1",
      },
      "wiki.search": {
        input: "atlcli.ptc/wiki.search.input/v1",
        output: "atlcli.ptc/wiki.search.output/v1",
      },
      "wiki.page.get": {
        input: "atlcli.ptc/wiki.page.get.input/v1",
        output: "atlcli.ptc/wiki.page.get.output/v1",
      },
    });
  });

  it("freezes the structured report and canonical Markdown bytes", () => {
    const report = finalizeResearchReportV1(REPORT_INPUT);
    expect(report.schema).toBe("atlcli.research-report/v1");
    expect(report).toEqual({ ...REPORT_INPUT, markdown: EXPECTED_MARKDOWN });
    expect(new TextEncoder().encode(report.markdown)).toEqual(
      new TextEncoder().encode(EXPECTED_MARKDOWN),
    );
  });

  it("freezes the complete error-code set and worker error envelope", () => {
    expect(ERROR_CODES_ARE_EXHAUSTIVE).toBe(true);
    expect(EXPECTED_ERROR_CODES).toEqual([
      "invalid-request",
      "missing-key",
      "invalid-key",
      "not-atlassian",
      "not-authenticated",
      "access-denied",
      "rate-limited",
      "provider-error",
      "limit-exceeded",
      "cancelled",
      "invalid-report",
      "unknown",
    ]);
    const error: ResearchWorkerResponseV1 = {
      kind: "research-worker:error",
      runId: "run-fixture",
      code: "invalid-report",
      error: "The research report is invalid.",
    };
    expect(JSON.stringify(error)).toBe(
      '{"kind":"research-worker:error","runId":"run-fixture","code":"invalid-report","error":"The research report is invalid."}',
    );
  });
});
