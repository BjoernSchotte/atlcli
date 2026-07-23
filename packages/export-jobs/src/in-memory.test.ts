import { describe, expect, it } from "bun:test";
import type { PendingArtifactV1 } from "./artifact.js";
import type { DocxExportJobRequestV1 } from "./request.js";
import { reconcileTombstonedExportJobCleanup } from "./cleanup.js";
import {
  InMemoryArtifactStore,
  InMemoryByteStoreConflict,
  InMemoryExportJobStore,
  InMemoryExportStoreConflict,
  InMemorySpoolStore,
} from "./in-memory.js";

function request(
  id: string,
  overrides: Partial<DocxExportJobRequestV1> = {},
): DocxExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `idem:${id}`,
    format: "docx",
    renderer: "docx-typescript",
    source: {
      kind: "confluence",
      siteOrigin: "https://a.example",
      locator: { kind: "space-key", spaceKey: "DOCS" },
      scope: { kind: "space" },
    },
    authRef: "profile:default",
    displayName: id,
    createdAt: 1,
    priority: "interactive",
    output: { policy: "collect" },
    template: { recordKey: "default", sha256: "0".repeat(64), name: "Default" },
    options: { embedImages: true, resolveMacros: true },
    ...overrides,
  };
}

async function* chunks(...values: number[][]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Uint8Array.from(value);
}

async function readAll(source: AsyncIterable<Uint8Array>): Promise<number[]> {
  const result: number[] = [];
  for await (const chunk of source) result.push(...chunk);
  return result;
}

const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function pendingArtifact(overrides: Partial<PendingArtifactV1> = {}): PendingArtifactV1 {
  return {
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    filename: "handbook.docx",
    byteLength: 3,
    sha256: ABC_SHA256,
    bytes: chunks([97], [98, 99]),
    ...overrides,
  };
}

