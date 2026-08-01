import { describe, expect, test } from "bun:test";
import { WorkspaceResearchClaimLedgerV1 } from "./claim-ledger.js";
import { createResearchEvidenceRecordV1, WorkspaceResearchEvidenceStoreV1 } from "./evidence-store.js";
import { normalizeResearchPacketModelBodyV2 } from "./packet-v2-normalizer.js";
import { createMemoryResearchWorkspace } from "./workspace.js";

const scope = {
  siteOrigin: "https://example.atlassian.net",
  jiraProjectKeys: ["ATLCLI"],
  confluenceSpaceKeys: ["DOCSY"],
};

const binding = {
  schema: "atlcli.research-scope-binding/v1" as const,
  id: "scope-binding:packet-normalizer:jira:ATLCLI",
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
  store: WorkspaceResearchEvidenceStoreV1;
  id: string;
  text: string;
}) {
  const created = await createResearchEvidenceRecordV1({
    source: {
      id: input.id,
      product: "jira",
      title: `${input.id} fixture`,
      url: `https://example.atlassian.net/browse/${input.id.slice("jira:".length)}`,
      issueKey: input.id.slice("jira:".length),
      projectKey: "ATLCLI",
      updatedAt: "2026-08-01T12:00:00.000Z",
    },
    content: {
      text: input.text,
      linkTargets: [],
      truncated: false,
      inputBytes: input.text.length,
    },
    scope,
    scopeBindings: [binding],
    capturedAt: "2026-08-01T12:01:00.000Z",
  });
  await input.store.put(created.record, created.chunks);
  return created;
}

