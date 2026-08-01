import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResearchSessionV1, type ResearchSessionUpdateV1, type ResearchSessionV1 } from "./session.js";
import { verifyResearchSessionStoreConformanceV1 } from "./session-store-conformance.js";
import { SqliteResearchSessionStoreV1 } from "./sqlite-session-store.js";

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
});
