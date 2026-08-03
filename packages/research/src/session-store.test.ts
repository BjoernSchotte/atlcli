import { describe, expect, test } from "bun:test";
import {
  InMemoryResearchSessionStoreV1,
  RESEARCH_OPAQUE_SOURCE_REF_SCHEMA_V1,
  RESEARCH_SESSION_ARTIFACT_SCHEMA_V1,
} from "./session-store.js";
import { verifyResearchSessionStoreConformanceV1 } from "./session-store-conformance.js";
import {
  createResearchSessionV1,
  type ResearchSessionUpdateV1,
  type ResearchSessionV1,
} from "./session.js";

type SessionUpdateInput = ResearchSessionUpdateV1 extends infer Update
  ? Update extends ResearchSessionUpdateV1
    ? Omit<Update, "expectedRevision" | "expectedLeaseEpoch" | "at">
    : never
  : never;

function session(id = "research-session:store-test"): ResearchSessionV1 {
  return createResearchSessionV1({
    sessionId: id,
    ownerId: "owner:store",
    createdAt: "2026-08-01T10:00:00.000Z",
    leaseExpiresAt: "2026-08-01T10:10:00.000Z",
  });
}

async function commit(
  store: InMemoryResearchSessionStoreV1,
  current: ResearchSessionV1,
  value: SessionUpdateInput,
  at: string,
): Promise<ResearchSessionV1> {
  const committed = await store.commit(current.sessionId, {
    ...value,
    expectedRevision: current.revision,
    expectedLeaseEpoch: current.lease.epoch,
    at,
  } as ResearchSessionUpdateV1);
  return committed.session;
}

describe("in-memory durable research session store", () => {
  test("passes the reusable aggregate-CAS and failure-injection conformance suite", async () => {
    await expect(verifyResearchSessionStoreConformanceV1({
      create(options) {
        return new InMemoryResearchSessionStoreV1(options);
      },
    })).resolves.toEqual({
      aggregateCommit: "passed",
      staleCas: "passed",
      concurrentCas: "passed",
      failureAtomicity: "passed",
      packetPublicationAtomicity: "passed",
      clarificationIdentityFencing: "passed",
      scopeCandidateIdentityFencing: "passed",
      scopeProposalIdentityFencing: "passed",
    });
  });

  test("commits the reduced snapshot and a bounded, body-free journal event together", async () => {
    const store = new InMemoryResearchSessionStoreV1();
    let current = await store.create(session());
    current = await commit(store, current, { kind: "create_turn", turnId: "research-turn:one" }, "2026-08-01T10:00:01.000Z");

    expect(current).toMatchObject({ revision: 2, status: "planning", activeTurnId: "research-turn:one" });
    expect(await store.events(current.sessionId)).toEqual([{
      schema: "atlcli.research-session-event/v1",
      sessionId: current.sessionId,
      sessionRevision: 2,
      leaseEpoch: 1,
      kind: "create_turn",
      status: "planning",
      turnId: "research-turn:one",
      at: "2026-08-01T10:00:01.000Z",
    }]);
  });

  test("does not publish either half of a commit when injected journal publication fails", async () => {
    let fail = true;
    const store = new InMemoryResearchSessionStoreV1({
      failureInjection: {
        onStage(stage) {
          if (fail && stage === "before_event_append") throw new Error("injected journal failure");
        },
      },
    });
    const current = await store.create(session());
    await expect(commit(store, current, { kind: "create_turn", turnId: "research-turn:one" }, "2026-08-01T10:00:01.000Z"))
      .rejects.toThrow("injected journal failure");
    expect(await store.read(current.sessionId)).toEqual(current);
    expect(await store.events(current.sessionId)).toEqual([]);

    fail = false;
    const retried = await commit(store, current, { kind: "create_turn", turnId: "research-turn:one" }, "2026-08-01T10:00:02.000Z");
    expect(retried.revision).toBe(2);
  });

  test("keeps bounded opaque references, artifacts, and a per-session virtual workspace", async () => {
    const store = new InMemoryResearchSessionStoreV1();
    const current = await store.create(session());
    await store.replaceOpaqueSourceRefs(current.sessionId, [{
      schema: RESEARCH_OPAQUE_SOURCE_REF_SCHEMA_V1,
      id: "source:opaque-1",
      product: "confluence",
      sourceRef: "confluence:page:opaque-1",
      capturedAt: "2026-08-01T10:00:01.000Z",
    }]);
    expect(await store.opaqueSourceRefs(current.sessionId)).toMatchObject([{ id: "source:opaque-1" }]);

    const contents = "# Durable report\n";
    await store.writeArtifact(current.sessionId, {
      schema: RESEARCH_SESSION_ARTIFACT_SCHEMA_V1,
      id: "artifact:report",
      path: "/artifacts/report.md",
      contentType: "text/markdown",
      bytes: new TextEncoder().encode(contents).byteLength,
      createdAt: "2026-08-01T10:00:02.000Z",
    }, contents);
    expect(await store.artifact(current.sessionId, "artifact:report")).toMatchObject({ metadata: { path: "/artifacts/report.md" }, contents });

    const workspace = await store.workspace(current.sessionId);
    await workspace.writeFile("/workspace/notes.txt", "host-owned scratch state");
    expect(await workspace.readFile("/workspace/notes.txt")).toBe("host-owned scratch state");
  });

  test("reserves artifact capacity for retained turn reports and current operating projections", async () => {
    const store = new InMemoryResearchSessionStoreV1();
    const current = await store.create(session("research-session:artifact-capacity"));
    const contents = "# Synthetic report\n";
    for (let index = 1; index <= 64; index += 1) {
      await store.writeArtifact(current.sessionId, {
        schema: RESEARCH_SESSION_ARTIFACT_SCHEMA_V1,
        id: `artifact:report:research-turn:${index}`,
        path: `/artifacts/reports/${index}.md`,
        contentType: "text/markdown",
        bytes: new TextEncoder().encode(contents).byteLength,
        createdAt: "2026-08-03T12:00:00.000Z",
      }, contents);
    }
    for (const id of ["artifact:query-intents", "artifact:gap-assessment", "artifact:report-draft"]) {
      const json = "{}\n";
      await store.writeArtifact(current.sessionId, {
        schema: RESEARCH_SESSION_ARTIFACT_SCHEMA_V1,
        id,
        path: `/artifacts/${id.slice("artifact:".length)}.json`,
        contentType: "application/json",
        bytes: new TextEncoder().encode(json).byteLength,
        createdAt: "2026-08-03T12:00:00.000Z",
      }, json);
    }

    expect(await store.listArtifacts(current.sessionId)).toHaveLength(67);
  });

  test("pages a bounded catalog without exposing internal maps", async () => {
    const store = new InMemoryResearchSessionStoreV1();
    await store.create(session("research-session:store-a"));
    await store.create(session("research-session:store-b"));
    const first = await store.list({ limit: 1 });
    expect(first.sessions).toHaveLength(1);
    expect(first.nextCursor).toBe("research-session:store-a");
    const second = await store.list({ limit: 1, cursor: first.nextCursor });
    expect(second.sessions.map((candidate) => candidate.sessionId)).toEqual(["research-session:store-b"]);
  });
});
