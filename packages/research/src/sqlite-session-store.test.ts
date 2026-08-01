import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResearchSessionV1, type ResearchSessionUpdateV1, type ResearchSessionV1 } from "./session.js";
import { researchCheckpointConfigV1 } from "./checkpoint-identity.js";
import { verifyResearchSessionStoreConformanceV1 } from "./session-store-conformance.js";
import { SqliteResearchSessionStoreV1 } from "./sqlite-session-store.js";
import { ResearchSessionWorkspaceCheckpointerV1 } from "./workspace-checkpointer.js";
import {
  WorkspaceResearchEvidenceStoreV1,
  createResearchEvidenceRecordV1,
} from "./evidence-store.js";
import {
  WorkspaceResearchClaimLedgerV1,
  createResearchClaimV1,
} from "./claim-ledger.js";

function session(): ResearchSessionV1 {
  return createResearchSessionV1({
    sessionId: "research-session:sqlite-test",
    ownerId: "owner:sqlite",
    createdAt: "2026-08-01T13:00:00.000Z",
    leaseExpiresAt: "2026-08-01T13:10:00.000Z",
  });
}

async function commitCreateTurn(store: SqliteResearchSessionStoreV1, current: ResearchSessionV1): Promise<ResearchSessionV1> {
  return (await store.commit(current.sessionId, {
    kind: "create_turn",
    turnId: "research-turn:sqlite",
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at: "2026-08-01T13:00:01.000Z",
  } satisfies ResearchSessionUpdateV1)).session;
}

