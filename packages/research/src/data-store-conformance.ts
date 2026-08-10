import type {
  ResearchScopeBindingV1,
  ResearchScopeV1,
  ResearchSourceReferenceV1,
} from "./contracts.js";
import {
  WorkspaceResearchEvidenceStoreV1,
  createResearchEvidenceRecordV1,
  type ResearchEvidenceChunkV1,
  type ResearchEvidenceRecordV1,
} from "./evidence-store.js";
import {
  WorkspaceResearchClaimLedgerV1,
  createResearchClaimV1,
  type ResearchClaimV1,
} from "./claim-ledger.js";
import {
  WorkspaceResearchOutlineStoreV1,
  createResearchOutlineV1,
  type ResearchOutlineV1,
} from "./outline.js";
import type { ResearchCoverageTargetV1 } from "./brief.js";
import type { ResearchWorkspace } from "./workspace.js";

/** The three private data namespaces exposed by a durable host. */
export interface ResearchDataStoreConformanceWorkspacesV1 {
  evidence: ResearchWorkspace;
  claims: ResearchWorkspace;
  outline: ResearchWorkspace;
}

/**
 * Host tests provide their real private workspace namespaces. The suite is
 * deliberately independent of SQLite and IndexedDB so both adapters prove the
 * same publication, retention, and failure-recovery contract.
 */
export interface ResearchDataStoreConformanceFactoryV1 {
  create(input: { sessionId: string }):
    | ResearchDataStoreConformanceWorkspacesV1
    | Promise<ResearchDataStoreConformanceWorkspacesV1>;
  dispose?(workspaces: ResearchDataStoreConformanceWorkspacesV1): void | Promise<void>;
}

export interface ResearchDataStoreConformanceResultV1 {
  evidencePublicationAtomicity: "passed";
  claimPublicationAtomicity: "passed";
  outlinePublicationAtomicity: "passed";
  spanAndBindingValidation: "passed";
  evidenceDrivenInvalidation: "passed";
  retentionDeletion: "passed";
}

const SCOPE: ResearchScopeV1 = {
  siteOrigin: "https://example.atlassian.net",
  jiraProjectKeys: ["ATLCLI"],
  confluenceSpaceKeys: ["DOCSY"],
};

const BINDINGS: readonly ResearchScopeBindingV1[] = [{
  schema: "atlcli.research-scope-binding/v1",
  id: "scope-binding:conformance:jira:ATLCLI",
  tenantOrigin: SCOPE.siteOrigin,
  product: "jira",
  entityKind: "project",
  entityRef: "scope-key:jira:ATLCLI",
  key: "ATLCLI",
  name: "ATLCLI",
  source: "cli_flag",
  authority: "locked",
}];

const COVERAGE_TARGETS: readonly ResearchCoverageTargetV1[] = [{
  id: "coverage:conformance",
  question: "What does the bounded synthetic evidence establish?",
  required: true,
  sourceClasses: ["jira"],
  minimumDistinctSources: 1,
}];

const EVIDENCE_INDEX_PATH = "/.atlcli/evidence/v1/index.json";
const CLAIM_INDEX_PATH = "/.atlcli/claims/v1/index.json";
const OUTLINE_INDEX_PATH = "/.atlcli/outlines/v1/index.json";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Research data-store conformance failed: ${message}`);
}

async function expectFailure(callback: () => Promise<unknown>, message: string): Promise<void> {
  let failed = false;
  try {
    await callback();
  } catch {
    failed = true;
  }
  assert(failed, message);
}

function source(issueKey: string, updatedAt: string): ResearchSourceReferenceV1 {
  return {
    id: `jira:${issueKey}`,
    product: "jira",
    title: `Synthetic ${issueKey} evidence`,
    url: `https://example.atlassian.net/browse/${issueKey}`,
    issueKey,
    projectKey: "ATLCLI",
    updatedAt,
  };
}

