import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  normalizeResearchRequestV1,
  type ResearchRunSummaryV1,
  type ResearchScopeBindingV1,
  type ResearchScopeV1,
} from "./contracts.js";
import { ResearchCapabilityBroker } from "./broker.js";
import {
  WorkspaceResearchEvidenceStoreV1,
  createResearchEvidenceRecordV1,
} from "./evidence-store.js";
import {
  WorkspaceResearchClaimLedgerV1,
  createResearchClaimV1,
} from "./claim-ledger.js";
import {
  WorkspaceResearchOutlineStoreV1,
  createResearchOutlineV1,
} from "./outline.js";
import { finalizeResearchReportV2 } from "./report-v2.js";
import { createMemoryResearchWorkspace } from "./workspace.js";
import { RESEARCH_CAPABILITY_SCHEMAS, type ResearchSearchOutputV1 } from "./capability-contracts.js";
import type { ResearchCoverageTargetV1 } from "./brief.js";

const SCOPE: ResearchScopeV1 = {
  siteOrigin: "https://example.atlassian.net",
  jiraProjectKeys: ["ATLCLI"],
  confluenceSpaceKeys: [],
};

const BINDING: ResearchScopeBindingV1 = {
  schema: "atlcli.research-scope-binding/v1",
  id: "scope-binding:report-invalidation:jira:ATLCLI",
  tenantOrigin: SCOPE.siteOrigin,
  product: "jira",
  entityKind: "project",
  entityRef: "scope-key:jira:ATLCLI",
  key: "ATLCLI",
  name: "ATLCLI",
  source: "cli_flag",
  authority: "locked",
};

const COVERAGE_TARGETS: readonly ResearchCoverageTargetV1[] = [{
  id: "coverage:source-currentness",
  question: "Which current Jira source supports the bounded fixture finding?",
  required: true,
  sourceClasses: ["jira"],
  minimumDistinctSources: 1,
}];

const REQUEST = normalizeResearchRequestV1({
  schema: RESEARCH_REQUEST_SCHEMA_V1,
  question: "What currently supports the bounded Jira fixture finding?",
  scope: SCOPE,
  limits: DEFAULT_RESEARCH_LIMITS_V1,
  wikiProvider: "rest",
});

const RUN: ResearchRunSummaryV1 = {
  model: "claude-sonnet-4-6",
  wikiProvider: "rest",
  startedAt: "2026-08-02T17:00:00.000Z",
  completedAt: "2026-08-02T17:00:01.000Z",
  durationMs: 1_000,
  complete: true,
  counts: { ptcCalls: 1, httpCalls: 1, jiraItems: 1, confluenceItems: 0 },
  warnings: [],
};

const ORIGINAL_TEXT = "The original detail explicitly supports the bounded currentness finding.";
const UPDATED_TEXT = "The updated detail replaces the original currentness finding.";

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function seedCurrentV2Support() {
  const workspace = createMemoryResearchWorkspace();
  const evidence = new WorkspaceResearchEvidenceStoreV1(workspace);
  const created = await createResearchEvidenceRecordV1({
    source: {
      id: "jira:ATLCLI-42",
      product: "jira",
      title: "Bounded currentness fixture",
      url: "https://example.atlassian.net/browse/ATLCLI-42",
      issueKey: "ATLCLI-42",
      projectKey: "ATLCLI",
      updatedAt: "2026-08-02T17:00:00.000Z",
    },
    content: {
      text: ORIGINAL_TEXT,
      linkTargets: [],
      truncated: false,
      inputBytes: new TextEncoder().encode(ORIGINAL_TEXT).byteLength,
    },
    scope: SCOPE,
    scopeBindings: [BINDING],
    capturedAt: "2026-08-02T17:00:00.000Z",
  });
  await evidence.put(created.record, created.chunks);

  const claims = new WorkspaceResearchClaimLedgerV1(workspace, evidence);
  const quote = "original detail explicitly supports";
  const claim = await createResearchClaimV1({
    evidenceStore: evidence,
    classification: "fact",
    statement: "The original Jira detail supports the bounded currentness finding.",
    evidenceSpans: [{
      evidenceId: created.record.id,
      chunkId: created.chunks[0]!.id,
      start: ORIGINAL_TEXT.indexOf(quote),
      end: ORIGINAL_TEXT.indexOf(quote) + quote.length,
      textHash: await sha256(quote),
    }],
    createdAt: "2026-08-02T17:00:01.000Z",
  });
  await claims.put(claim);

  const outlineStore = new WorkspaceResearchOutlineStoreV1({
    workspace,
    evidenceStore: evidence,
    claimLedger: claims,
    coverageTargets: COVERAGE_TARGETS,
  });
  await outlineStore.put(await createResearchOutlineV1({
    revision: 1,
    basedOnBriefRevision: 1,
    createdAt: "2026-08-02T17:00:02.000Z",
    sections: [{
      id: "outline-section:source-currentness",
      title: "Current source support",
      question: COVERAGE_TARGETS[0]!.question,
      claimIds: [claim.id],
      evidenceIds: [created.record.id],
      contradictionIds: [],
      coverageTargetIds: [COVERAGE_TARGETS[0]!.id],
      dependsOnSectionIds: [],
    }],
    contradictions: [],
    coverage: [{
      schema: "atlcli.research-coverage-assessment/v1",
      targetId: COVERAGE_TARGETS[0]!.id,
      status: "covered",
      claimIds: [claim.id],
      evidenceIds: [created.record.id],
      distinctSourceCount: 1,
      assessedAt: "2026-08-02T17:00:02.000Z",
    }],
  }));
  const outline = await outlineStore.validateCurrent();
  if (!outline) throw new Error("Expected a validated current fixture outline.");
  return { workspace, evidence, claims, claim, record: created.record, outline };
}