describe("SQLite durable research session store", () => {
  test("passes the shared aggregate-CAS and failure-injection conformance suite", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-research-sqlite-conformance-"));
    const stores: SqliteResearchSessionStoreV1[] = [];
    let index = 0;
    try {
      await expect(verifyResearchSessionStoreConformanceV1({
        create(options) {
          const store = new SqliteResearchSessionStoreV1({
            databasePath: join(root, `session-${index++}.sqlite`),
            root: join(root, `root-${index}`),
            ...options,
          });
          stores.push(store);
          return store;
        },
      }, "research-session:sqlite-conformance")).resolves.toEqual({
        aggregateCommit: "passed",
        staleCas: "passed",
        failureAtomicity: "passed",
      });
    } finally {
      for (const store of stores) store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("survives reopen and creates a private per-session manifest, workspace, and artifact directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-research-sqlite-reopen-"));
    const databasePath = join(root, "catalog.sqlite");
    const sessionRoot = join(root, "session-data");
    const first = new SqliteResearchSessionStoreV1({ databasePath, root: sessionRoot });
    try {
      const created = await first.create(session());
      const committed = await commitCreateTurn(first, created);
      const workspace = await first.workspace(committed.sessionId);
      await workspace.writeFile("/workspace/notes.md", "durable scratch");
      await first.writeArtifact(committed.sessionId, {
        schema: "atlcli.research-session-artifact/v1",
        id: "artifact:report",
        path: "/artifacts/report.md",
        contentType: "text/markdown",
        bytes: 9,
        createdAt: "2026-08-01T13:00:02.000Z",
      }, "# Report\n");
      first.close();

      const reopened = new SqliteResearchSessionStoreV1({ databasePath, root: sessionRoot });
      try {
        expect(await reopened.read(committed.sessionId)).toMatchObject({ revision: 2, status: "planning" });
        expect(await (await reopened.workspace(committed.sessionId)).readFile("/workspace/notes.md")).toBe("durable scratch");
        expect(await reopened.artifact(committed.sessionId, "artifact:report")).toMatchObject({ contents: "# Report\n" });
        const manifest = JSON.parse(await readFile(join(sessionRoot, "sessions", "sqlite-test", "manifest.json"), "utf8"));
        expect(manifest.revision).toBe(2);
      } finally {
        reopened.close();
      }
    } finally {
      try { first.close(); } catch { /* already closed */ }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replays LangGraph checkpoints from the per-session filesystem workspace after reopening SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-research-sqlite-checkpoint-"));
    const databasePath = join(root, "catalog.sqlite");
    const sessionRoot = join(root, "session-data");
    const first = new SqliteResearchSessionStoreV1({ databasePath, root: sessionRoot });
    try {
      const created = await first.create(session());
      const workspace = await first.workspace(created.sessionId);
      const config = researchCheckpointConfigV1({ sessionId: created.sessionId, checkpointNamespace: "agent" });
      const saver = new ResearchSessionWorkspaceCheckpointerV1(created.sessionId, workspace);
      const saved = await saver.put(config, {
        v: 4,
        id: "checkpoint:sqlite-reopen",
        ts: "2026-08-01T13:00:00.000Z",
        channel_values: { session: { durable: true } },
        channel_versions: { session: 1 },
        versions_seen: {},
      }, { source: "input", step: -1, parents: {} });
      await saver.putWrites(saved, [["pending", { sequence: 1 }]], "task:sqlite-checkpoint");
      first.close();

      const reopened = new SqliteResearchSessionStoreV1({ databasePath, root: sessionRoot });
      try {
        const recovered = new ResearchSessionWorkspaceCheckpointerV1(created.sessionId, await reopened.workspace(created.sessionId));
        await expect(recovered.getTuple(saved)).resolves.toMatchObject({
          checkpoint: { id: "checkpoint:sqlite-reopen", channel_values: { session: { durable: true } } },
          pendingWrites: [["task:sqlite-checkpoint", "pending", { sequence: 1 }]],
        });
      } finally {
        reopened.close();
      }
    } finally {
      try { first.close(); } catch { /* already closed */ }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replays private evidence chunks from the per-session filesystem workspace after reopening SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-research-sqlite-evidence-"));
    const databasePath = join(root, "catalog.sqlite");
    const sessionRoot = join(root, "session-data");
    const first = new SqliteResearchSessionStoreV1({ databasePath, root: sessionRoot });
    try {
      const created = await first.create(session());
      const evidence = await createResearchEvidenceRecordV1({
        source: {
          id: "wiki:123",
          product: "confluence",
          title: "Evidence fixture",
          url: "https://example.atlassian.net/wiki/spaces/DOCSY/pages/123",
          contentId: "123",
          spaceKey: "DOCSY",
          updatedAt: "2026-08-01T13:00:00.000Z",
        },
        content: { text: "Private durable evidence.", linkTargets: [], truncated: false, inputBytes: 25 },
        scope: {
          siteOrigin: "https://example.atlassian.net",
          jiraProjectKeys: ["ATLCLI"],
          confluenceSpaceKeys: ["DOCSY"],
        },
        scopeBindings: [{
          schema: "atlcli.research-scope-binding/v1",
          id: "scope-binding:sqlite:confluence:DOCSY",
          tenantOrigin: "https://example.atlassian.net",
          product: "confluence",
          entityKind: "space",
          entityRef: "scope-key:confluence:DOCSY",
          key: "DOCSY",
          name: "DOCSY",
          source: "cli_flag",
          authority: "locked",
        }],
        capturedAt: "2026-08-01T13:00:01.000Z",
      });
      const store = new WorkspaceResearchEvidenceStoreV1(await first.workspace(created.sessionId));
      await store.put(evidence.record, evidence.chunks);
      first.close();

      const reopened = new SqliteResearchSessionStoreV1({ databasePath, root: sessionRoot });
      try {
        const recovered = new WorkspaceResearchEvidenceStoreV1(await reopened.workspace(created.sessionId));
        await expect(recovered.get(evidence.record.id)).resolves.toMatchObject({
          id: evidence.record.id,
          identity: { canonicalId: "https://example.atlassian.net|confluence|page|123" },
        });
        await expect(recovered.chunks(evidence.record.id)).resolves.toMatchObject([
          { text: "Private durable evidence." },
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      try { first.close(); } catch { /* already closed */ }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replays span-verified claims from the per-session filesystem workspace after reopening SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-research-sqlite-claims-"));
    const databasePath = join(root, "catalog.sqlite");
    const sessionRoot = join(root, "session-data");
    const first = new SqliteResearchSessionStoreV1({ databasePath, root: sessionRoot });
    try {
      const created = await first.create(session());
      const workspace = await first.workspace(created.sessionId);
      const evidence = new WorkspaceResearchEvidenceStoreV1(workspace);
      const retained = await createResearchEvidenceRecordV1({
        source: {
          id: "jira:ATLCLI-42",
          product: "jira",
          title: "Claim fixture",
          url: "https://example.atlassian.net/browse/ATLCLI-42",
          issueKey: "ATLCLI-42",
          projectKey: "ATLCLI",
          updatedAt: "2026-08-01T13:00:00.000Z",
        },
        content: { text: "A private span supports this factual claim.", linkTargets: [], truncated: false, inputBytes: 45 },
        scope: {
          siteOrigin: "https://example.atlassian.net",
          jiraProjectKeys: ["ATLCLI"],
          confluenceSpaceKeys: ["DOCSY"],
        },
        scopeBindings: [{
          schema: "atlcli.research-scope-binding/v1",
          id: "scope-binding:sqlite:jira:ATLCLI",
          tenantOrigin: "https://example.atlassian.net",
          product: "jira",
          entityKind: "project",
          entityRef: "scope-key:jira:ATLCLI",
          key: "ATLCLI",
          name: "ATLCLI",
          source: "cli_flag",
          authority: "locked",
        }],
        capturedAt: "2026-08-01T13:00:01.000Z",
      });
      await evidence.put(retained.record, retained.chunks);
      const chunk = retained.chunks[0]!;
      const text = chunk.text.slice(0, 8);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      const claim = await createResearchClaimV1({
        evidenceStore: evidence,
        classification: "fact",
        statement: "A private span supports this factual claim.",
        evidenceSpans: [{
          evidenceId: retained.record.id,
          chunkId: chunk.id,
          start: chunk.start,
          end: chunk.start + text.length,
          textHash: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
        }],
        createdAt: "2026-08-01T13:00:02.000Z",
      });
      const ledger = new WorkspaceResearchClaimLedgerV1(workspace, evidence);
      await ledger.put(claim);
      first.close();

      const reopened = new SqliteResearchSessionStoreV1({ databasePath, root: sessionRoot });
      try {
        const reopenedWorkspace = await reopened.workspace(created.sessionId);
        const recovered = new WorkspaceResearchClaimLedgerV1(
          reopenedWorkspace,
          new WorkspaceResearchEvidenceStoreV1(reopenedWorkspace),
        );
        await expect(recovered.get(claim.id)).resolves.toMatchObject({
          id: claim.id,
          freshness: "current",
          evidenceIds: [retained.record.id],
        });
      } finally {
        reopened.close();
      }
    } finally {
      try { first.close(); } catch { /* already closed */ }
      await rm(root, { recursive: true, force: true });
    }
  });
});
