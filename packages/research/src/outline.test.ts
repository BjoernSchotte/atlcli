import { describe, expect, test } from "bun:test";
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
  createResearchOutlineFromClaimsV1,
  createResearchOutlineV1,
  resolveResearchOutlineProposalV1,
  type ResearchOutlineV1,
} from "./outline.js";
import type { ResearchCoverageTargetV1 } from "./brief.js";
import { createMemoryResearchWorkspace } from "./workspace.js";

const scope = {
  siteOrigin: "https://example.atlassian.net",
  jiraProjectKeys: ["ATLCLI"],
  confluenceSpaceKeys: ["DOCSY"],
};

const bindings = [
  {
    schema: "atlcli.research-scope-binding/v1" as const,
    id: "scope-binding:outline:jira:ATLCLI",
    tenantOrigin: scope.siteOrigin,
    product: "jira" as const,
    entityKind: "project" as const,
    entityRef: "scope-key:jira:ATLCLI",
    key: "ATLCLI",
    name: "ATLCLI",
    source: "cli_flag" as const,
    authority: "locked" as const,
  },
  {
    schema: "atlcli.research-scope-binding/v1" as const,
    id: "scope-binding:outline:confluence:DOCSY",
    tenantOrigin: scope.siteOrigin,
    product: "confluence" as const,
    entityKind: "space" as const,
    entityRef: "scope-key:confluence:DOCSY",
    key: "DOCSY",
    name: "DOCSY",
    source: "cli_flag" as const,
    authority: "locked" as const,
  },
];

const coverageTargets: ResearchCoverageTargetV1[] = [
  {
    id: "coverage:primary",
    question: "How do the retained issue and page relate?",
    required: true,
    sourceClasses: ["jira", "confluence"],
    minimumDistinctSources: 2,
  },
];

async function digest(value: string): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function retainedSupport(workspace: ReturnType<typeof createMemoryResearchWorkspace>) {
  const evidence = new WorkspaceResearchEvidenceStoreV1(workspace);
  const jira = await createResearchEvidenceRecordV1({
    source: {
      id: "jira:ATLCLI-42",
      product: "jira",
      title: "Outline issue",
      url: "https://example.atlassian.net/browse/ATLCLI-42",
      issueKey: "ATLCLI-42",
      projectKey: "ATLCLI",
      updatedAt: "2026-08-01T13:00:00.000Z",
    },
    content: {
      text: "Private Jira evidence explicitly links to the retained Confluence page.",
      linkTargets: ["https://example.atlassian.net/wiki/spaces/DOCSY/pages/123"],
      truncated: false,
      inputBytes: 72,
    },
    scope,
    scopeBindings: bindings,
    capturedAt: "2026-08-01T13:00:01.000Z",
  });
  const wiki = await createResearchEvidenceRecordV1({
    source: {
      id: "wiki:123",
      product: "confluence",
      title: "Outline page",
      url: "https://example.atlassian.net/wiki/spaces/DOCSY/pages/123",
      contentId: "123",
      spaceKey: "DOCSY",
      updatedAt: "2026-08-01T13:00:00.000Z",
    },
    content: {
      text: "Private Confluence evidence identifies ATLCLI-42 as its implementation ticket.",
      linkTargets: ["https://example.atlassian.net/browse/ATLCLI-42"],
      truncated: false,
      inputBytes: 76,
    },
    scope,
    scopeBindings: bindings,
    capturedAt: "2026-08-01T13:00:01.000Z",
  });
  await evidence.put(jira.record, jira.chunks);
  await evidence.put(wiki.record, wiki.chunks);

  const claims = new WorkspaceResearchClaimLedgerV1(workspace, evidence);
  const createClaim = async (record: typeof jira.record, chunk: (typeof jira.chunks)[number], statement: string) => {
    const selected = chunk.text.slice(0, 16);
    return createResearchClaimV1({
      evidenceStore: evidence,
      classification: "fact",
      statement,
      evidenceSpans: [{
        evidenceId: record.id,
        chunkId: chunk.id,
        start: chunk.start,
        end: chunk.start + selected.length,
        textHash: await digest(selected),
      }],
      createdAt: "2026-08-01T13:00:02.000Z",
    });
  };
  const jiraClaim = await createClaim(jira.record, jira.chunks[0]!, "The Jira issue contains an explicit implementation reference.");
  const wikiClaim = await createClaim(wiki.record, wiki.chunks[0]!, "The Confluence page identifies the implementation ticket.");
  await claims.put(jiraClaim);
  await claims.put(wikiClaim);
  return { evidence, claims, jira, wiki, jiraClaim, wikiClaim };
}