async function finalize(input: Awaited<ReturnType<typeof seedCurrentV2Support>>) {
  return finalizeResearchReportV2({
    request: REQUEST,
    evidenceStore: input.evidence,
    claimLedger: input.claims,
    outline: input.outline,
    run: RUN,
    checkedAt: "2026-08-02T17:00:03.000Z",
  });
}

describe("V2 report evidence invalidation", () => {
  test("revalidates retained evidence that exceeded the configured freshness interval without a model-visible tool call", async () => {
    const fixture = await seedCurrentV2Support();
    let providerReads = 0;
    const broker = new ResearchCapabilityBroker(REQUEST, {
      jira: {
        async searchPage() { throw new Error("Freshness revalidation must not search Jira."); },
        async getIssue() {
          providerReads += 1;
          return {
            issueKey: "ATLCLI-42",
            projectKey: "ATLCLI",
            title: "Bounded currentness fixture",
            updatedAt: "2026-08-02T17:00:00.000Z",
            content: {
              text: ORIGINAL_TEXT,
              linkTargets: [],
              truncated: false,
              inputBytes: new TextEncoder().encode(ORIGINAL_TEXT).byteLength,
            },
          };
        },
      },
      wiki: {
        async searchPage() { throw new Error("The Jira-only fixture must not search Confluence."); },
        async getPage() { throw new Error("The Jira-only fixture must not read Confluence."); },
      },
    }, {
      evidence: {
        store: fixture.evidence,
        claimLedger: fixture.claims,
        scopeBindings: [BINDING],
        capturedAt: () => "2026-08-02T17:20:00.000Z",
      },
    });

    await expect(broker.revalidateRetainedEvidence({
      evidenceIds: [fixture.record.id],
      checkedAt: "2026-08-02T17:20:00.000Z",
    })).resolves.toEqual({ considered: 1, fresh: 0, revalidated: 1, invalidated: 0 });
    expect(providerReads).toBe(1);
    expect(broker.budget.counts()).toMatchObject({ ptcCalls: 0, httpCalls: 0 });
    await expect(fixture.claims.refresh(fixture.claim.id, "2026-08-02T17:20:00.000Z"))
      .resolves.toMatchObject({ freshness: "current", freshnessCheckedAt: "2026-08-02T17:20:00.000Z" });
  });

  test("excludes a claim when an expired retained source can no longer be re-read in scope", async () => {
    const fixture = await seedCurrentV2Support();
    const broker = new ResearchCapabilityBroker(REQUEST, {
      jira: {
        async searchPage() { throw new Error("Freshness revalidation must not search Jira."); },
        async getIssue() {
          return {
            issueKey: "ATLCLI-42",
            projectKey: "OTHER",
            title: "Moved outside approved scope",
            updatedAt: "2026-08-02T17:20:00.000Z",
            content: {
              text: UPDATED_TEXT,
              linkTargets: [],
              truncated: false,
              inputBytes: new TextEncoder().encode(UPDATED_TEXT).byteLength,
            },
          };
        },
      },
      wiki: {
        async searchPage() { throw new Error("The Jira-only fixture must not search Confluence."); },
        async getPage() { throw new Error("The Jira-only fixture must not read Confluence."); },
      },
    }, {
      evidence: {
        store: fixture.evidence,
        claimLedger: fixture.claims,
        scopeBindings: [BINDING],
      },
    });

    await expect(broker.revalidateRetainedEvidence({
      evidenceIds: [fixture.record.id],
      checkedAt: "2026-08-02T17:20:00.000Z",
    })).resolves.toEqual({ considered: 1, fresh: 0, revalidated: 0, invalidated: 1 });
    await expect(fixture.claims.get(fixture.claim.id)).resolves.toMatchObject({
      freshness: "invalidated",
      invalidationReason: "scope_revoked",
    });
  });

  test("excludes a claim when an expired retained source is no longer readable", async () => {
    const fixture = await seedCurrentV2Support();
    const broker = new ResearchCapabilityBroker(REQUEST, {
      jira: {
        async searchPage() { throw new Error("Freshness revalidation must not search Jira."); },
        async getIssue() { throw new Error("Provider denied this retained detail read."); },
      },
      wiki: {
        async searchPage() { throw new Error("The Jira-only fixture must not search Confluence."); },
        async getPage() { throw new Error("The Jira-only fixture must not read Confluence."); },
      },
    }, {
      evidence: {
        store: fixture.evidence,
        claimLedger: fixture.claims,
        scopeBindings: [BINDING],
      },
    });

    await expect(broker.revalidateRetainedEvidence({
      evidenceIds: [fixture.record.id],
      checkedAt: "2026-08-02T17:20:00.000Z",
    })).resolves.toEqual({ considered: 1, fresh: 0, revalidated: 0, invalidated: 1 });
    await expect(fixture.claims.get(fixture.claim.id)).resolves.toMatchObject({
      freshness: "invalidated",
      invalidationReason: "provider_unavailable",
    });
  });

  test("turns an updated provider detail into a deterministic excluded-claim limitation", async () => {
    const fixture = await seedCurrentV2Support();
    await expect(finalize(fixture)).resolves.toMatchObject({
      claims: [{ id: fixture.claim.id, freshness: "current" }],
      coverage: [{ targetId: "coverage:source-currentness", status: "covered" }],
    });

    const broker = new ResearchCapabilityBroker(REQUEST, {
      jira: {
        async searchPage() {
          return {
            items: [{
              issueKey: "ATLCLI-42",
              projectKey: "ATLCLI",
              title: "Bounded currentness fixture",
              updatedAt: "2026-08-02T17:00:04.000Z",
            }],
          };
        },
        async getIssue() {
          return {
            issueKey: "ATLCLI-42",
            projectKey: "ATLCLI",
            title: "Bounded currentness fixture",
            updatedAt: "2026-08-02T17:00:04.000Z",
            content: {
              text: UPDATED_TEXT,
              linkTargets: [],
              truncated: false,
              inputBytes: new TextEncoder().encode(UPDATED_TEXT).byteLength,
            },
          };
        },
      },
      wiki: {
        async searchPage() { throw new Error("The Jira-only fixture must not search Confluence."); },
        async getPage() { throw new Error("The Jira-only fixture must not read Confluence."); },
      },
    }, {
      createEntityId: () => "updated-detail",
      evidence: {
        store: fixture.evidence,
        claimLedger: fixture.claims,
        scopeBindings: [BINDING],
        capturedAt: () => "2026-08-02T17:00:04.000Z",
      },
    });
    const page = await broker.invoke("jira.issue.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.search"].input,
      query: {},
    }) as ResearchSearchOutputV1;
    await broker.invoke("research.candidate.rank", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["research.candidate.rank"].input,
      product: "jira",
      entityRefs: page.items.map((item) => item.entityRef),
    });
    await broker.invoke("jira.issue.get", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].input,
      entityRef: page.items[0]!.entityRef,
    });

    await expect(fixture.claims.get(fixture.claim.id)).resolves.toMatchObject({
      freshness: "invalidated",
      invalidationReason: "evidence_changed",
    });
    await expect(finalize(fixture)).resolves.toMatchObject({
      claims: [],
      coverage: [{ targetId: "coverage:source-currentness", status: "uncovered", claimIds: [] }],
      limitations: ["A selected claim was excluded because its evidence is no longer current."],
    });
  });

  test("turns deleted retained evidence into the same deterministic excluded-claim limitation", async () => {
    const fixture = await seedCurrentV2Support();
    await fixture.evidence.remove(fixture.record.id);

    await expect(finalize(fixture)).resolves.toMatchObject({
      claims: [],
      coverage: [{ targetId: "coverage:source-currentness", status: "uncovered", claimIds: [] }],
      limitations: ["A selected claim was excluded because its evidence is no longer current."],
    });
    await expect(fixture.claims.get(fixture.claim.id)).resolves.toMatchObject({
      freshness: "invalidated",
      invalidationReason: "evidence_missing",
    });
  });
});