describe("InMemoryExportJobStore", () => {
  it("creates atomically, deduplicates both keys, and returns defensive copies", async () => {
    const store = new InMemoryExportJobStore({ now: () => 10 });
    const original = request("job-1");
    const created = await store.create({ request: original });
    original.displayName = "mutated caller";
    created.summary.displayName = "mutated result";

    expect((await store.get("job-1"))?.summary.displayName).toBe("job-1");
    expect((await store.getRequest("request:job-1"))?.displayName).toBe("job-1");
    expect(
      await store.create({ request: request("job-1") }),
    ).toMatchObject({ id: "job-1", revision: 0 });

    await expect(
      store.create({
        request: request("other", {
          idempotencyKey: "idem:job-1",
          displayName: "different payload",
        }),
      }),
    ).rejects.toMatchObject({ code: "idempotency-conflict" });
  });

  it("validates replay ancestry and deduplicates fresh identities by action key", async () => {
    const store = new InMemoryExportJobStore({ now: () => 10 });
    const originRequest = request("origin", { displayName: "Handbook" });
    await store.create({ request: originRequest });
    const running = (await store.claimNext({ ownerId: "runner", now: 10, leaseDurationMs: 100 }))!;
    await store.compareAndSet({
      kind: "transition",
      id: "origin",
      expectedRevision: running.revision,
      leaseEpoch: running.leaseEpoch,
      to: "failed",
      at: 20,
      error: {
        code: "render.failed",
        message: "Render failed.",
        category: "render",
        retryable: true,
        occurredAt: 20,
      },
    });
    const derivedFrom = { jobId: "origin", relation: "retry" as const, actionKey: "click-1" };
    const child = request("child", {
      idempotencyKey: "idem:child",
      displayName: "Handbook",
      createdAt: 30,
      priority: "retry",
      output: { policy: "path", targetRef: "/exports/handbook.docx" },
    });
    expect(await store.create({ request: child, derivedFrom })).toMatchObject({
      id: "child",
      derivedFrom,
    });
    expect(
      await store.create({
        request: request("fresh-identity", {
          idempotencyKey: "idem:fresh",
          displayName: "Handbook",
          createdAt: 40,
          priority: "retry",
          output: { policy: "path", targetRef: "/exports/handbook.docx" },
        }),
        derivedFrom,
      }),
    ).toMatchObject({ id: "child" });
    await expect(
      store.create({
        request: request("conflicting-output", {
          idempotencyKey: "idem:conflicting-output",
          displayName: "Handbook",
          createdAt: 40,
          priority: "retry",
          output: { policy: "path", targetRef: "/exports/other.docx" },
        }),
        derivedFrom,
      }),
    ).rejects.toMatchObject({ code: "derivation-conflict" });
    await expect(
      store.create({
        request: request("forged", {
          displayName: "Different",
          createdAt: 40,
          priority: "retry",
        }),
        derivedFrom,
      }),
    ).rejects.toMatchObject({ code: "derivation-conflict" });
    await expect(
      store.create({
        request: request("missing-origin", { priority: "retry" }),
        derivedFrom: { ...derivedFrom, jobId: "missing", actionKey: "click-2" },
      }),
    ).rejects.toMatchObject({ code: "derivation-conflict" });
  });

  it("bounds history reads and applies filters without exposing stored rows", async () => {
    const store = new InMemoryExportJobStore({ now: () => 10 });
    for (let index = 0; index < 505; index += 1) {
      await store.create({ request: request(`job-${index}`, { createdAt: index + 1 }) });
    }
    expect((await store.list({ limit: 10_000 })).length).toBe(500);
    expect((await store.list()).length).toBe(100);
    expect((await store.list({ createdBefore: 3 })).map((job) => job.id)).toEqual([
      "job-1",
      "job-0",
    ]);
    expect((await store.list({ createdAfter: 503 })).map((job) => job.id)).toEqual([
      "job-504",
      "job-503",
    ]);
    const row = (await store.list({ limit: 1 }))[0]!;
    row.summary.displayName = "caller mutation";
    expect((await store.get(row.id))?.summary.displayName).not.toBe("caller mutation");
  });

  it("uses fair ordering and only auto-resumes waiting jobs whose until is due", async () => {
    const fair = new InMemoryExportJobStore({ now: () => 10 });
    await fair.create({
      request: request("a-later", {
        createdAt: 3,
        source: { ...request("x").source, siteOrigin: "https://a.example" },
      }),
    });
    await fair.create({
      request: request("b-first", {
        createdAt: 2,
        source: { ...request("x").source, siteOrigin: "https://b.example" },
      }),
    });
    await fair.create({
      request: request("retry", { createdAt: 1, priority: "retry" }),
    });
    expect((await fair.claimNext({ ownerId: "runner", now: 10, leaseDurationMs: 20 }))?.id).toBe(
      "b-first",
    );
    expect((await fair.claimNext({ ownerId: "runner", now: 10, leaseDurationMs: 20 }))?.id).toBe(
      "a-later",
    );
    expect((await fair.claimNext({ ownerId: "runner", now: 10, leaseDurationMs: 20 }))?.id).toBe(
      "retry",
    );

    let dueNow = 10;
    const due = new InMemoryExportJobStore({ now: () => dueNow });
    await due.create({ request: request("timed") });
    let running = (await due.claimNext({ ownerId: "runner", now: 10, leaseDurationMs: 100 }))!;
    await due.compareAndSet({
      kind: "transition",
      id: running.id,
      expectedRevision: running.revision,
      leaseEpoch: running.leaseEpoch,
      to: "waiting",
      at: 20,
      waiting: { reason: "backoff", until: 50 },
      checkpointRef: "checkpoint:timed",
    });
    expect(await due.claimNext({ ownerId: "runner", now: 49, leaseDurationMs: 100 })).toBeUndefined();
    dueNow = 49;
    expect(
      await due.claimNext({ ownerId: "runner", now: 50_000, leaseDurationMs: 100 }),
    ).toBeUndefined();
    dueNow = 50;
    running = (await due.claimNext({ ownerId: "runner", now: 50, leaseDurationMs: 100 }))!;
    dueNow = 55;
    await due.compareAndSet({
      kind: "transition",
      id: running.id,
      expectedRevision: running.revision,
      leaseEpoch: running.leaseEpoch,
      to: "waiting",
      at: 55,
      waiting: { reason: "auth" },
      checkpointRef: "checkpoint:auth",
    });
    expect(await due.claimNext({ ownerId: "runner", now: 1_000, leaseDurationMs: 100 })).toBeUndefined();
    expect(await due.claimNext({
      ownerId: "runner",
      now: 55,
      leaseDurationMs: 100,
      resumeWaitingIds: ["timed"],
    })).toBeUndefined();
    expect(await due.claimNext({
      ownerId: "runner",
      now: 55,
      leaseDurationMs: 100,
      ids: ["timed"],
      resumeWaitingIds: ["timed"],
    })).toMatchObject({
      id: "timed",
      state: "running",
      attempt: 3,
      leaseEpoch: 3,
      checkpointRef: "checkpoint:auth",
    });
  });

  it("keeps a round-robin cursor across individual claims", async () => {
    const store = new InMemoryExportJobStore({ now: () => 200 });
    const sourceFor = (origin: string) => ({ ...request("source").source, siteOrigin: origin });
    await store.create({ request: request("a-1", { createdAt: 1, source: sourceFor("https://a.example") }) });
    await store.create({ request: request("a-2", { createdAt: 2, source: sourceFor("https://a.example") }) });
    await store.create({ request: request("b-1", { createdAt: 100, source: sourceFor("https://b.example") }) });

    expect((await store.claimNext({ ownerId: "runner", now: 200, leaseDurationMs: 20 }))?.id).toBe("a-1");
    expect((await store.claimNext({ ownerId: "runner", now: 200, leaseDurationMs: 20 }))?.id).toBe("b-1");
    expect((await store.claimNext({ ownerId: "runner", now: 200, leaseDurationMs: 20 }))?.id).toBe("a-2");
  });

  it("claims only jobs whose opaque auth reference the host can resolve", async () => {
    const store = new InMemoryExportJobStore({ now: () => 200 });
    await store.create({ request: request("profile-a", { authRef: "cli-profile:a" }) });
    await store.create({ request: request("profile-b", { authRef: "cli-profile:b" }) });

    expect((await store.claimNext({
      ownerId: "runner-b",
      now: 200,
      leaseDurationMs: 20,
      authRefs: ["cli-profile:b"],
    }))?.id).toBe("profile-b");
    expect(await store.claimNext({
      ownerId: "runner-c",
      now: 200,
      leaseDurationMs: 20,
      authRefs: ["cli-profile:c"],
    })).toBeUndefined();
  });

  it("limits an invocation-scoped claim to an exact job id", async () => {
    const store = new InMemoryExportJobStore({ now: () => 200 });
    await store.create({ request: request("older", { createdAt: 1 }) });
    await store.create({ request: request("current", { createdAt: 2 }) });

    expect((await store.claimNext({
      ownerId: "current-command",
      now: 200,
      leaseDurationMs: 20,
      ids: ["current"],
    }))?.id).toBe("current");
    expect((await store.get("older"))?.state).toBe("queued");
    expect(await store.claimNext({
      ownerId: "empty-allow-list",
      now: 200,
      leaseDurationMs: 20,
      ids: [],
    })).toBeUndefined();
  });

  it("dispatches the closed CAS commands and fences progress, checkpoints, and events", async () => {
    let observedNow = 100;
    const store = new InMemoryExportJobStore({ now: () => observedNow });
    await store.create({ request: request("job") });
    const running = (await store.claimNext({ ownerId: "runner", now: 100, leaseDurationMs: 100 }))!;
    observedNow = 110;
    const heartbeat = await store.compareAndSet({
      kind: "heartbeat",
      id: running.id,
      expectedRevision: running.revision,
      ownerId: "runner",
      leaseEpoch: running.leaseEpoch,
      now: 110,
      leaseDurationMs: 100,
    });
    const progress = { stage: "fetch" as const, done: 1, total: 2, updatedAt: 111 };
    observedNow = 111;
    const progressed = await store.compareAndSet({
      kind: "progress",
      id: running.id,
      expectedRevision: heartbeat.revision,
      leaseEpoch: heartbeat.leaseEpoch,
      progress,
    });
    progress.done = 2;
    expect((await store.get("job"))?.progress?.done).toBe(1);
    observedNow = 112;
    const checkpointed = await store.compareAndSet({
      kind: "checkpoint",
      id: running.id,
      expectedRevision: progressed.revision,
      leaseEpoch: progressed.leaseEpoch,
      at: 112,
      checkpointRef: "checkpoint:1",
    });
    expect(checkpointed).toMatchObject({ revision: 4, checkpointRef: "checkpoint:1" });
    const nextStats = structuredClone(checkpointed.stats);
    nextStats.pages.fetched = 1;
    observedNow = 113;
    const withStats = await store.compareAndSet({
      kind: "stats",
      id: "job",
      expectedRevision: checkpointed.revision,
      leaseEpoch: checkpointed.leaseEpoch,
      at: 113,
      stats: nextStats,
    });
    nextStats.pages.fetched = 999;
    expect((await store.get("job"))?.stats.pages.fetched).toBe(1);
    const regressedStats = structuredClone(withStats.stats);
    regressedStats.pages.fetched = 0;
    await expect(
      store.compareAndSet({
        kind: "stats",
        id: "job",
        expectedRevision: withStats.revision,
        leaseEpoch: withStats.leaseEpoch,
        at: 114,
        stats: regressedStats,
      }),
    ).rejects.toThrow("stats.pages.fetched must be finite and monotonic");

    await store.appendEvent("job", {
      expectedRevision: withStats.revision,
      leaseEpoch: withStats.leaseEpoch,
      event: { kind: "stage", seq: 1, at: 115, stage: "fetch" },
    });
    await expect(
      store.appendEvent("job", {
        expectedRevision: withStats.revision - 1,
        leaseEpoch: withStats.leaseEpoch,
        event: { kind: "stage", seq: 2, at: 116, stage: "fetch" },
      }),
    ).rejects.toMatchObject({ code: "revision-conflict" });
    await expect(
      store.appendEvent("job", {
        expectedRevision: withStats.revision,
        leaseEpoch: withStats.leaseEpoch + 1,
        event: { kind: "stage", seq: 2, at: 116, stage: "fetch" },
      }),
    ).rejects.toMatchObject({ code: "lease-mismatch" });
    expect(await store.listEvents("job")).toEqual([
      { kind: "stage", seq: 1, at: 115, stage: "fetch" },
    ]);
  });

  it("dispatches expired-lease reconciliation through the closed CAS command", async () => {
    let observedNow = 10;
    const store = new InMemoryExportJobStore({ now: () => observedNow });
    await store.create({ request: request("job") });
    const running = (await store.claimNext({ ownerId: "runner", now: 10, leaseDurationMs: 10 }))!;
    observedNow = 20;
    const interrupted = await store.compareAndSet({
      kind: "reclaim-expired",
      id: "job",
      expectedRevision: running.revision,
      now: 20,
    });
    expect(interrupted).toMatchObject({
      state: "interrupted",
      recoveryCount: 1,
      error: { code: "executor.lease_expired", retryable: true },
    });
  });

  it("validates events and evicts only coalescible or informational entries", async () => {
    const store = new InMemoryExportJobStore({ now: () => 1 });
    await store.create({ request: request("job") });
    const running = (await store.claimNext({ ownerId: "runner", now: 1, leaseDurationMs: 10_000 }))!;
    await expect(
      store.appendEvent("job", {
        expectedRevision: running.revision,
        leaseEpoch: running.leaseEpoch,
        event: { kind: "state", seq: 1, at: 1, from: "failed", to: "running" },
      }),
    ).rejects.toMatchObject({ code: "invalid-event" });
    await store.appendEvent("job", {
      expectedRevision: running.revision,
      leaseEpoch: running.leaseEpoch,
      event: { kind: "state", seq: 1, at: 1, from: "queued", to: "running" },
    });
    await expect(
      store.appendEvent("job", {
        expectedRevision: running.revision,
        leaseEpoch: running.leaseEpoch,
        event: { kind: "issue", seq: 2, at: 2, level: "info", code: "safe", secret: "no" } as never,
      }),
    ).rejects.toThrow("event.secret");
    for (let seq = 2; seq <= 1_005; seq += 1) {
      await store.appendEvent("job", {
        expectedRevision: running.revision,
        leaseEpoch: running.leaseEpoch,
        event: { kind: "issue", seq, at: seq, level: "info", code: "detail" },
      });
    }
    const events = await store.listEvents("job", 1_000);
    expect(events).toHaveLength(1_000);
    expect(events[0]).toEqual({ kind: "state", seq: 1, at: 1, from: "queued", to: "running" });
  });

  it("reads retained events in ascending cursor-paginated pages", async () => {
    const store = new InMemoryExportJobStore({ now: () => 1 });
    await store.create({ request: request("job") });
    const running = (await store.claimNext({ ownerId: "runner", now: 1, leaseDurationMs: 10_000 }))!;
    for (let seq = 1; seq <= 3; seq += 1) {
      await store.appendEvent("job", {
        expectedRevision: running.revision,
        leaseEpoch: running.leaseEpoch,
        event: { kind: "issue", seq, at: seq, level: "info", code: `detail-${seq}` },
      });
    }

    const first = await store.readEvents("job", { afterSeq: 0, limit: 2 });
    expect(first).toEqual({
      events: [
        { kind: "issue", seq: 1, at: 1, level: "info", code: "detail-1" },
        { kind: "issue", seq: 2, at: 2, level: "info", code: "detail-2" },
      ],
      nextAfterSeq: 2,
      hasMore: true,
    });
    const second = await store.readEvents("job", { afterSeq: first.nextAfterSeq, limit: 2 });
    expect(second).toEqual({
      events: [{ kind: "issue", seq: 3, at: 3, level: "info", code: "detail-3" }],
      nextAfterSeq: 3,
      hasMore: false,
    });
    const caughtUp = await store.readEvents("job", { afterSeq: second.nextAfterSeq, limit: 2 });
    expect(caughtUp).toEqual({ events: [], nextAfterSeq: 3, hasMore: false });

    if (first.events[0]?.kind !== "issue") throw new Error("expected an issue event");
    first.events[0].code = "caller-mutation";
    expect((await store.readEvents("job", { limit: 1 })).events[0]).toMatchObject({
      code: "detail-1",
    });
    await expect(store.readEvents("job", { afterSeq: -1 })).rejects.toBeInstanceOf(RangeError);
    await expect(store.readEvents("job", { limit: 0 })).rejects.toBeInstanceOf(RangeError);
  });

  it("uses trusted store time to reject delayed executor writes", async () => {
    let observedNow = 100;
    const artifacts = new InMemoryArtifactStore({ now: () => 120 });
    const store = new InMemoryExportJobStore({ now: () => observedNow, artifactStore: artifacts });
    await store.create({ request: request("job") });
    const running = (await store.claimNext({ ownerId: "runner", now: 100, leaseDurationMs: 50 }))!;
    const staged = await artifacts.stage("job", running.leaseEpoch, pendingArtifact());
    observedNow = 150;

    await expect(
      store.compareAndSet({
        kind: "transition",
        id: "job",
        expectedRevision: running.revision,
        leaseEpoch: running.leaseEpoch,
        to: "failed",
        at: 120,
        error: {
          code: "render.late",
          message: "Late failure.",
          category: "render",
          retryable: true,
          occurredAt: 120,
        },
      }),
    ).rejects.toMatchObject({ code: "lease-expired" });
    await expect(
      store.compareAndSet({
        kind: "heartbeat",
        id: "job",
        expectedRevision: running.revision,
        ownerId: "runner",
        leaseEpoch: running.leaseEpoch,
        now: 120,
        leaseDurationMs: 50,
      }),
    ).rejects.toMatchObject({ code: "lease-expired" });
    await expect(
      store.compareAndSet({
        kind: "progress",
        id: "job",
        expectedRevision: running.revision,
        leaseEpoch: running.leaseEpoch,
        progress: { stage: "fetch", done: 1, total: 1, updatedAt: 120 },
      }),
    ).rejects.toMatchObject({ code: "lease-expired" });
    await expect(
      store.compareAndSet({
        kind: "checkpoint",
        id: "job",
        expectedRevision: running.revision,
        leaseEpoch: running.leaseEpoch,
        at: 120,
        checkpointRef: "checkpoint:late",
      }),
    ).rejects.toMatchObject({ code: "lease-expired" });
    await expect(
      store.finalizeArtifact({
        id: "job",
        expectedRevision: running.revision,
        leaseEpoch: running.leaseEpoch,
        stagedArtifact: staged,
        finishedAt: 120,
      }),
    ).rejects.toMatchObject({ code: "lease-expired" });
  });

  it("cannot finalize metadata without the exact staged bytes", async () => {
    const store = new InMemoryExportJobStore({ now: () => 100 });
    await store.create({ request: request("job") });
    const running = (await store.claimNext({ ownerId: "runner", now: 100, leaseDurationMs: 50 }))!;
    await expect(
      store.finalizeArtifact({
        id: "job",
        expectedRevision: running.revision,
        leaseEpoch: running.leaseEpoch,
        stagedArtifact: {
          ref: "artifact:missing",
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          filename: "missing.docx",
          byteLength: 3,
          sha256: ABC_SHA256,
          jobId: "job",
          leaseEpoch: running.leaseEpoch,
          stagedAt: 100,
        },
        finishedAt: 120,
      }),
    ).rejects.toMatchObject({ code: "ownership-mismatch" });
    expect((await store.get("job"))?.state).toBe("running");
  });

  it("reconciles the active reference adapter after bytes were promoted before metadata", async () => {
    const artifacts = new InMemoryArtifactStore({ now: () => 110 });
    let observedNow = 120;
    const store = new InMemoryExportJobStore({ now: () => observedNow, artifactStore: artifacts });
    await store.create({ request: request("job") });
    const running = (await store.claimNext({ ownerId: "runner", now: 100, leaseDurationMs: 100 }))!;
    const staged = await artifacts.stage("job", running.leaseEpoch, pendingArtifact());
    const finalize = {
      id: "job",
      expectedRevision: running.revision,
      leaseEpoch: running.leaseEpoch,
      stagedArtifact: staged,
      finishedAt: 120,
    };

    await expect(store.finalizeArtifactWithFaults(finalize, {
      afterArtifactCommitted() {
        throw new Error("simulated process crash");
      },
    })).rejects.toThrow("simulated process crash");
    expect(artifacts.isCommitted(staged.ref)).toBe(true);
    expect((await store.get("job"))?.state).toBe("running");

    observedNow = 250;
    const recovered = await store.reconcilePreparedArtifactFinalization("job");
    expect(recovered).toMatchObject({ state: "succeeded", artifact: { ref: staged.ref } });
    expect(await readAll(artifacts.read(staged.ref))).toEqual([97, 98, 99]);
  });

  it("finalizes staged bytes atomically, delivers set-once, protects, then tombstones", async () => {
    const artifacts = new InMemoryArtifactStore({ now: () => 110 });
    let observedNow = 100;
    const store = new InMemoryExportJobStore({ now: () => observedNow, artifactStore: artifacts });
    await store.create({ request: request("job") });
    const running = (await store.claimNext({ ownerId: "runner", now: 100, leaseDurationMs: 100 }))!;
    const staged = await artifacts.stage("job", running.leaseEpoch, pendingArtifact());
    expect(() => artifacts.read(staged.ref)).toThrow(InMemoryByteStoreConflict);

    observedNow = 120;
    const succeeded = await store.finalizeArtifact({
      id: "job",
      expectedRevision: running.revision,
      leaseEpoch: running.leaseEpoch,
      stagedArtifact: staged,
      finishedAt: 120,
    });
    expect(succeeded).toMatchObject({ state: "succeeded", revision: 2 });
    expect(artifacts.isCommitted(staged.ref)).toBe(true);
    expect(await readAll(artifacts.read(staged.ref))).toEqual([97, 98, 99]);

    expect(await store.deleteTerminal({ finishedBefore: 500 })).toEqual({
      deletedJobIds: [],
      tombstoneRefs: [],
    });
    const delivered = await store.deliver("job", succeeded.revision, 130);
    expect(delivered).toMatchObject({ deliveredAt: 130, acknowledgedAt: 130 });
    observedNow = 1_000;
    const deleted = await store.deleteTerminal({ finishedBefore: 500 });
    expect(deleted.deletedJobIds).toEqual(["job"]);
    expect(await store.get("job")).toBeUndefined();
    const tombstone = await store.getTombstone("job");
    const tombstoneForRestart = structuredClone(tombstone!);
    expect(tombstone).toMatchObject({
      jobId: "job",
      finalState: "succeeded",
      finalRevision: delivered.revision,
      deletedAt: 1_000,
      idempotencyKey: "idem:job",
      ownedRefs: expect.arrayContaining(["request:job", "events:job", staged.ref]),
    });
    expect(artifacts.isCommitted(staged.ref)).toBe(true);
    const spool = new InMemorySpoolStore();
    const cleaned = await reconcileTombstonedExportJobCleanup(
      store,
      { spool, artifacts },
      "job",
      1_001,
    );
    expect(cleaned.cleanup.artifacts).toEqual({ objectsDeleted: 1, bytesDeleted: 3 });
    expect(cleaned.tombstone.cleanupCompletedAt).toBe(1_001);
    expect(artifacts.isCommitted(staged.ref)).toBe(false);
    expect((await store.getTombstone("job"))?.cleanupCompletedAt).toBe(1_001);
    await expect(store.create({ request: request("job") })).rejects.toBeInstanceOf(
      InMemoryExportStoreConflict,
    );
    const restarted = new InMemoryExportJobStore({ tombstones: [tombstoneForRestart] });
    await expect(
      restarted.create({ request: request("new-id", { idempotencyKey: "idem:job" }) }),
    ).rejects.toMatchObject({ code: "job-deleted" });
  });

  it("does not let delivery rewrite an earlier acknowledgement", async () => {
    const artifacts = new InMemoryArtifactStore({ now: () => 110 });
    let observedNow = 100;
    const store = new InMemoryExportJobStore({ now: () => observedNow, artifactStore: artifacts });
    await store.create({ request: request("job") });
    const running = (await store.claimNext({ ownerId: "runner", now: 100, leaseDurationMs: 100 }))!;
    const staged = await artifacts.stage("job", running.leaseEpoch, pendingArtifact());
    observedNow = 120;
    let terminal = await store.finalizeArtifact({
      id: "job",
      expectedRevision: running.revision,
      leaseEpoch: running.leaseEpoch,
      stagedArtifact: staged,
      finishedAt: 120,
    });
    terminal = await store.acknowledge("job", terminal.revision, 125);
    terminal = await store.deliver("job", terminal.revision, 130);
    expect(terminal).toMatchObject({ acknowledgedAt: 125, deliveredAt: 130 });
  });
});

