import { describe, expect, test } from "bun:test";
import {
  WorkspaceResearchEvidenceStoreV1,
  createResearchEvidenceRecordV1,
} from "./evidence-store.js";
import {
  WorkspaceResearchClaimLedgerV1,
} from "./claim-ledger.js";
import {
  normalizeResearchClaimCandidatesV2,
} from "./claim-candidate-normalizer.js";
import { createMemoryResearchWorkspace } from "./workspace.js";

const scope = {
  siteOrigin: "https://example.atlassian.net",
  jiraProjectKeys: ["ATLCLI"],
  confluenceSpaceKeys: ["DOCSY"],
};

const binding = {
  schema: "atlcli.research-scope-binding/v1" as const,
  id: "scope-binding:normalizer:jira:ATLCLI",
  tenantOrigin: scope.siteOrigin,
  product: "jira" as const,
  entityKind: "project" as const,
  entityRef: "scope-key:jira:ATLCLI",
  key: "ATLCLI",
  name: "ATLCLI",
  source: "cli_flag" as const,
  authority: "locked" as const,
};

async function retainedEvidence(input: {
  workspace: ReturnType<typeof createMemoryResearchWorkspace>;
  text?: string;
  updatedAt?: string;
}) {
  const store = new WorkspaceResearchEvidenceStoreV1(input.workspace);
  const created = await createResearchEvidenceRecordV1({
    source: {
      id: "jira:ATLCLI-42",
      product: "jira",
      title: "Claim candidate fixture",
      url: "https://example.atlassian.net/browse/ATLCLI-42",
      issueKey: "ATLCLI-42",
      projectKey: "ATLCLI",
      updatedAt: input.updatedAt ?? "2026-08-01T12:00:00.000Z",
    },
    content: {
      text: input.text ?? "The implementation plan explicitly links the issue to the retained Confluence page.",
      linkTargets: [],
      truncated: false,
      inputBytes: 90,
    },
    scope,
    scopeBindings: [binding],
    capturedAt: "2026-08-01T12:01:00.000Z",
  });
  await store.put(created.record, created.chunks);
  return { store, ...created };
}

describe("research claim candidate normalization", () => {
  test("converts one exact ephemeral model quote into a persisted span-verified claim", async () => {
    const workspace = createMemoryResearchWorkspace();
    const retained = await retainedEvidence({ workspace });
    const claims = new WorkspaceResearchClaimLedgerV1(workspace, retained.store);
    const quote = "explicitly links the issue to the retained Confluence page";
    const normalized = await normalizeResearchClaimCandidatesV2({
      candidates: [{
        id: "candidate:cross-link",
        classification: "fact",
        summary: "The issue contains an explicit link to the retained page.",
        support: [{ sourceId: "jira:ATLCLI-42", quote }],
      }],
      detailEvidence: [{
        source: retained.record.source,
        content: { text: retained.chunks[0]!.text, linkTargets: [], truncated: false, inputBytes: 90 },
        evidenceId: retained.record.id,
      }],
      evidenceStore: retained.store,
      claimLedger: claims,
      createdAt: "2026-08-01T12:02:00.000Z",
    });
    expect(normalized).toMatchObject([{
      candidateId: "candidate:cross-link",
      claim: {
        classification: "fact",
        statement: "The issue contains an explicit link to the retained page.",
        evidenceIds: [retained.record.id],
        evidenceSpans: [{
          evidenceId: retained.record.id,
          start: retained.chunks[0]!.text.indexOf(quote),
          end: retained.chunks[0]!.text.indexOf(quote) + quote.length,
        }],
      },
    }]);
    expect(JSON.stringify(normalized)).not.toContain(quote);
    await expect(claims.get(normalized[0]!.claim.id)).resolves.toMatchObject({
      freshness: "current",
      evidenceIds: [retained.record.id],
    });
  });

  test("rejects paraphrased, ambiguous, and non-durable quote support", async () => {
    const workspace = createMemoryResearchWorkspace();
    const retained = await retainedEvidence({
      workspace,
      text: "The implementation reference appears once. The implementation reference appears twice.",
    });
    const claims = new WorkspaceResearchClaimLedgerV1(workspace, retained.store);
    const normalize = (support: Array<{ sourceId: string; quote: string }>, evidenceId = retained.record.id) =>
      normalizeResearchClaimCandidatesV2({
        candidates: [{
          id: "candidate:invalid-support",
          classification: "fact",
          summary: "A bounded statement.",
          support,
        }],
        detailEvidence: [{
          source: retained.record.source,
          content: { text: retained.chunks[0]!.text, linkTargets: [], truncated: false, inputBytes: 90 },
          ...(evidenceId ? { evidenceId } : {}),
        }],
        evidenceStore: retained.store,
        claimLedger: claims,
        createdAt: "2026-08-01T12:02:00.000Z",
      });
    await expect(normalize([{ sourceId: "jira:ATLCLI-42", quote: "The issue has an implementation reference." }]))
      .rejects.toThrow("does not exactly match");
    await expect(normalize([{ sourceId: "jira:ATLCLI-42", quote: "implementation reference" }]))
      .rejects.toThrow("ambiguous");
    await expect(normalize([{ sourceId: "jira:ATLCLI-42", quote: "The implementation reference appears once." }], ""))
      .rejects.toThrow("does not reference durably retained");
  });

  test("rejects a quote that names an evidence version superseded before acceptance", async () => {
    const workspace = createMemoryResearchWorkspace();
    const first = await retainedEvidence({ workspace, updatedAt: "2026-08-01T12:00:00.000Z" });
    const second = await retainedEvidence({
      workspace,
      text: "The revised issue removes the previous Confluence reference.",
      updatedAt: "2026-08-02T12:00:00.000Z",
    });
    const claims = new WorkspaceResearchClaimLedgerV1(workspace, first.store);
    await expect(normalizeResearchClaimCandidatesV2({
      candidates: [{
        id: "candidate:stale-version",
        classification: "fact",
        summary: "A stale statement.",
        support: [{ sourceId: "jira:ATLCLI-42", quote: "explicitly links the issue to the retained Confluence page" }],
      }],
      detailEvidence: [{
        source: first.record.source,
        content: { text: first.chunks[0]!.text, linkTargets: [], truncated: false, inputBytes: 90 },
        evidenceId: first.record.id,
      }],
      evidenceStore: second.store,
      claimLedger: claims,
      createdAt: "2026-08-02T12:02:00.000Z",
    })).rejects.toThrow("superseded evidence version");
  });
});
