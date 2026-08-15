import { describe, expect, it } from "bun:test";
import type { PendingArtifactV1 } from "./artifact.js";
import {
  cleanupAbandonedExportAttempt,
  cleanupTombstonedExportJob,
} from "./cleanup.js";
import {
  InMemoryArtifactStore,
  InMemoryByteStoreConflict,
  InMemorySpoolStore,
} from "./in-memory.js";
import type { ExportJobTombstoneV1 } from "./store-contracts.js";

const SHA_ONE = "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a";
const limits = { maxObjectBytes: 8, maxJobBytes: 16, maxTotalBytes: 32 };

async function* one(value: number): AsyncIterable<Uint8Array> {
  yield Uint8Array.of(value);
}

function pending(value = 1): PendingArtifactV1 {
  return {
    mediaType: "application/pdf",
    filename: "out.pdf",
    byteLength: 1,
    sha256: SHA_ONE,
    bytes: one(value),
  };
}

function tombstone(jobId: string): ExportJobTombstoneV1 {
  return {
    ref: `tombstone:${jobId}:3`,
    jobId,
    requestRef: `request:${jobId}`,
    idempotencyKey: `idem:${jobId}`,
    finalState: "succeeded",
    finalRevision: 3,
    finishedAt: 10,
    deletedAt: 20,
    ownedRefs: [`request:${jobId}`, `events:${jobId}`, `spool:${jobId}`],
  };
}

describe("owned byte cleanup", () => {
  it("closes an abandoned epoch before deleting its spool and staged artifact", async () => {
    const spool = new InMemorySpoolStore();
    const artifacts = new InMemoryArtifactStore();
    const oldRef = { jobId: "job", leaseEpoch: 1, namespace: "pages", key: "0" };
    const newRef = { ...oldRef, leaseEpoch: 2 };
    await spool.put(oldRef, one(1), limits);
    await spool.put(newRef, one(2), limits);
    await artifacts.stage("job", 1, pending());

    expect(await cleanupAbandonedExportAttempt({ spool, artifacts }, "job", 1)).toEqual({
      spool: { objectsDeleted: 1, bytesDeleted: 1 },
      artifacts: { objectsDeleted: 1, bytesDeleted: 1 },
      objectsDeleted: 2,
      bytesDeleted: 2,
    });
    expect(await spool.stat(oldRef)).toBeUndefined();
    expect(await spool.stat(newRef)).toBeDefined();
    expect(await artifacts.getStaged("job", 1)).toBeUndefined();
    await expect(spool.put(oldRef, one(1), limits)).rejects.toMatchObject({
      code: "ownership-mismatch",
    });
    await expect(artifacts.stage("job", 1, pending())).rejects.toMatchObject({
      code: "ownership-mismatch",
    });
  });

  it("prevents an in-flight collector from publishing after cleanup", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* delayed(): AsyncIterable<Uint8Array> {
      await blocked;
      yield Uint8Array.of(1);
    }
    const spool = new InMemorySpoolStore();
    const artifacts = new InMemoryArtifactStore();
    const ref = { jobId: "job", leaseEpoch: 1, namespace: "pages", key: "late" };
    const latePut = spool.put(ref, delayed(), limits).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const lateStage = artifacts.stage("job", 1, { ...pending(), bytes: delayed() }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await cleanupAbandonedExportAttempt({ spool, artifacts }, "job", 1);
    release();
    expect(await latePut).toMatchObject({ ok: false, error: expect.any(InMemoryByteStoreConflict) });
    expect(await lateStage).toMatchObject({ ok: false, error: expect.any(InMemoryByteStoreConflict) });
    expect(await spool.stat(ref)).toBeUndefined();
    expect(await artifacts.getStaged("job", 1)).toBeUndefined();
  });

  it("preserves the explicitly authorized recovery checkpoint while closing its old epoch", async () => {
    const spool = new InMemorySpoolStore();
    const artifacts = new InMemoryArtifactStore();
    const checkpoint = { jobId: "job", leaseEpoch: 1, namespace: "checkpoints", key: "safe-3" };
    const orphan = { jobId: "job", leaseEpoch: 1, namespace: "pages", key: "orphan" };
    await spool.put(checkpoint, one(1), limits);
    await spool.put(orphan, one(2), limits);

    const cleaned = await cleanupAbandonedExportAttempt(
      { spool, artifacts },
      "job",
      1,
      { preserveSpoolRefs: [checkpoint] },
    );

    expect(cleaned.spool).toEqual({ objectsDeleted: 1, bytesDeleted: 1 });
    expect(await spool.stat(checkpoint)).toBeDefined();
    expect(await spool.stat(orphan)).toBeUndefined();
    await expect(spool.put(checkpoint, one(1), limits)).rejects.toMatchObject({
      code: "ownership-mismatch",
    });
  });

  it("removes all tombstoned job bytes, closes late writers, and is idempotent", async () => {
    const spool = new InMemorySpoolStore();
    const artifacts = new InMemoryArtifactStore();
    const ref1 = { jobId: "job", leaseEpoch: 1, namespace: "pages", key: "0" };
    const ref2 = { ...ref1, leaseEpoch: 2, key: "1" };
    await spool.put(ref1, one(1), limits);
    await spool.put(ref2, one(2), limits);
    const staged = await artifacts.stage("job", 2, pending());
    await artifacts.commitStaged(staged, staged.stagedAt);

    const first = await cleanupTombstonedExportJob({ spool, artifacts }, tombstone("job"));
    expect(first).toMatchObject({ objectsDeleted: 3, bytesDeleted: 3 });
    expect(() => artifacts.read(staged.ref)).toThrow(InMemoryByteStoreConflict);
    expect(await cleanupTombstonedExportJob({ spool, artifacts }, tombstone("job"))).toMatchObject({
      objectsDeleted: 0,
      bytesDeleted: 0,
    });
    await expect(spool.put(ref2, one(2), limits)).rejects.toMatchObject({
      code: "ownership-mismatch",
    });
  });
});
