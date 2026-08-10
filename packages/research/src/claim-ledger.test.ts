import { describe, expect, test } from "bun:test";
import {
  WorkspaceResearchEvidenceStoreV1,
  createResearchEvidenceRecordV1,
  type ResearchEvidenceChunkV1,
} from "./evidence-store.js";
import {
  WorkspaceResearchClaimLedgerV1,
  createResearchClaimV1,
} from "./claim-ledger.js";
import { createMemoryResearchWorkspace } from "./workspace.js";

const scope = {
  siteOrigin: "https://example.atlassian.net",
  jiraProjectKeys: ["ATLCLI"],
  confluenceSpaceKeys: ["DOCSY"],
};

const bindings = [{
  schema: "atlcli.research-scope-binding/v1" as const,
  id: "scope-binding:claim-test:jira:ATLCLI",
  tenantOrigin: scope.siteOrigin,
  product: "jira" as const,
  entityKind: "project" as const,
  entityRef: "scope-key:jira:ATLCLI",
  key: "ATLCLI",
  name: "ATLCLI",
  source: "cli_flag" as const,
  authority: "locked" as const,
}];

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function retainedEvidence(input: {
  workspace: ReturnType<typeof createMemoryResearchWorkspace>;
  issueKey?: string;
  text?: string;
  truncated?: boolean;
}) {
  const evidenceStore = new WorkspaceResearchEvidenceStoreV1(input.workspace);
  const issueKey = input.issueKey ?? "ATLCLI-42";
  const created = await createResearchEvidenceRecordV1({
    source: {
      id: `jira:${issueKey}`,
      product: "jira",
      title: "Evidence fixture",
      url: `https://example.atlassian.net/browse/${issueKey}`,
      issueKey,
      projectKey: "ATLCLI",
      updatedAt: "2026-08-01T12:00:00.000Z",
    },
    content: {
      text: input.text ?? "The retained issue has a direct implementation reference.",
      linkTargets: [],
      truncated: input.truncated ?? false,
      inputBytes: 64,
    },
    scope,
    scopeBindings: bindings,
    capturedAt: "2026-08-01T12:01:00.000Z",
  });
  await evidenceStore.put(created.record, created.chunks);
  return { evidenceStore, ...created };
}

async function claim(input: {
  evidenceStore: WorkspaceResearchEvidenceStoreV1;
  recordId: string;
  chunk: ResearchEvidenceChunkV1;
  classification?: "fact" | "inference";
  statement?: string;
}) {
  const end = Math.min(input.chunk.end, input.chunk.start + 12);
  return createResearchClaimV1({
    evidenceStore: input.evidenceStore,
    classification: input.classification ?? "fact",
    statement: input.statement ?? "The issue has a direct implementation reference.",
    evidenceSpans: [{
      evidenceId: input.recordId,
      chunkId: input.chunk.id,
      start: input.chunk.start,
      end,
      textHash: await sha256(input.chunk.text.slice(0, end - input.chunk.start)),
    }],
    createdAt: "2026-08-01T12:02:00.000Z",
  });
}

describe("research claim ledger", () => {
  test("persists a span-verified factual claim across a fresh host", async () => {
    const workspace = createMemoryResearchWorkspace();
    const evidence = await retainedEvidence({ workspace });
    const created = await claim({
      evidenceStore: evidence.evidenceStore,
      recordId: evidence.record.id,
      chunk: evidence.chunks[0]!,
    });
    const first = new WorkspaceResearchClaimLedgerV1(workspace, evidence.evidenceStore);
    await expect(first.put(created)).resolves.toMatchObject({
      id: created.id,
      freshness: "current",
      scopeBindingIds: ["scope-binding:claim-test:jira:ATLCLI"],
    });

    const second = new WorkspaceResearchClaimLedgerV1(workspace, new WorkspaceResearchEvidenceStoreV1(workspace));
    await expect(second.get(created.id)).resolves.toMatchObject({
      statement: created.statement,
      evidenceIds: [evidence.record.id],
      freshness: "current",
    });
  });

  test("rejects factual use of truncated evidence but records a cautious inference as stale", async () => {
    const workspace = createMemoryResearchWorkspace();
    const evidence = await retainedEvidence({ workspace, truncated: true });
    await expect(claim({
      evidenceStore: evidence.evidenceStore,
      recordId: evidence.record.id,
      chunk: evidence.chunks[0]!,
    })).rejects.toThrow("factual claim cannot rely on truncated evidence");

    const inference = await claim({
      evidenceStore: evidence.evidenceStore,
      recordId: evidence.record.id,
      chunk: evidence.chunks[0]!,
      classification: "inference",
      statement: "The retained excerpt suggests an implementation reference.",
    });
    const ledger = new WorkspaceResearchClaimLedgerV1(workspace, evidence.evidenceStore);
    await expect(ledger.put(inference)).resolves.toMatchObject({ freshness: "stale" });
  });

  test("invalidates every dependent claim when evidence disappears", async () => {
    const workspace = createMemoryResearchWorkspace();
    const evidence = await retainedEvidence({ workspace });
    const created = await claim({ evidenceStore: evidence.evidenceStore, recordId: evidence.record.id, chunk: evidence.chunks[0]! });
    const ledger = new WorkspaceResearchClaimLedgerV1(workspace, evidence.evidenceStore);
    await ledger.put(created);
    await evidence.evidenceStore.remove(evidence.record.id);
    await expect(ledger.refresh(created.id, "2026-08-01T12:03:00.000Z")).resolves.toMatchObject({
      freshness: "invalidated",
      invalidationReason: "evidence_missing",
    });
  });

  test("retains the previous complete ledger when a later index publication is interrupted", async () => {
    const durableWorkspace = createMemoryResearchWorkspace();
    const firstEvidence = await retainedEvidence({ workspace: durableWorkspace, issueKey: "ATLCLI-42" });
    const secondEvidence = await retainedEvidence({ workspace: durableWorkspace, issueKey: "ATLCLI-43", text: "A second retained issue reference." });
    const firstClaim = await claim({ evidenceStore: firstEvidence.evidenceStore, recordId: firstEvidence.record.id, chunk: firstEvidence.chunks[0]! });
    const secondClaim = await claim({
      evidenceStore: secondEvidence.evidenceStore,
      recordId: secondEvidence.record.id,
      chunk: secondEvidence.chunks[0]!,
      statement: "A second issue has an implementation reference.",
    });
    let writes = 0;
    const interruptedWorkspace = {
      readFile: (path: string) => durableWorkspace.readFile(path),
      async writeFile(path: string, contents: string) {
        if (path === "/.atlcli/claims/v1/index.json" && writes++ > 0) {
          throw new Error("injected claim ledger interruption");
        }
        await durableWorkspace.writeFile(path, contents);
      },
      remove: (path: string) => durableWorkspace.remove(path),
      list: (prefix?: string) => durableWorkspace.list(prefix),
    };
    const writer = new WorkspaceResearchClaimLedgerV1(
      interruptedWorkspace,
      new WorkspaceResearchEvidenceStoreV1(durableWorkspace),
    );
    await writer.put(firstClaim);
    await expect(writer.put(secondClaim)).rejects.toThrow("injected claim ledger interruption");

    const recovered = new WorkspaceResearchClaimLedgerV1(durableWorkspace, new WorkspaceResearchEvidenceStoreV1(durableWorkspace));
    await expect(recovered.get(firstClaim.id)).resolves.toMatchObject({ id: firstClaim.id });
    await expect(recovered.get(secondClaim.id)).resolves.toBeUndefined();
  });
});