async function evidence(issueKey: string, text: string, capturedAt: string) {
  return createResearchEvidenceRecordV1({
    source: source(issueKey, capturedAt),
    content: {
      text,
      linkTargets: [],
      truncated: false,
      inputBytes: new TextEncoder().encode(text).byteLength,
    },
    scope: SCOPE,
    scopeBindings: BINDINGS,
    capturedAt,
  });
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function claim(input: {
  evidenceStore: WorkspaceResearchEvidenceStoreV1;
  record: ResearchEvidenceRecordV1;
  chunk: ResearchEvidenceChunkV1;
  statement: string;
}): Promise<ResearchClaimV1> {
  const support = input.chunk.text.slice(0, Math.min(20, input.chunk.text.length));
  return createResearchClaimV1({
    evidenceStore: input.evidenceStore,
    classification: "fact",
    statement: input.statement,
    evidenceSpans: [{
      evidenceId: input.record.id,
      chunkId: input.chunk.id,
      start: input.chunk.start,
      end: input.chunk.start + support.length,
      textHash: await hash(support),
    }],
    createdAt: "2026-08-02T16:00:04.000Z",
  });
}

async function outline(input: {
  claim: ResearchClaimV1;
  record: ResearchEvidenceRecordV1;
  revision: number;
  supersedesOutlineId?: string;
}): Promise<ResearchOutlineV1> {
  return createResearchOutlineV1({
    revision: input.revision,
    basedOnBriefRevision: 1,
    ...(input.supersedesOutlineId === undefined ? {} : { supersedesOutlineId: input.supersedesOutlineId }),
    createdAt: `2026-08-02T16:00:0${input.revision}.000Z`,
    sections: [{
      id: "outline-section:conformance",
      title: "Validated synthetic finding",
      question: COVERAGE_TARGETS[0]!.question,
      claimIds: [input.claim.id],
      evidenceIds: [input.record.id],
      contradictionIds: [],
      coverageTargetIds: [COVERAGE_TARGETS[0]!.id],
      dependsOnSectionIds: [],
    }],
    contradictions: [],
    coverage: [{
      schema: "atlcli.research-coverage-assessment/v1",
      targetId: COVERAGE_TARGETS[0]!.id,
      status: "covered",
      claimIds: [input.claim.id],
      evidenceIds: [input.record.id],
      distinctSourceCount: 1,
      assessedAt: `2026-08-02T16:00:0${input.revision}.000Z`,
    }],
  });
}

/** Fail the second compact-index publication while leaving prior rows intact. */
function failSecondIndexWrite(workspace: ResearchWorkspace, indexPath: string): ResearchWorkspace {
  let indexWrites = 0;
  return {
    readFile: (path) => workspace.readFile(path),
    async writeFile(path, contents) {
      if (path === indexPath && indexWrites++ > 0) {
        throw new Error(`Injected interrupted publication for ${indexPath}.`);
      }
      await workspace.writeFile(path, contents);
    },
    remove: (path) => workspace.remove(path),
    list: (prefix) => workspace.list(prefix),
  };
}

/**
 * Verify the storage contract shared by the memory, filesystem/SQLite, and
 * IndexedDB host adapters. A newly constructed store after each injected
 * index-write failure must expose only the last complete publication.
 */
export async function verifyResearchDataStoreConformanceV1(
  factory: ResearchDataStoreConformanceFactoryV1,
  prefix = "research-session:data-store-conformance",
): Promise<ResearchDataStoreConformanceResultV1> {
  const workspaces = await factory.create({ sessionId: prefix });
  try {
    const primary = await evidence(
      "ATLCLI-42",
      "The primary retained evidence supports a bounded factual claim.",
      "2026-08-02T16:00:01.000Z",
    );
    const secondary = await evidence(
      "ATLCLI-43",
      "The secondary retained evidence supports an independently bounded claim.",
      "2026-08-02T16:00:02.000Z",
    );
    const durableEvidence = new WorkspaceResearchEvidenceStoreV1(workspaces.evidence);
    await durableEvidence.put(primary.record, primary.chunks);
    await durableEvidence.put(secondary.record, secondary.chunks);
    await expectFailure(
      () => createResearchEvidenceRecordV1({
        source: source("ATLCLI-46", "2026-08-02T16:00:02.500Z"),
        content: { text: "An unbound source must not become evidence.", linkTargets: [], truncated: false, inputBytes: 43 },
        scope: SCOPE,
        scopeBindings: [],
        capturedAt: "2026-08-02T16:00:02.500Z",
      }),
      "an unbound source was accepted as evidence",
    );
    const firstPage = await durableEvidence.list({ limit: 1 });
    assert(firstPage.records.length === 1 && firstPage.nextCursor, "evidence pagination did not retain a cursor");
    const secondPage = await durableEvidence.list({ limit: 1, cursor: firstPage.nextCursor });
    assert(secondPage.records.length === 1, "evidence pagination did not retain the next record");

    const laterComplete = await evidence(
      "ATLCLI-44",
      "A later complete evidence record remains durable after an index interruption test.",
      "2026-08-02T16:00:03.000Z",
    );
    const interruptedEvidence = await evidence(
      "ATLCLI-45",
      "An interrupted evidence record must remain unreachable after index publication fails.",
      "2026-08-02T16:00:04.000Z",
    );
    const interruptedEvidenceWriter = new WorkspaceResearchEvidenceStoreV1(
      failSecondIndexWrite(workspaces.evidence, EVIDENCE_INDEX_PATH),
    );
    await interruptedEvidenceWriter.put(laterComplete.record, laterComplete.chunks);
    await expectFailure(
      () => interruptedEvidenceWriter.put(interruptedEvidence.record, interruptedEvidence.chunks),
      "evidence index interruption did not fail publication",
    );
    const recoveredEvidence = new WorkspaceResearchEvidenceStoreV1(workspaces.evidence);
    assert((await recoveredEvidence.get(laterComplete.record.id))?.id === laterComplete.record.id,
      "the last complete evidence publication was not recovered");
    assert(await recoveredEvidence.get(interruptedEvidence.record.id) === undefined,
      "an interrupted evidence publication became reachable");

    const firstClaim = await claim({
      evidenceStore: recoveredEvidence,
      record: primary.record,
      chunk: primary.chunks[0]!,
      statement: "The primary synthetic evidence supports a factual claim.",
    });
    const interruptedClaim = await claim({
      evidenceStore: recoveredEvidence,
      record: secondary.record,
      chunk: secondary.chunks[0]!,
      statement: "The secondary synthetic evidence supports a factual claim.",
    });
    const interruptedClaimWriter = new WorkspaceResearchClaimLedgerV1(
      failSecondIndexWrite(workspaces.claims, CLAIM_INDEX_PATH),
      recoveredEvidence,
    );
    await interruptedClaimWriter.put(firstClaim);
    await expectFailure(
      () => interruptedClaimWriter.put(interruptedClaim),
      "claim index interruption did not fail publication",
    );
    const recoveredClaims = new WorkspaceResearchClaimLedgerV1(workspaces.claims, recoveredEvidence);
    assert((await recoveredClaims.get(firstClaim.id))?.id === firstClaim.id,
      "the last complete claim publication was not recovered");
    assert(await recoveredClaims.get(interruptedClaim.id) === undefined,
      "an interrupted claim publication became reachable");
    const malformedSpanClaim = await claim({
      evidenceStore: recoveredEvidence,
      record: primary.record,
      chunk: primary.chunks[0]!,
      statement: "A distinct claim with a deliberately invalid support hash.",
    });
    await expectFailure(
      () => recoveredClaims.put({
        ...malformedSpanClaim,
        evidenceSpans: malformedSpanClaim.evidenceSpans.map((span) => ({
          ...span,
          textHash: "0".repeat(64),
        })),
      }),
      "a claim with an invalid retained-evidence span was accepted",
    );

    const firstOutline = await outline({ claim: firstClaim, record: primary.record, revision: 1 });
    const interruptedOutline = await outline({
      claim: firstClaim,
      record: primary.record,
      revision: 2,
      supersedesOutlineId: firstOutline.id,
    });
    const interruptedOutlineWriter = new WorkspaceResearchOutlineStoreV1({
      workspace: failSecondIndexWrite(workspaces.outline, OUTLINE_INDEX_PATH),
      evidenceStore: recoveredEvidence,
      claimLedger: recoveredClaims,
      coverageTargets: COVERAGE_TARGETS,
    });
    await interruptedOutlineWriter.put(firstOutline);
    await expectFailure(
      () => interruptedOutlineWriter.put(interruptedOutline),
      "outline index interruption did not fail publication",
    );
    const recoveredOutline = new WorkspaceResearchOutlineStoreV1({
      workspace: workspaces.outline,
      evidenceStore: recoveredEvidence,
      claimLedger: recoveredClaims,
      coverageTargets: COVERAGE_TARGETS,
    });
    assert((await recoveredOutline.current())?.id === firstOutline.id,
      "the last complete outline publication was not recovered");
    assert(await recoveredOutline.get(interruptedOutline.id) === undefined,
      "an interrupted outline publication became reachable");

    assert((await recoveredOutline.validateCurrent())?.coverage[0]?.status === "covered",
      "the recovered outline did not retain its validated claim/evidence coverage");
    await recoveredEvidence.remove(primary.record.id);
    const invalidated = await recoveredClaims.refresh(firstClaim.id, "2026-08-02T16:00:09.000Z");
    assert(invalidated?.freshness === "invalidated" && invalidated.invalidationReason === "evidence_missing",
      "removing evidence did not invalidate its dependent claim");
    await expectFailure(
      () => recoveredOutline.validateCurrent(),
      "an outline remained publishable after its supporting evidence disappeared",
    );

    await recoveredEvidence.clear();
    await recoveredClaims.clear();
    await recoveredOutline.clear();
    assert((await recoveredEvidence.list()).records.length === 0, "evidence clear did not release records");
    assert((await recoveredClaims.list()).claims.length === 0, "claim clear did not release claims");
    assert(await recoveredOutline.current() === undefined, "outline clear did not release the current revision");
    assert((await workspaces.evidence.list("/.atlcli/evidence")).length === 0,
      "evidence clear retained private evidence files");
    assert((await workspaces.claims.list("/.atlcli/claims")).length === 0,
      "claim clear retained private claim files");
    assert((await workspaces.outline.list("/.atlcli/outlines")).length === 0,
      "outline clear retained private outline files");

    return {
      evidencePublicationAtomicity: "passed",
      claimPublicationAtomicity: "passed",
      outlinePublicationAtomicity: "passed",
      spanAndBindingValidation: "passed",
      evidenceDrivenInvalidation: "passed",
      retentionDeletion: "passed",
    };
  } finally {
    await factory.dispose?.(workspaces);
  }
}
