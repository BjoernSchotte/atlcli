import { afterEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbResearchSessionStoreV1,
  RESEARCH_OPAQUE_SOURCE_REF_SCHEMA_V1,
  RESEARCH_SESSION_ARTIFACT_SCHEMA_V1,
  createResearchSessionV1,
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
});
