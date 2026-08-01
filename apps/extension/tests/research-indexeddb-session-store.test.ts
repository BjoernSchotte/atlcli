import { afterEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbResearchSessionStoreV1,
  RESEARCH_OPAQUE_SOURCE_REF_SCHEMA_V1,
  RESEARCH_SESSION_ARTIFACT_SCHEMA_V1,
  ResearchSessionWorkspaceCheckpointerV1,
  WorkspaceResearchEvidenceStoreV1,
  createResearchEvidenceRecordV1,
  createResearchSessionV1,
  researchCheckpointConfigV1,
  verifyResearchSessionStoreConformanceV1,
} from "@atlcli/research";

const stores: IndexedDbResearchSessionStoreV1[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("IndexedDB durable research session store", () => {
  test("passes the same aggregate-CAS and failure-injection suite as the memory and SQLite adapters", async () => {
    const factory = new IDBFactory();
    let count = 0;
    await expect(verifyResearchSessionStoreConformanceV1({
      async create(options) {
        const store = await IndexedDbResearchSessionStoreV1.open({
          factory: factory as unknown as IDBFactory,
          databaseName: `research-session-conformance-${count++}`,
          ...options,
        });
        stores.push(store);
        return store;
      },
    }, "research-session:indexeddb-conformance")).resolves.toEqual({
      aggregateCommit: "passed",
      staleCas: "passed",
      failureAtomicity: "passed",
    });
  });

  test("survives reopening the database and persists workspace, source references, and Markdown artifacts", async () => {
    const factory = new IDBFactory();
    const databaseName = "research-session-reopen";
    const first = await IndexedDbResearchSessionStoreV1.open({ factory: factory as unknown as IDBFactory, databaseName });
    stores.push(first);
    const created = await first.create(createResearchSessionV1({
      sessionId: "research-session:indexeddb-test",
      ownerId: "owner:indexeddb",
      createdAt: "2026-08-01T14:00:00.000Z",
      leaseExpiresAt: "2026-08-01T14:10:00.000Z",
    }));
    const committed = await first.commit(created.sessionId, {
      kind: "create_turn",
      turnId: "research-turn:indexeddb",
      expectedRevision: created.revision,
      expectedLeaseEpoch: created.lease.epoch,
      at: "2026-08-01T14:00:01.000Z",
    });
    await first.replaceOpaqueSourceRefs(created.sessionId, [{
      schema: RESEARCH_OPAQUE_SOURCE_REF_SCHEMA_V1,
      id: "source:indexeddb-1",
      product: "jira",
      sourceRef: "jira:opaque:1",
      capturedAt: "2026-08-01T14:00:02.000Z",
    }]);
    await first.replaceOpaqueSourceRefs(created.sessionId, [{
      schema: RESEARCH_OPAQUE_SOURCE_REF_SCHEMA_V1,
      id: "source:indexeddb-2",
      product: "confluence",
      sourceRef: "confluence:opaque:2",
      capturedAt: "2026-08-01T14:00:02.500Z",
    }]);
    const workspace = await first.workspace(created.sessionId);
    await workspace.writeFile("/workspace/notes.md", "durable browser scratch");
    await first.writeArtifact(created.sessionId, {
      schema: RESEARCH_SESSION_ARTIFACT_SCHEMA_V1,
      id: "artifact:indexeddb-report",
      path: "/artifacts/report.md",
      contentType: "text/markdown",
      bytes: 9,
      createdAt: "2026-08-01T14:00:03.000Z",
    }, "# Report\n");
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = await IndexedDbResearchSessionStoreV1.open({ factory: factory as unknown as IDBFactory, databaseName });
    stores.push(reopened);
    expect(await reopened.read(created.sessionId)).toMatchObject({ revision: committed.session.revision, status: "planning" });
    expect(await reopened.opaqueSourceRefs(created.sessionId)).toMatchObject([{ id: "source:indexeddb-2" }]);
    expect(await (await reopened.workspace(created.sessionId)).readFile("/workspace/notes.md")).toBe("durable browser scratch");
    expect(await reopened.artifact(created.sessionId, "artifact:indexeddb-report")).toMatchObject({ contents: "# Report\n" });
  });

  test("replays LangGraph checkpoints from IndexedDB workspace storage after the worker reconnects", async () => {
    const factory = new IDBFactory();
    const databaseName = "research-session-checkpoint-reopen";
    const first = await IndexedDbResearchSessionStoreV1.open({ factory: factory as unknown as IDBFactory, databaseName });
    stores.push(first);
    const created = await first.create(createResearchSessionV1({
      sessionId: "research-session:indexeddb-checkpoint-test",
      ownerId: "owner:indexeddb-checkpoint",
      createdAt: "2026-08-01T14:00:00.000Z",
      leaseExpiresAt: "2026-08-01T14:10:00.000Z",
    }));
    const config = researchCheckpointConfigV1({ sessionId: created.sessionId, checkpointNamespace: "agent" });
    const firstSaver = new ResearchSessionWorkspaceCheckpointerV1(created.sessionId, await first.workspace(created.sessionId));
    const saved = await firstSaver.put(config, {
      v: 4,
      id: "checkpoint:indexeddb-reopen",
      ts: "2026-08-01T14:00:01.000Z",
      channel_values: { session: { durable: true } },
      channel_versions: { session: 1 },
      versions_seen: {},
    }, { source: "input", step: -1, parents: {} });
    await firstSaver.putWrites(saved, [["pending", { sequence: 1 }]], "task:indexeddb-checkpoint");
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = await IndexedDbResearchSessionStoreV1.open({ factory: factory as unknown as IDBFactory, databaseName });
    stores.push(reopened);
    const recovered = new ResearchSessionWorkspaceCheckpointerV1(created.sessionId, await reopened.workspace(created.sessionId));
    await expect(recovered.getTuple(saved)).resolves.toMatchObject({
      checkpoint: { id: "checkpoint:indexeddb-reopen", channel_values: { session: { durable: true } } },
      pendingWrites: [["task:indexeddb-checkpoint", "pending", { sequence: 1 }]],
    });
  });

  test("replays private evidence chunks from IndexedDB after the worker reconnects", async () => {
    const factory = new IDBFactory();
    const databaseName = "research-session-evidence-reopen";
    const first = await IndexedDbResearchSessionStoreV1.open({ factory: factory as unknown as IDBFactory, databaseName });
    stores.push(first);
    const created = await first.create(createResearchSessionV1({
      sessionId: "research-session:indexeddb-evidence-test",
      ownerId: "owner:indexeddb-evidence",
      createdAt: "2026-08-01T14:00:00.000Z",
      leaseExpiresAt: "2026-08-01T14:10:00.000Z",
    }));
    const evidence = await createResearchEvidenceRecordV1({
      source: {
        id: "jira:ATLCLI-42",
        product: "jira",
        title: "Evidence fixture",
        url: "https://example.atlassian.net/browse/ATLCLI-42",
        issueKey: "ATLCLI-42",
        projectKey: "ATLCLI",
        updatedAt: "2026-08-01T14:00:00.000Z",
      },
      content: { text: "Private browser evidence.", linkTargets: [], truncated: false, inputBytes: 25 },
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["ATLCLI"],
        confluenceSpaceKeys: ["DOCSY"],
      },
      scopeBindings: [{
        schema: "atlcli.research-scope-binding/v1",
        id: "scope-binding:indexeddb:jira:ATLCLI",
        tenantOrigin: "https://example.atlassian.net",
        product: "jira",
        entityKind: "project",
        entityRef: "scope-key:jira:ATLCLI",
        key: "ATLCLI",
        name: "ATLCLI",
        source: "cli_flag",
        authority: "locked",
      }],
      capturedAt: "2026-08-01T14:00:01.000Z",
    });
    await new WorkspaceResearchEvidenceStoreV1(await first.workspace(created.sessionId))
      .put(evidence.record, evidence.chunks);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = await IndexedDbResearchSessionStoreV1.open({ factory: factory as unknown as IDBFactory, databaseName });
    stores.push(reopened);
    const recovered = new WorkspaceResearchEvidenceStoreV1(await reopened.workspace(created.sessionId));
    await expect(recovered.get(evidence.record.id)).resolves.toMatchObject({
      id: evidence.record.id,
      identity: { canonicalId: "https://example.atlassian.net|jira|issue|ATLCLI-42" },
    });
    await expect(recovered.chunks(evidence.record.id)).resolves.toMatchObject([
      { text: "Private browser evidence." },
    ]);
  });
});
