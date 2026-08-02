import { describe, expect, test } from "bun:test";
import {
  RESEARCH_REPORT_SCHEMA_V2,
  RESEARCH_REQUEST_SCHEMA_V1,
  DEFAULT_RESEARCH_LIMITS_V1,
  normalizeResearchRequestV1,
  type ResearchRunSummaryV1,
} from "./contracts.js";
import type { ResearchClaimLedgerV1, ResearchClaimV1 } from "./claim-ledger.js";
import type { ResearchEvidenceRecordV1, ResearchEvidenceStoreV1 } from "./evidence-store.js";
import type { ResearchOutlineV1 } from "./outline.js";
import { assertResearchReportV2, finalizeResearchReportV2 } from "./report-v2.js";

const CURRENT_CLAIM = `claim:${"a".repeat(48)}`;
const STALE_CLAIM = `claim:${"b".repeat(48)}`;
const SECOND_CLAIM = `claim:${"e".repeat(48)}`;
const EVIDENCE = `evidence:${"c".repeat(48)}`;
const STALE_EVIDENCE = `evidence:${"d".repeat(48)}`;
const SECOND_EVIDENCE = `evidence:${"f".repeat(48)}`;

const request = normalizeResearchRequestV1({
  schema: RESEARCH_REQUEST_SCHEMA_V1,
  question: "Which implementation facts are currently supported?",
  scope: {
    siteOrigin: "https://example.atlassian.net",
    jiraProjectKeys: ["ATLCLI"],
    confluenceSpaceKeys: ["DOCSY"],
  },
  limits: DEFAULT_RESEARCH_LIMITS_V1,
  wikiProvider: "rest",
});

const run: ResearchRunSummaryV1 = {
  model: "claude-sonnet-4-6",
  wikiProvider: "rest",
  startedAt: "2026-08-01T12:00:00.000Z",
  completedAt: "2026-08-01T12:00:01.000Z",
  durationMs: 1_000,
  complete: true,
  counts: { ptcCalls: 2, httpCalls: 2, jiraItems: 1, confluenceItems: 0 },
  warnings: [],
};

function record(id: string, sourceId: string): ResearchEvidenceRecordV1 {
  return {
    schema: "atlcli.research-evidence-record/v1",
    id,
    identity: {
      tenantOrigin: "https://example.atlassian.net",
      product: "jira",
      entityKind: "issue",
      entityId: "ATLCLI-42",
      canonicalId: "https://example.atlassian.net|jira|issue|ATLCLI-42",
    },
    source: {
      id: sourceId,
      product: "jira",
      title: "Validated implementation item",
      url: "https://example.atlassian.net/browse/ATLCLI-42",
      issueKey: "ATLCLI-42",
      projectKey: "ATLCLI",
    },
    authority: { bindingId: "scope-binding:report:jira:ATLCLI", authorityClass: "whole_scope" },
    version: {
      contentHash: "e".repeat(64),
      capturedAt: "2026-08-01T12:00:00.000Z",
      truncated: false,
      inputBytes: 120,
    },
    contentChars: 120,
    linkTargets: [],
    chunkIds: [`${id}:chunk:000`],
  };
}

function claim(id: string, evidenceId: string, freshness: ResearchClaimV1["freshness"]): ResearchClaimV1 {
  return {
    schema: "atlcli.research-claim/v1",
    id,
    classification: "fact",
    statement: "The implementation item records a currently validated delivery fact.",
    evidenceIds: [evidenceId],
    evidenceSpans: [{
      evidenceId,
      chunkId: `${evidenceId}:chunk:000`,
      start: 0,
      end: 12,
      textHash: "f".repeat(64),
    }],
    scopeBindingIds: ["scope-binding:report:jira:ATLCLI"],
    freshness,
    createdAt: "2026-08-01T12:00:00.000Z",
    freshnessCheckedAt: "2026-08-01T12:00:00.000Z",
    ...(freshness === "invalidated"
      ? { invalidatedAt: "2026-08-01T12:00:00.000Z", invalidationReason: "evidence_missing" as const }
      : {}),
  };
}

