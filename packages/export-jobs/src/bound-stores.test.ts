import { describe, expect, it } from "bun:test";
import { bindExportJobArtifacts, bindExportJobSpool } from "./bound-stores.js";
import { InMemoryArtifactStore, InMemorySpoolStore } from "./in-memory.js";

async function* bytes(value: number): AsyncIterable<Uint8Array> {
  yield Uint8Array.of(value);
}

async function readAll(source: AsyncIterable<Uint8Array>): Promise<number[]> {
  const values: number[] = [];
  for await (const chunk of source) values.push(...chunk);
  return values;
}

describe("executor-bound byte stores", () => {
  it("cannot forge a future spool epoch through the executor facade", async () => {
    const store = new InMemorySpoolStore({ now: () => 10 });
    const limits = { maxObjectBytes: 2, maxJobBytes: 4, maxTotalBytes: 4 };
    const stale = bindExportJobSpool(store, "job", 1, limits);
    const current = bindExportJobSpool(store, "job", 2, limits);
    await stale.put({ namespace: "pages", key: "one" }, bytes(1));
    await current.put({ namespace: "pages", key: "one" }, bytes(2));
    expect(await store.stat({ jobId: "job", leaseEpoch: 1, namespace: "pages", key: "one" })).toBeDefined();
    expect(await store.stat({ jobId: "job", leaseEpoch: 2, namespace: "pages", key: "one" })).toBeDefined();
  });

  it("cannot read or probe another job or lease through forged reference fields", async () => {
    const store = new InMemorySpoolStore({ now: () => 10 });
    const limits = { maxObjectBytes: 2, maxJobBytes: 4, maxTotalBytes: 8 };
    await store.put(
      { jobId: "bound", leaseEpoch: 1, namespace: "pages", key: "one" },
      bytes(1),
      limits,
    );
    await store.put(
      { jobId: "other", leaseEpoch: 9, namespace: "pages", key: "one" },
      bytes(9),
      limits,
    );
    const bound = bindExportJobSpool(store, "bound", 1, limits);
    const forged = {
      jobId: "other",
      leaseEpoch: 9,
      namespace: "pages",
      key: "one",
    } as never;
    expect(await readAll(bound.read(forged))).toEqual([1]);
    expect((await bound.stat(forged))?.ref).toMatchObject({ jobId: "bound", leaseEpoch: 1 });
  });

  it("keeps spool byte limits host-owned even when an executor passes extra arguments", async () => {
    const store = new InMemorySpoolStore();
    const bound = bindExportJobSpool(store, "job", 1, {
      maxObjectBytes: 1,
      maxJobBytes: 1,
      maxTotalBytes: 1,
    });
    const forgedPut = bound.put as unknown as (
      ref: { namespace: string; key: string },
      source: AsyncIterable<Uint8Array>,
      limits: { maxObjectBytes: number; maxJobBytes: number; maxTotalBytes: number },
    ) => Promise<unknown>;

    await expect(
      forgedPut(
        { namespace: "pages", key: "oversize" },
        (async function* () { yield Uint8Array.of(1, 2); })(),
        { maxObjectBytes: 999, maxJobBytes: 999, maxTotalBytes: 999 },
      ),
    ).rejects.toMatchObject({ code: "object-limit" });
  });

  it("cannot pre-stage an artifact for a replacement epoch", async () => {
    const store = new InMemoryArtifactStore({ now: () => 10, maxArtifactBytes: 1, maxTotalBytes: 2 });
    const stale = bindExportJobArtifacts(store, "job", 1);
    const current = bindExportJobArtifacts(store, "job", 2);
    const pending = {
      mediaType: "application/pdf" as const,
      filename: "out.pdf",
      byteLength: 1,
      sha256: "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a",
      bytes: bytes(1),
    };
    expect((await stale.stage(pending)).leaseEpoch).toBe(1);
    expect((await current.stage({ ...pending, bytes: bytes(1) })).leaseEpoch).toBe(2);
  });
});