describe("V2 research packet normalization", () => {
  test("derives a quote-free journal packet from host-verified claims", async () => {
    const workspace = createMemoryResearchWorkspace();
    const evidenceStore = new WorkspaceResearchEvidenceStoreV1(workspace);
    const first = await retainedEvidence({
      store: evidenceStore,
      id: "jira:ATLCLI-42",
      text: "The delivery ticket explicitly links to the operating guide.",
    });
    const second = await retainedEvidence({
      store: evidenceStore,
      id: "jira:ATLCLI-43",
      text: "The operating guide requires verification before publication.",
    });
    const claimLedger = new WorkspaceResearchClaimLedgerV1(workspace, evidenceStore);
    const firstQuote = "explicitly links to the operating guide";
    const secondQuote = "requires verification before publication";

    const packet = await normalizeResearchPacketModelBodyV2({
      modelBody: {
        schema: "atlcli.research-packet-body/v2",
        claimCandidates: [
          {
            id: "candidate:link",
            classification: "fact",
            summary: "The delivery ticket references the guide.",
            support: [{ sourceId: first.record.source.id, quote: firstQuote }],
          },
          {
            id: "candidate:verification",
            classification: "fact",
            summary: "The guide imposes a verification requirement.",
            support: [{ sourceId: second.record.source.id, quote: secondQuote }],
          },
        ],
        contradictionCandidates: [{
          id: "contradiction:delivery-check",
          claimCandidateIds: ["candidate:link", "candidate:verification"],
          summary: "The two requirements need joint review before delivery.",
        }],
        outlineProposals: [{
          id: "outline:delivery",
          sectionId: "section:delivery",
          title: "Delivery readiness",
          question: "What evidence connects delivery to verification?",
          claimCandidateIds: ["candidate:link", "candidate:verification"],
          dependsOnSectionIds: [],
          coverageTargetIds: ["target:delivery"],
        }],
        gaps: [],
        proposedFollowUps: [],
        coverageLimits: [],
      },
      detailEvidence: [
        {
          source: first.record.source,
          content: { text: first.chunks[0]!.text, linkTargets: [], truncated: false, inputBytes: first.chunks[0]!.text.length },
          evidenceId: first.record.id,
        },
        {
          source: second.record.source,
          content: { text: second.chunks[0]!.text, linkTargets: [], truncated: false, inputBytes: second.chunks[0]!.text.length },
          evidenceId: second.record.id,
        },
      ],
      evidenceStore,
      claimLedger,
      createdAt: "2026-08-01T12:02:00.000Z",
    });

    expect(packet.claims).toHaveLength(2);
    expect(packet.claims.map((claim) => claim.claimId)).toEqual([
      expect.stringMatching(/^claim:[a-f0-9]{48}$/),
      expect.stringMatching(/^claim:[a-f0-9]{48}$/),
    ]);
    expect(packet.contradictions).toEqual([expect.objectContaining({
      claimIds: packet.claims.map((claim) => claim.claimId),
      evidenceIds: [first.record.id, second.record.id].sort(),
    })]);
    expect(packet.outlineProposals).toEqual([expect.objectContaining({
      claimIds: packet.claims.map((claim) => claim.claimId),
      evidenceIds: [first.record.id, second.record.id].sort(),
    })]);
    expect(JSON.stringify(packet)).not.toContain("\"quote\"");
    expect(JSON.stringify(packet)).not.toContain(firstQuote);
    expect(JSON.stringify(packet)).not.toContain(secondQuote);
    await expect(claimLedger.list()).resolves.toMatchObject({
      claims: [
        { freshness: "current", evidenceIds: [first.record.id] },
        { freshness: "current", evidenceIds: [second.record.id] },
      ],
    });
  });

  test("rejects a non-verbatim model packet before it becomes a canonical packet", async () => {
    const workspace = createMemoryResearchWorkspace();
    const evidenceStore = new WorkspaceResearchEvidenceStoreV1(workspace);
    const retained = await retainedEvidence({
      store: evidenceStore,
      id: "jira:ATLCLI-44",
      text: "The ticket links to the operating guide.",
    });
    const claimLedger = new WorkspaceResearchClaimLedgerV1(workspace, evidenceStore);

    await expect(normalizeResearchPacketModelBodyV2({
      modelBody: {
        schema: "atlcli.research-packet-body/v2",
        claimCandidates: [{
          id: "candidate:invalid",
          classification: "fact",
          summary: "The ticket references the guide.",
          support: [{ sourceId: retained.record.source.id, quote: "The ticket references the guide." }],
        }],
        contradictionCandidates: [],
        outlineProposals: [],
        gaps: [],
        proposedFollowUps: [],
        coverageLimits: [],
      },
      detailEvidence: [{
        source: retained.record.source,
        content: { text: retained.chunks[0]!.text, linkTargets: [], truncated: false, inputBytes: retained.chunks[0]!.text.length },
        evidenceId: retained.record.id,
      }],
      evidenceStore,
      claimLedger,
      createdAt: "2026-08-01T12:02:00.000Z",
    })).rejects.toThrow("does not exactly match");
    await expect(claimLedger.list()).resolves.toEqual({ claims: [] });
  });

  test("retains an abstaining V2 packet without creating a synthetic claim", async () => {
    const workspace = createMemoryResearchWorkspace();
    const evidenceStore = new WorkspaceResearchEvidenceStoreV1(workspace);
    const claimLedger = new WorkspaceResearchClaimLedgerV1(workspace, evidenceStore);
    await expect(normalizeResearchPacketModelBodyV2({
      modelBody: {
        schema: "atlcli.research-packet-body/v2",
        claimCandidates: [],
        contradictionCandidates: [],
        outlineProposals: [],
        gaps: [{
          id: "gap:no-detail",
          summary: "No detailed source was available for the bounded lookup.",
          sourceIds: [],
        }],
        proposedFollowUps: [],
        coverageLimits: ["No detailed source was retrieved."],
        abstentionReason: "The bounded lookup has no detail-backed support.",
      },
      detailEvidence: [],
      evidenceStore,
      claimLedger,
      createdAt: "2026-08-01T12:02:00.000Z",
    })).resolves.toMatchObject({
      claims: [],
      gaps: [{ id: "gap:no-detail" }],
      abstentionReason: "The bounded lookup has no detail-backed support.",
    });
    await expect(claimLedger.list()).resolves.toEqual({ claims: [] });
  });
});