describe("InMemorySpoolStore", () => {
  const ref = { jobId: "job", leaseEpoch: 1, namespace: "assets", key: "logo" };
  const limits = { maxObjectBytes: 4, maxJobBytes: 5, maxTotalBytes: 6 };

  it("commits complete objects with a digest and returns defensive byte copies", async () => {
    const spool = new InMemorySpoolStore({ now: () => 10 });
    const stored = await spool.put(ref, chunks([97], [98, 99]), limits);
    expect(stored).toEqual({ ref, byteLength: 3, sha256: ABC_SHA256, committedAt: 10 });
    const first = await readAll(spool.read(ref));
    first[0] = 0;
    expect(await readAll(spool.read(ref))).toEqual([97, 98, 99]);
    await spool.deleteNamespace("job", 1);
    expect(await spool.stat(ref)).toBeUndefined();
  });

  it("enforces object, job, and total budgets atomically", async () => {
    const spool = new InMemorySpoolStore();
    await expect(spool.put(ref, chunks([1, 2, 3, 4, 5]), limits)).rejects.toMatchObject({
      code: "object-limit",
    });
    expect(await spool.stat(ref)).toBeUndefined();
    await spool.put(ref, chunks([1, 2, 3]), limits);
    await expect(
      spool.put({ ...ref, key: "two" }, chunks([4, 5, 6]), limits),
    ).rejects.toMatchObject({ code: "job-limit" });
    await spool.put(
      { jobId: "other", leaseEpoch: 1, namespace: "assets", key: "x" },
      chunks([4, 5, 6]),
      limits,
    );
    await expect(
      spool.put({ jobId: "third", leaseEpoch: 1, namespace: "assets", key: "x" }, chunks([7]), limits),
    ).rejects.toMatchObject({ code: "total-limit" });
  });

  it("serializes quota admission and keeps committed epoch refs immutable", async () => {
    const spool = new InMemorySpoolStore();
    await spool.put(ref, chunks([1, 2, 3]), limits);
    await expect(spool.put(ref, chunks([9, 9, 9]), limits)).rejects.toMatchObject({
      code: "ownership-mismatch",
    });

    const concurrent = new InMemorySpoolStore();
    const results = await Promise.allSettled([
      concurrent.put(
        { jobId: "a", leaseEpoch: 1, namespace: "assets", key: "one" },
        chunks([1, 2, 3, 4]),
        limits,
      ),
      concurrent.put(
        { jobId: "b", leaseEpoch: 1, namespace: "assets", key: "two" },
        chunks([5, 6, 7, 8]),
        limits,
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("backpressures concurrent collectors before pulling beyond the in-flight byte budget", async () => {
    const store = new InMemorySpoolStore({ maxInFlightBytes: 8, maxConcurrentWrites: 2 });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let secondPulled = false;
    const limits = { maxObjectBytes: 4, maxJobBytes: 8, maxTotalBytes: 8 };
    const first = store.put(
      { jobId: "job", leaseEpoch: 1, namespace: "pages", key: "first" },
      (async function* () { await firstGate; yield Uint8Array.of(1); })(),
      limits,
    );
    const second = store.put(
      { jobId: "job", leaseEpoch: 1, namespace: "pages", key: "second" },
      (async function* () { secondPulled = true; yield Uint8Array.of(2); })(),
      limits,
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(store.inFlightSnapshot).toEqual({
      reservedBytes: 8,
      activeReservations: 1,
      queuedReservations: 1,
    });
    expect(secondPulled).toBe(false);
    releaseFirst();
    await first;
    await second;
    expect(secondPulled).toBe(true);
    expect(store.inFlightSnapshot.reservedBytes).toBe(0);
  });

  it("does not commit a spool object when cancellation wins during hashing", async () => {
    const controller = new AbortController();
    const store = new InMemorySpoolStore({
      async digest() {
        controller.abort(new DOMException("cancelled", "AbortError"));
        return ABC_SHA256;
      },
    });
    const ref = { jobId: "job", leaseEpoch: 1, namespace: "pages", key: "cancelled" };
    const write = store.put(
      ref,
      chunks([97, 98, 99]),
      { maxObjectBytes: 3, maxJobBytes: 3, maxTotalBytes: 3 },
      { signal: controller.signal },
    );
    await expect(write).rejects.toMatchObject({ name: "AbortError" });
    expect(await store.stat(ref)).toBeUndefined();
  });

  it("scopes cleanup to one lease epoch", async () => {
    const spool = new InMemorySpoolStore();
    await spool.put(ref, chunks([1]), limits);
    const newer = { ...ref, leaseEpoch: 2 };
    await spool.put(newer, chunks([2]), limits);
    await spool.deleteNamespace("job", 1);
    expect(await spool.stat(ref)).toBeUndefined();
    expect(await spool.stat(newer)).toBeDefined();
  });

  it("validates preserved refs before closing a spool epoch", async () => {
    const store = new InMemorySpoolStore();
    await expect(store.deleteNamespace("job", 1, {
      preserve: [{ jobId: "other", leaseEpoch: 1, namespace: "checkpoints", key: "safe" }],
    })).rejects.toMatchObject({ code: "ownership-mismatch" });
    const ref = { jobId: "job", leaseEpoch: 1, namespace: "pages", key: "still-open" };
    await expect(store.put(
      ref,
      chunks([1]),
      { maxObjectBytes: 1, maxJobBytes: 1, maxTotalBytes: 1 },
    )).resolves.toMatchObject({ ref });
  });
});

describe("InMemoryArtifactStore", () => {
  it("enforces declared integrity, ownership, and total byte limits", async () => {
    const artifacts = new InMemoryArtifactStore({ maxArtifactBytes: 3, maxTotalBytes: 3 });
    await expect(
      artifacts.stage("job", 1, pendingArtifact({ byteLength: 2 })),
    ).rejects.toMatchObject({ code: "length-mismatch" });
    await expect(
      artifacts.stage("job", 1, pendingArtifact({ sha256: "0".repeat(64) })),
    ).rejects.toMatchObject({ code: "digest-mismatch" });
    const staged = await artifacts.stage("job", 1, pendingArtifact());
    await expect(artifacts.stage("other", 1, pendingArtifact())).rejects.toMatchObject({
      code: "total-limit",
    });
    expect((await artifacts.getStaged("job", 1))?.ref).toBe(staged.ref);
    await expect(
      artifacts.commitStaged({ ...staged, leaseEpoch: 2 }, staged.stagedAt),
    ).rejects.toBeInstanceOf(InMemoryByteStoreConflict);
    await artifacts.deleteStaged(staged.ref);
    expect(await artifacts.getStaged("job", 1)).toBeUndefined();
  });

  it("honors cancellation before artifact bytes become visible", async () => {
    const store = new InMemoryArtifactStore({ maxArtifactBytes: 3, maxTotalBytes: 3 });
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(store.stage("job", 1, pendingArtifact(), {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(await store.getStaged("job", 1)).toBeUndefined();
  });

  it("does not stage an artifact when cancellation wins during hashing", async () => {
    const controller = new AbortController();
    const store = new InMemoryArtifactStore({
      maxArtifactBytes: 3,
      maxTotalBytes: 3,
      async digest() {
        controller.abort(new DOMException("cancelled", "AbortError"));
        return ABC_SHA256;
      },
    });
    const stage = store.stage("job", 1, pendingArtifact(), { signal: controller.signal });
    await expect(stage).rejects.toMatchObject({ name: "AbortError" });
    expect(await store.getStaged("job", 1)).toBeUndefined();
  });

  it("backpressures concurrent artifact collectors before pulling beyond the byte budget", async () => {
    const store = new InMemoryArtifactStore({
      maxArtifactBytes: 3,
      maxTotalBytes: 6,
      maxInFlightBytes: 6,
      maxConcurrentStages: 2,
    });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let secondPulled = false;
    const first = store.stage("first", 1, pendingArtifact({
      bytes: (async function* () { await gate; yield Uint8Array.from([97, 98, 99]); })(),
    }));
    const second = store.stage("second", 1, pendingArtifact({
      bytes: (async function* () { secondPulled = true; yield Uint8Array.from([97, 98, 99]); })(),
    }));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.inFlightSnapshot).toEqual({
      reservedBytes: 6,
      activeReservations: 1,
      queuedReservations: 1,
    });
    expect(secondPulled).toBe(false);
    releaseFirst();
    await first;
    await second;
    expect(secondPulled).toBe(true);
    expect(store.inFlightSnapshot.reservedBytes).toBe(0);
  });

  it("serializes epoch cleanup ahead of a stale artifact promotion", async () => {
    const store = new InMemoryArtifactStore();
    const staged = await store.stage("job", 1, pendingArtifact());
    const cleanup = store.deleteStagedEpoch("job", 1);
    const staleCommit = store.commitStaged(staged, staged.stagedAt);

    expect(await cleanup).toEqual({ objectsDeleted: 1, bytesDeleted: 3 });
    await expect(staleCommit).rejects.toMatchObject({ code: "ownership-mismatch" });
    expect(store.isCommitted(staged.ref)).toBe(false);
  });
});
