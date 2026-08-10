import { afterEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IndexedDbResearchSessionStoreV1,
  RESEARCH_OPAQUE_SOURCE_REF_SCHEMA_V1,
  RESEARCH_SESSION_ARTIFACT_SCHEMA_V1,
  WorkspaceResearchEvidenceStoreV1,
  WorkspaceResearchClaimLedgerV1,
  WorkspaceResearchOutlineStoreV1,
  createResearchEvidenceRecordV1,
  createResearchClaimV1,
  createResearchOutlineV1,
  createResearchSessionV1,
  researchCheckpointConfigV1,
  verifyResearchDataStoreConformanceV1,
  verifyResearchSessionStoreConformanceV1,
  openDurableChatConversationWorkspaceV1,
  verifyChatRetrievalTraceConformanceV1,
} from "@atlcli/research";
import { SqliteResearchSessionStoreV1 } from "@atlcli/research/bun";
import { ResearchSessionWorkspaceCheckpointerV1 } from "@atlcli/research/browser/agent";

const stores: IndexedDbResearchSessionStoreV1[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function createVersionOneResearchDatabase(
  factory: IDBFactory,
  databaseName: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const open = factory.open(databaseName, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("sessions", { keyPath: "sessionId" });
      for (const name of ["events", "sourceRefs", "artifacts", "workspace"]) {
        const store = open.result.createObjectStore(name, { keyPath: ["sessionId", name === "events" ? "sessionRevision" : name === "workspace" ? "path" : "id"] });
        store.createIndex("bySession", "sessionId", { unique: false });
      }
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { open.result.close(); resolve(); };
  });
}