async function outline(input: {
  jiraClaimId: string;
  wikiClaimId: string;
  jiraEvidenceId: string;
  wikiEvidenceId: string;
  revision?: number;
  supersedesOutlineId?: string;
  contradictionStatus?: "resolved" | "open";
  createdAt?: string;
}): Promise<ResearchOutlineV1> {
  const contradictionStatus = input.contradictionStatus ?? "resolved";
  return createResearchOutlineV1({
    revision: input.revision ?? 1,
    basedOnBriefRevision: 1,
    ...(input.supersedesOutlineId === undefined ? {} : { supersedesOutlineId: input.supersedesOutlineId }),
    createdAt: input.createdAt ?? "2026-08-01T13:00:03.000Z",
    sections: [
      {
        id: "outline-section:answer",
        title: "Evidence-backed answer",
        question: "What can the retained sources establish?",
        claimIds: [input.jiraClaimId, input.wikiClaimId],
        evidenceIds: [input.jiraEvidenceId, input.wikiEvidenceId],
        contradictionIds: ["contradiction:link-check"],
        coverageTargetIds: ["coverage:primary"],
        dependsOnSectionIds: [],
      },
      {
        id: "outline-section:limitations",
        title: "Coverage and limitations",
        question: "Which coverage boundaries remain visible?",
        claimIds: [],
        evidenceIds: [],
        contradictionIds: [],
        coverageTargetIds: ["coverage:primary"],
        dependsOnSectionIds: ["outline-section:answer"],
      },
    ],
    contradictions: [
      {
        schema: "atlcli.research-contradiction/v1",
        id: "contradiction:link-check",
        claimIds: [input.jiraClaimId, input.wikiClaimId],
        evidenceIds: [input.jiraEvidenceId, input.wikiEvidenceId],
        status: contradictionStatus,
        summary: "The two retained claims required an explicit link check.",
        detectedAt: "2026-08-01T13:00:03.000Z",
        ...(contradictionStatus === "resolved"
          ? { resolution: "Both details contain the same explicit cross-reference.", resolvedAt: "2026-08-01T13:00:04.000Z" }
          : {}),
      },
    ],
    coverage: [
      {
        schema: "atlcli.research-coverage-assessment/v1",
        targetId: "coverage:primary",
        status: "covered",
        claimIds: [input.jiraClaimId, input.wikiClaimId],
        evidenceIds: [input.jiraEvidenceId, input.wikiEvidenceId],
        distinctSourceCount: 2,
        assessedAt: "2026-08-01T13:00:03.000Z",
      },
    ],
  });
}