function ports(input: {
  claims: readonly ResearchClaimV1[];
  records: readonly ResearchEvidenceRecordV1[];
}): { claimLedger: ResearchClaimLedgerV1; evidenceStore: ResearchEvidenceStoreV1 } {
  const claims = new Map(input.claims.map((entry) => [entry.id, entry]));
  const records = new Map(input.records.map((entry) => [entry.id, entry]));
  return {
    claimLedger: {
      async refresh(id: string) { return claims.get(id) && structuredClone(claims.get(id)!); },
    } as unknown as ResearchClaimLedgerV1,
    evidenceStore: {
      async get(id: string) { return records.get(id) && structuredClone(records.get(id)!); },
    } as unknown as ResearchEvidenceStoreV1,
  };
}

describe("V2 research report finalization", () => {
  test("renders canonical Markdown only from current ledger claims and retained sources", async () => {
    const current = claim(CURRENT_CLAIM, EVIDENCE, "current");
    const support = ports({ claims: [current], records: [record(EVIDENCE, "jira:ATLCLI-42")] });

    const report = await finalizeResearchReportV2({
      request,
      ...support,
      claimIds: [CURRENT_CLAIM],
      title: "Validated implementation report",
      limitations: ["The deterministic fixture covers one retained issue."],
      run,
      checkedAt: "2026-08-01T12:01:00.000Z",
    });

    expect(report).toMatchObject({
      schema: RESEARCH_REPORT_SCHEMA_V2,
      executiveSummaryClaimIds: [CURRENT_CLAIM],
      claims: [{ id: CURRENT_CLAIM, freshness: "current", sourceIds: ["jira:ATLCLI-42"] }],
    });
    expect(report.markdown).toContain("The implementation item records a currently validated delivery fact.");
    expect(report.markdown).toContain("[Validated implementation item](https://example.atlassian.net/browse/ATLCLI-42)");
    expect(report.markdown).not.toContain(EVIDENCE);
    expect(report.markdown).not.toContain(CURRENT_CLAIM);
  });

  test("derives sections and coverage from a validated outline without publishing stale support", async () => {
    const current = claim(CURRENT_CLAIM, EVIDENCE, "current");
    const stale = claim(STALE_CLAIM, STALE_EVIDENCE, "stale");
    const support = ports({
      claims: [current, stale],
      records: [record(EVIDENCE, "jira:ATLCLI-42"), record(STALE_EVIDENCE, "jira:ATLCLI-43")],
    });
    const outline = {
      schema: "atlcli.research-outline/v1",
      id: `outline:${"1".repeat(48)}`,
      revision: 1,
      basedOnBriefRevision: 1,
      createdAt: "2026-08-01T12:00:00.000Z",
      sections: [{
        id: "outline-section:delivery",
        title: "Delivery *evidence*",
        question: "What <is> currently established?",
        claimIds: [CURRENT_CLAIM, STALE_CLAIM],
        evidenceIds: [EVIDENCE, STALE_EVIDENCE],
        contradictionIds: [],
        coverageTargetIds: ["coverage:delivery"],
        dependsOnSectionIds: [],
      }],
      contradictions: [],
      coverage: [{
        schema: "atlcli.research-coverage-assessment/v1",
        targetId: "coverage:delivery",
        status: "covered",
        claimIds: [CURRENT_CLAIM, STALE_CLAIM],
        evidenceIds: [EVIDENCE, STALE_EVIDENCE],
        distinctSourceCount: 2,
        assessedAt: "2026-08-01T12:00:00.000Z",
      }],
    } as ResearchOutlineV1;

    const report = await finalizeResearchReportV2({
      request,
      ...support,
      outline,
      run,
      checkedAt: "2026-08-01T12:01:00.000Z",
    });

    expect(report.claims.map((entry) => entry.id)).toEqual([CURRENT_CLAIM]);
    expect(report.sections).toEqual([{
      id: "outline-section:delivery",
      title: "Delivery *evidence*",
      question: "What <is> currently established?",
      claimIds: [CURRENT_CLAIM],
      coverageTargetIds: ["coverage:delivery"],
    }]);
    expect(report.coverage).toEqual([{
      targetId: "coverage:delivery",
      status: "partial",
      claimIds: [CURRENT_CLAIM],
      evidenceIds: [EVIDENCE],
      distinctSourceCount: 1,
    }]);
    expect(report.limitations).toEqual([
      "A selected claim was excluded because its evidence is no longer current.",
    ]);
    expect(report.markdown).toContain("## Delivery \\*evidence\\*");
    expect(report.markdown).toContain("> Focus: What \\<is\\> currently established?");
    expect(report.markdown).not.toContain("## Findings");
  });

  test("uses only synthesizer-selected current sources and carries host run warnings into limitations", async () => {
    const current = claim(CURRENT_CLAIM, EVIDENCE, "current");
    const second = claim(SECOND_CLAIM, SECOND_EVIDENCE, "current");
    const secondRecord = {
      ...record(SECOND_EVIDENCE, "jira:ATLCLI-43"),
      identity: {
        tenantOrigin: "https://example.atlassian.net",
        product: "jira" as const,
        entityKind: "issue" as const,
        entityId: "ATLCLI-43",
        canonicalId: "https://example.atlassian.net|jira|issue|ATLCLI-43",
      },
      source: {
        id: "jira:ATLCLI-43",
        product: "jira" as const,
        title: "Selected implementation item",
        url: "https://example.atlassian.net/browse/ATLCLI-43",
        issueKey: "ATLCLI-43",
        projectKey: "ATLCLI",
      },
    } satisfies ResearchEvidenceRecordV1;
    const support = ports({
      claims: [current, second],
      records: [record(EVIDENCE, "jira:ATLCLI-42"), secondRecord],
    });

    const report = await finalizeResearchReportV2({
      request,
      ...support,
      claimIds: [CURRENT_CLAIM, SECOND_CLAIM],
      selectedSourceIds: ["jira:ATLCLI-43"],
      run: { ...run, warnings: ["Confluence search incomplete: item-limit."] },
      checkedAt: "2026-08-01T12:01:00.000Z",
    });

    expect(report.claims.map((entry) => entry.id)).toEqual([SECOND_CLAIM]);
    expect(report.sources.map((source) => source.id)).toEqual(["jira:ATLCLI-43"]);
    expect(report.limitations).toContain("Confluence search incomplete: item-limit.");
    await expect(finalizeResearchReportV2({
      request,
      ...support,
      claimIds: [CURRENT_CLAIM, SECOND_CLAIM],
      selectedSourceIds: ["jira:UNKNOWN"],
      run,
      checkedAt: "2026-08-01T12:01:00.000Z",
    })).rejects.toThrow("outside its current evidence");
  });

  test("fails closed when selected support is unknown or forged", async () => {
    const support = ports({ claims: [], records: [] });
    await expect(finalizeResearchReportV2({
      request,
      ...support,
      claimIds: [CURRENT_CLAIM],
      run,
      checkedAt: "2026-08-01T12:01:00.000Z",
    })).rejects.toThrow("not retained");

    expect(() => assertResearchReportV2({
      schema: RESEARCH_REPORT_SCHEMA_V2,
      title: "Forged report",
      question: request.question,
      scope: request.scope,
      executiveSummaryClaimIds: [CURRENT_CLAIM],
      claims: [{
        id: CURRENT_CLAIM,
        classification: "fact",
        statement: "Forged assertion.",
        freshness: "current",
        evidenceIds: [EVIDENCE],
        sourceIds: ["missing-source"],
      }],
      sections: [{
        id: "report-section:forged",
        title: "Forged",
        question: "What was forged?",
        claimIds: [CURRENT_CLAIM],
        coverageTargetIds: [],
      }],
      coverage: [],
      limitations: [],
      sources: [],
      run,
      markdown: "# Forged",
    })).toThrow("source is missing");
  });
});