describe("IndexedDB durable research session store", () => {
  test("persists a byte-identical Chat retrieval plan and candidate trace to CLI SQLite and MV3 IndexedDB", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-chat-retrieval-parity-"));
    const sqlite = new SqliteResearchSessionStoreV1({
      databasePath: join(root, "catalog.sqlite"),
      root: join(root, "sessions"),
    });
    const browser = await IndexedDbResearchSessionStoreV1.open({
      factory: new IDBFactory() as unknown as IDBFactory,
      databaseName: "chat-retrieval-host-parity",
    });
    stores.push(browser);
    try {
      const lifecycle = {
        sessionId: "research-session:chat-retrieval-host-parity",
        createdAt: "2026-08-06T12:00:00.000Z",
        leaseExpiresAt: "2026-08-06T12:10:00.000Z",
      };
      const [cliWorkspace, mv3Workspace] = await Promise.all([
        openDurableChatConversationWorkspaceV1({
          store: sqlite,
          ownerId: "owner:cli-chat-parity",
          ...lifecycle,
        }),
        openDurableChatConversationWorkspaceV1({
          store: browser,
          ownerId: "owner:mv3-chat-parity",
          ...lifecycle,
        }),
      ]);
      const [cliTrace, mv3Trace] = await Promise.all([
        verifyChatRetrievalTraceConformanceV1(cliWorkspace),
        verifyChatRetrievalTraceConformanceV1(mv3Workspace),
      ]);
      expect(cliTrace).toEqual(mv3Trace);
      expect(JSON.parse(cliTrace.plan)).toMatchObject({
        schema: "atlcli.chat-retrieval-plan/v1",
        conversationId: "conversation:host-parity",
      });
      expect(JSON.parse(cliTrace.candidateLedger)).toMatchObject({
        schema: "atlcli.chat-candidate-ledger/v1",
        candidates: [{ sourceId: "wiki:1001", state: "detail-read" }],
      });
      expect(JSON.parse(cliTrace.assessment)).toMatchObject({
        schema: "atlcli.chat-retrieval-assessment/v1",
        sufficient: true,
      });
    } finally {
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("upgrades a version-one browser database without replacing its session stores", async () => {
    const factory = new IDBFactory();
    const databaseName = "research-session-v1-upgrade";
    await createVersionOneResearchDatabase(factory as unknown as IDBFactory, databaseName);

    const migrated = await IndexedDbResearchSessionStoreV1.open({
      factory: factory as unknown as IDBFactory,
      databaseName,
    });
    stores.push(migrated);
    expect(migrated).toBeInstanceOf(IndexedDbResearchSessionStoreV1);
    const inspected = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open(databaseName);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => resolve(open.result);
    });
    expect([...inspected.objectStoreNames]).toEqual([
      "artifacts",
      "claimsWorkspace",
      "events",
      "evidenceWorkspace",
      "outlineWorkspace",
      "sessions",
      "sourceRefs",
      "workspace",
    ]);
    inspected.close();
  });

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
      concurrentCas: "passed",
      failureAtomicity: "passed",
      packetPublicationAtomicity: "passed",
      clarificationIdentityFencing: "passed",
      scopeCandidateIdentityFencing: "passed",
      scopeProposalIdentityFencing: "passed",
    });
  });

  test("passes the shared evidence, claim, and outline publication suite through separate IndexedDB data namespaces", async () => {
    const factory = new IDBFactory();
    let count = 0;
    await expect(verifyResearchDataStoreConformanceV1({
      async create({ sessionId }) {
        const store = await IndexedDbResearchSessionStoreV1.open({
          factory: factory as unknown as IDBFactory,
          databaseName: `research-data-conformance-${count++}`,
        });
        stores.push(store);
        const created = await store.create(createResearchSessionV1({
          sessionId,
          ownerId: "owner:indexeddb-data-conformance",
          createdAt: "2026-08-02T16:00:00.000Z",
          leaseExpiresAt: "2026-08-02T16:10:00.000Z",
        }));
        return {
          evidence: await store.researchDataWorkspace(created.sessionId, "evidence"),
          claims: await store.researchDataWorkspace(created.sessionId, "claims"),
          outline: await store.researchDataWorkspace(created.sessionId, "outline"),
        };
      },
    }, "research-session:indexeddb-data-conformance")).resolves.toEqual({
      evidencePublicationAtomicity: "passed",
      claimPublicationAtomicity: "passed",
      outlinePublicationAtomicity: "passed",
      spanAndBindingValidation: "passed",
      evidenceDrivenInvalidation: "passed",
      retentionDeletion: "passed",
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
    await new WorkspaceResearchEvidenceStoreV1(await first.researchDataWorkspace(created.sessionId, "evidence"))
      .put(evidence.record, evidence.chunks);
    expect(await (await first.workspace(created.sessionId)).list("/.atlcli/evidence")).toEqual([]);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = await IndexedDbResearchSessionStoreV1.open({ factory: factory as unknown as IDBFactory, databaseName });
    stores.push(reopened);
    const recovered = new WorkspaceResearchEvidenceStoreV1(await reopened.researchDataWorkspace(created.sessionId, "evidence"));
    await expect(recovered.get(evidence.record.id)).resolves.toMatchObject({
      id: evidence.record.id,
      identity: { canonicalId: "https://example.atlassian.net|jira|issue|ATLCLI-42" },
    });
    await expect(recovered.chunks(evidence.record.id)).resolves.toMatchObject([
      { text: "Private browser evidence." },
    ]);
  });

  test("replays span-verified claims from IndexedDB after the worker reconnects", async () => {
    const factory = new IDBFactory();
    const databaseName = "research-session-claim-reopen";
    const first = await IndexedDbResearchSessionStoreV1.open({ factory: factory as unknown as IDBFactory, databaseName });
    stores.push(first);
    const created = await first.create(createResearchSessionV1({
      sessionId: "research-session:indexeddb-claim-test",
      ownerId: "owner:indexeddb-claim",
      createdAt: "2026-08-01T14:00:00.000Z",
      leaseExpiresAt: "2026-08-01T14:10:00.000Z",
    }));
    const workspace = await first.workspace(created.sessionId);
    const evidence = new WorkspaceResearchEvidenceStoreV1(await first.researchDataWorkspace(created.sessionId, "evidence"));
    const claimsWorkspace = await first.researchDataWorkspace(created.sessionId, "claims");
    const outlineWorkspace = await first.researchDataWorkspace(created.sessionId, "outline");
    const retained = await createResearchEvidenceRecordV1({
      source: {
        id: "jira:ATLCLI-42",
        product: "jira",
        title: "Claim fixture",
        url: "https://example.atlassian.net/browse/ATLCLI-42",
        issueKey: "ATLCLI-42",
        projectKey: "ATLCLI",
        updatedAt: "2026-08-01T14:00:00.000Z",
      },
      content: { text: "A private browser span supports this fact.", linkTargets: [], truncated: false, inputBytes: 43 },
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
    await evidence.put(retained.record, retained.chunks);
    const chunk = retained.chunks[0]!;
    const text = chunk.text.slice(0, 8);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const claim = await createResearchClaimV1({
      evidenceStore: evidence,
      classification: "fact",
      statement: "A private browser span supports this fact.",
      evidenceSpans: [{
        evidenceId: retained.record.id,
        chunkId: chunk.id,
        start: chunk.start,
        end: chunk.start + text.length,
        textHash: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      }],
      createdAt: "2026-08-01T14:00:02.000Z",
    });
    await new WorkspaceResearchClaimLedgerV1(claimsWorkspace, evidence).put(claim);
    const outline = await createResearchOutlineV1({
      revision: 1,
      basedOnBriefRevision: 1,
      createdAt: "2026-08-01T14:00:03.000Z",
      sections: [{
        id: "outline-section:indexeddb-answer",
        title: "Evidence-backed answer",
        question: "What does the retained issue establish?",
        claimIds: [claim.id],
        evidenceIds: [retained.record.id],
        contradictionIds: [],
        coverageTargetIds: ["coverage:primary"],
        dependsOnSectionIds: [],
      }],
      contradictions: [],
      coverage: [{
        schema: "atlcli.research-coverage-assessment/v1",
        targetId: "coverage:primary",
        status: "covered",
        claimIds: [claim.id],
        evidenceIds: [retained.record.id],
        distinctSourceCount: 1,
        assessedAt: "2026-08-01T14:00:03.000Z",
      }],
    });
    await new WorkspaceResearchOutlineStoreV1({
      workspace: outlineWorkspace,
      evidenceStore: evidence,
      claimLedger: new WorkspaceResearchClaimLedgerV1(claimsWorkspace, evidence),
      coverageTargets: [{
        id: "coverage:primary",
        question: "What does the retained issue establish?",
        required: true,
        sourceClasses: ["jira"],
        minimumDistinctSources: 1,
      }],
    }).put(outline);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = await IndexedDbResearchSessionStoreV1.open({ factory: factory as unknown as IDBFactory, databaseName });
    stores.push(reopened);
    const reopenedEvidence = new WorkspaceResearchEvidenceStoreV1(await reopened.researchDataWorkspace(created.sessionId, "evidence"));
    const recovered = new WorkspaceResearchClaimLedgerV1(
      await reopened.researchDataWorkspace(created.sessionId, "claims"),
      reopenedEvidence,
    );
    await expect(recovered.get(claim.id)).resolves.toMatchObject({
      id: claim.id,
      freshness: "current",
      evidenceIds: [retained.record.id],
    });
    await expect(new WorkspaceResearchOutlineStoreV1({
      workspace: await reopened.researchDataWorkspace(created.sessionId, "outline"),
      evidenceStore: reopenedEvidence,
      claimLedger: recovered,
      coverageTargets: [{
        id: "coverage:primary",
        question: "What does the retained issue establish?",
        required: true,
        sourceClasses: ["jira"],
        minimumDistinctSources: 1,
      }],
    }).validateCurrent()).resolves.toMatchObject({
      revision: 1,
      sections: [{ claimIds: [claim.id], evidenceIds: [retained.record.id] }],
    });
  });

  test("keeps browser research data namespaces independent from checkpoints and releases their quotas after deletion", async () => {
    const factory = new IDBFactory();
    const store = await IndexedDbResearchSessionStoreV1.open({
      factory: factory as unknown as IDBFactory,
      databaseName: "research-session-data-namespace-quota",
      dataWorkspaceLimits: { evidence: 80, claims: 40, outline: 40 },
    });
    stores.push(store);
    const created = await store.create(createResearchSessionV1({
      sessionId: "research-session:indexeddb-data-namespace",
      ownerId: "owner:indexeddb-data-namespace",
      createdAt: "2026-08-01T14:00:00.000Z",
      leaseExpiresAt: "2026-08-01T14:10:00.000Z",
    }));
    const checkpointWorkspace = await store.workspace(created.sessionId);
    const evidenceWorkspace = await store.researchDataWorkspace(created.sessionId, "evidence");
    const claimsWorkspace = await store.researchDataWorkspace(created.sessionId, "claims");
    const outlineWorkspace = await store.researchDataWorkspace(created.sessionId, "outline");

    await checkpointWorkspace.writeFile("/session/checkpoint.json", "checkpoint state");
    await evidenceWorkspace.writeFile("/.atlcli/evidence/v1/chunks/one.json", "e".repeat(60));
    await expect(evidenceWorkspace.writeFile("/.atlcli/evidence/v1/chunks/two.json", "e".repeat(21)))
      .rejects.toThrow("quota is exhausted");
    await evidenceWorkspace.remove("/.atlcli/evidence/v1/chunks/one.json");
    await evidenceWorkspace.writeFile("/.atlcli/evidence/v1/chunks/two.json", "e".repeat(21));
    await claimsWorkspace.writeFile("/.atlcli/claims/v1/index.json", "c".repeat(40));
    await outlineWorkspace.writeFile("/.atlcli/outline/v1/index.json", "o".repeat(40));

    expect(await checkpointWorkspace.list()).toEqual(["/session/checkpoint.json"]);
    expect(await checkpointWorkspace.readFile("/.atlcli/evidence/v1/chunks/two.json")).toBeUndefined();
    expect(await evidenceWorkspace.list()).toEqual(["/.atlcli/evidence/v1/chunks/two.json"]);
    expect(await claimsWorkspace.list()).toEqual(["/.atlcli/claims/v1/index.json"]);
    expect(await outlineWorkspace.list()).toEqual(["/.atlcli/outline/v1/index.json"]);
  });
});