describe("research outline store", () => {
  test("derives coverage and section links only from current retained claims", async () => {
    const workspace = createMemoryResearchWorkspace();
    const support = await retainedSupport(workspace);
    const derived = await createResearchOutlineFromClaimsV1({
      claimIds: [support.jiraClaim.id, support.wikiClaim.id],
      claimLedger: support.claims,
      evidenceStore: support.evidence,
      coverageTargets,
      basedOnBriefRevision: 1,
      createdAt: "2026-08-01T13:00:03.000Z",
    });
    const store = new WorkspaceResearchOutlineStoreV1({
      workspace,
      evidenceStore: support.evidence,
      claimLedger: support.claims,
      coverageTargets,
    });

    const persisted = await store.put(derived);
    expect(persisted).toMatchObject({
      revision: 1,
      sections: [{
        id: "outline-section:validated-findings",
      }],
      coverage: [{
        targetId: "coverage:primary",
        status: "covered",
        distinctSourceCount: 2,
      }],
    });
    expect(persisted.sections[0]!.claimIds).toEqual(expect.arrayContaining([
      support.jiraClaim.id,
      support.wikiClaim.id,
    ]));
  });

  test("accepts only claim-linked planner structure and revises incomplete coverage host-side", async () => {
    const workspace = createMemoryResearchWorkspace();
    const support = await retainedSupport(workspace);
    const baseline = await createResearchOutlineFromClaimsV1({
      claimIds: [support.jiraClaim.id, support.wikiClaim.id],
      claimLedger: support.claims,
      evidenceStore: support.evidence,
      coverageTargets,
      basedOnBriefRevision: 1,
      createdAt: "2026-08-01T13:00:03.000Z",
    });
    const accepted = await resolveResearchOutlineProposalV1({
      baseline,
      claimLedger: support.claims,
      checkedAt: "2026-08-01T13:00:04.000Z",
      proposals: [{
        id: "proposal:relationship",
        sectionId: "relationship",
        title: "Cross-product evidence",
        question: "What do the retained Jira and Confluence claims establish together?",
        claimIds: [support.jiraClaim.id, support.wikiClaim.id],
        evidenceIds: ["evidence:untrusted-model-value"],
        dependsOnSectionIds: [],
        coverageTargetIds: ["coverage:primary"],
      }],
    });

    expect(accepted).toMatchObject({
      disposition: "accepted",
      outline: {
        sections: [{
          id: "outline-section:planned-1",
        }],
      },
    });
    expect(accepted.outline.sections[0]!.claimIds).toEqual(expect.arrayContaining([
      support.jiraClaim.id,
      support.wikiClaim.id,
    ]));
    expect(accepted.outline.sections[0]!.evidenceIds).toEqual(expect.arrayContaining([
      support.jira.record.id,
      support.wiki.record.id,
    ]));
    const store = new WorkspaceResearchOutlineStoreV1({ workspace, evidenceStore: support.evidence, claimLedger: support.claims, coverageTargets });
    await expect(store.put(accepted.outline)).resolves.toMatchObject({ id: accepted.outline.id });

    const revised = await resolveResearchOutlineProposalV1({
      baseline,
      claimLedger: support.claims,
      checkedAt: "2026-08-01T13:00:04.000Z",
      proposals: [{
        id: "proposal:partial",
        sectionId: "jira-only",
        title: "Jira evidence",
        question: "What does the retained Jira claim establish?",
        claimIds: [support.jiraClaim.id],
        evidenceIds: [],
        dependsOnSectionIds: [],
        coverageTargetIds: [],
      }],
    });
    expect(revised.disposition).toBe("revised");
    expect(revised.outline.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "outline-section:host-unassigned", claimIds: [support.wikiClaim.id] }),
    ]));
    expect(revised.outline.coverage).toEqual([expect.objectContaining({
      targetId: "coverage:primary",
      claimIds: expect.arrayContaining([support.jiraClaim.id, support.wikiClaim.id]),
      evidenceIds: expect.arrayContaining([support.jira.record.id, support.wiki.record.id]),
      distinctSourceCount: 2,
    })]);

    const rejected = await resolveResearchOutlineProposalV1({
      baseline,
      claimLedger: support.claims,
      checkedAt: "2026-08-01T13:00:04.000Z",
      proposals: [{
        id: "proposal:forged",
        sectionId: "forged",
        title: "Forged",
        question: "What was forged?",
        claimIds: [`claim:${"f".repeat(48)}`],
        evidenceIds: [],
        dependsOnSectionIds: [],
        coverageTargetIds: [],
      }],
    });
    expect(rejected).toMatchObject({ disposition: "rejected", reason: "invalid-proposal", outline: baseline });
  });

  test("persists a current evidence-linked outline without copying source text into the outline", async () => {
    const workspace = createMemoryResearchWorkspace();
    const support = await retainedSupport(workspace);
    const created = await outline({
      jiraClaimId: support.jiraClaim.id,
      wikiClaimId: support.wikiClaim.id,
      jiraEvidenceId: support.jira.record.id,
      wikiEvidenceId: support.wiki.record.id,
    });
    const first = new WorkspaceResearchOutlineStoreV1({ workspace, evidenceStore: support.evidence, claimLedger: support.claims, coverageTargets });
    await expect(first.put(created)).resolves.toMatchObject({ id: created.id, revision: 1 });
    const second = new WorkspaceResearchOutlineStoreV1({ workspace, evidenceStore: support.evidence, claimLedger: support.claims, coverageTargets });
    await expect(second.validateCurrent()).resolves.toMatchObject({
      id: created.id,
      coverage: [{ targetId: "coverage:primary", status: "covered", distinctSourceCount: 2 }],
    });
    const stored = await workspace.readFile(`/.atlcli/outlines/v1/outlines/${encodeURIComponent(created.id)}.json`);
    expect(stored).not.toContain("Private Jira evidence");
    expect(stored).not.toContain("Private Confluence evidence");
  });

  test("rejects caller-controlled coverage and claims affected by an open contradiction", async () => {
    const workspace = createMemoryResearchWorkspace();
    const support = await retainedSupport(workspace);
    const store = new WorkspaceResearchOutlineStoreV1({ workspace, evidenceStore: support.evidence, claimLedger: support.claims, coverageTargets });
    const open = await outline({
      jiraClaimId: support.jiraClaim.id,
      wikiClaimId: support.wikiClaim.id,
      jiraEvidenceId: support.jira.record.id,
      wikiEvidenceId: support.wiki.record.id,
      contradictionStatus: "open",
    });
    await expect(store.put(open)).rejects.toThrow("open contradiction");

    const wrongCoverage = structuredClone(await outline({
      jiraClaimId: support.jiraClaim.id,
      wikiClaimId: support.wikiClaim.id,
      jiraEvidenceId: support.jira.record.id,
      wikiEvidenceId: support.wiki.record.id,
    }));
    wrongCoverage.coverage[0]!.status = "partial";
    await expect(store.put(wrongCoverage)).rejects.toThrow("must be derived from retained evidence");
  });

  test("does not treat a truncated projection as complete coverage", async () => {
    const workspace = createMemoryResearchWorkspace();
    const evidence = new WorkspaceResearchEvidenceStoreV1(workspace);
    const retained = await createResearchEvidenceRecordV1({
      source: {
        id: "jira:ATLCLI-43",
        product: "jira",
        title: "Truncated outline issue",
        url: "https://example.atlassian.net/browse/ATLCLI-43",
        issueKey: "ATLCLI-43",
        projectKey: "ATLCLI",
      },
      content: { text: "Only a bounded excerpt is retained.", linkTargets: [], truncated: true, inputBytes: 100_000 },
      scope,
      scopeBindings: bindings,
      capturedAt: "2026-08-01T13:00:02.000Z",
    });
    await evidence.put(retained.record, retained.chunks);
    const claims = new WorkspaceResearchClaimLedgerV1(workspace, evidence);
    const partial = await createResearchOutlineV1({
      revision: 1,
      basedOnBriefRevision: 1,
      createdAt: "2026-08-01T13:00:03.000Z",
      sections: [{
        id: "outline-section:truncated-limit",
        title: "Coverage limitation",
        question: "What can the projection cover?",
        claimIds: [],
        evidenceIds: [],
        contradictionIds: [],
        coverageTargetIds: ["coverage:primary"],
        dependsOnSectionIds: [],
      }],
      contradictions: [],
      coverage: [{
        schema: "atlcli.research-coverage-assessment/v1",
        targetId: "coverage:primary",
        status: "partial",
        claimIds: [],
        evidenceIds: [retained.record.id],
        distinctSourceCount: 1,
        assessedAt: "2026-08-01T13:00:03.000Z",
      }],
    });
    const store = new WorkspaceResearchOutlineStoreV1({
      workspace,
      evidenceStore: evidence,
      claimLedger: claims,
      coverageTargets: [{
        id: "coverage:primary",
        question: "What can the projection cover?",
        required: true,
        sourceClasses: ["jira"],
        minimumDistinctSources: 1,
      }],
    });
    await expect(store.put(partial)).resolves.toMatchObject({ coverage: [{ status: "partial" }] });
    const overstated = structuredClone(partial);
    overstated.coverage[0]!.status = "covered";
    await expect(store.put(overstated)).rejects.toThrow("must be derived from retained evidence");
  });

  test("blocks publication when an already-persisted outline loses supporting evidence", async () => {
    const workspace = createMemoryResearchWorkspace();
    const support = await retainedSupport(workspace);
    const store = new WorkspaceResearchOutlineStoreV1({ workspace, evidenceStore: support.evidence, claimLedger: support.claims, coverageTargets });
    const created = await outline({
      jiraClaimId: support.jiraClaim.id,
      wikiClaimId: support.wikiClaim.id,
      jiraEvidenceId: support.jira.record.id,
      wikiEvidenceId: support.wiki.record.id,
    });
    await store.put(created);
    await support.evidence.remove(support.jira.record.id);
    await expect(store.validateCurrent()).rejects.toThrow("claim that is not current");
    await expect(support.claims.get(support.jiraClaim.id)).resolves.toMatchObject({
      freshness: "invalidated",
      invalidationReason: "evidence_missing",
    });
    await expect(store.current()).resolves.toMatchObject({ id: created.id });
  });

  test("retains the previously published outline after an interrupted pointer update", async () => {
    const durableWorkspace = createMemoryResearchWorkspace();
    const support = await retainedSupport(durableWorkspace);
    let writes = 0;
    const interruptedWorkspace = {
      readFile: (path: string) => durableWorkspace.readFile(path),
      async writeFile(path: string, contents: string) {
        if (path === "/.atlcli/outlines/v1/index.json" && writes++ > 0) {
          throw new Error("injected outline index interruption");
        }
        await durableWorkspace.writeFile(path, contents);
      },
      remove: (path: string) => durableWorkspace.remove(path),
      list: (prefix?: string) => durableWorkspace.list(prefix),
    };
    const first = await outline({
      jiraClaimId: support.jiraClaim.id,
      wikiClaimId: support.wikiClaim.id,
      jiraEvidenceId: support.jira.record.id,
      wikiEvidenceId: support.wiki.record.id,
    });
    const second = await outline({
      jiraClaimId: support.jiraClaim.id,
      wikiClaimId: support.wikiClaim.id,
      jiraEvidenceId: support.jira.record.id,
      wikiEvidenceId: support.wiki.record.id,
      revision: 2,
      supersedesOutlineId: first.id,
      createdAt: "2026-08-01T13:00:06.000Z",
    });
    const writer = new WorkspaceResearchOutlineStoreV1({ workspace: interruptedWorkspace, evidenceStore: support.evidence, claimLedger: support.claims, coverageTargets });
    await writer.put(first);
    await expect(writer.put(second)).rejects.toThrow("injected outline index interruption");
    const recovered = new WorkspaceResearchOutlineStoreV1({ workspace: durableWorkspace, evidenceStore: support.evidence, claimLedger: support.claims, coverageTargets });
    await expect(recovered.current()).resolves.toMatchObject({ id: first.id, revision: 1 });
    await expect(recovered.get(second.id)).resolves.toBeUndefined();
  });
});
