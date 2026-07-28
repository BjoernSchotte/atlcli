import { describe, expect, it } from "bun:test";
import {
  InMemoryTemplatePackStoreV1,
  templatePackReference,
} from "./index.js";

const limits = {
  maxObjectBytes: 1024,
  maxTotalBytes: 4096,
};

describe("TemplatePackStoreV1 contract", () => {
  it("atomically deduplicates and verifies copied content-addressed bytes", async () => {
    const store = new InMemoryTemplatePackStoreV1();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const first = await store.put({ bytes, limits, now: 10 });
    bytes[0] = 99;
    const second = await store.put({
      bytes: new Uint8Array([1, 2, 3, 4]),
      limits,
      now: 20,
    });
    expect(second).toEqual(first);
    const loaded = await store.get(templatePackReference(first));
    expect([...loaded.bytes]).toEqual([1, 2, 3, 4]);
    loaded.bytes[1] = 88;
    expect([...(await store.get(templatePackReference(first))).bytes]).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("retains a shared record until a complete scan has no referencing job", async () => {
    const store = new InMemoryTemplatePackStoreV1();
    const record = await store.put({
      bytes: new Uint8Array([5, 6, 7]),
      limits,
      now: 0,
    });
    const reference = {
      recordKey: record.recordKey,
      archiveSha256: record.archiveSha256,
    };
    await store.link({
      ...reference,
      jobId: "job-a",
      requestRef: "request-a",
      at: 1,
    });
    await store.link({
      ...reference,
      jobId: "job-b",
      requestRef: "request-b",
      at: 2,
    });

    await store.reconcile({
      completeScan: true,
      references: [
        {
          ...reference,
          jobId: "job-b",
          requestRef: "request-b",
        },
      ],
      now: 100,
      orphanGraceMs: 10,
    });
    await expect(store.verify(templatePackReference(record))).resolves.toEqual(
      record
    );

    const cleaned = await store.reconcile({
      completeScan: true,
      references: [],
      now: 100,
      orphanGraceMs: 10,
    });
    expect(cleaned.deletedRecords).toEqual([record.recordKey]);
    await expect(
      store.get(templatePackReference(record))
    ).rejects.toThrow(/not found/);
  });

  it("keeps a failed-create orphan through grace and deletes only owned records later", async () => {
    const store = new InMemoryTemplatePackStoreV1();
    const orphan = await store.put({
      bytes: new Uint8Array([8, 9]),
      limits,
      now: 100,
    });
    expect(
      await store.reconcile({
        completeScan: true,
        references: [],
        now: 109,
        orphanGraceMs: 10,
      })
    ).toMatchObject({ deletedRecords: [], retainedRecords: 1 });
    expect(
      await store.reconcile({
        completeScan: true,
        references: [],
        now: 110,
        orphanGraceMs: 10,
      })
    ).toMatchObject({
      deletedRecords: [orphan.recordKey],
      retainedRecords: 0,
    });
  });

  it("enforces object and total budgets before adding a record", async () => {
    const store = new InMemoryTemplatePackStoreV1();
    await expect(
      store.put({
        bytes: new Uint8Array(3),
        limits: { maxObjectBytes: 2, maxTotalBytes: 10 },
        now: 0,
      })
    ).rejects.toThrow(/object byte limit/);
    await store.put({
      bytes: new Uint8Array([1, 1]),
      limits: { maxObjectBytes: 3, maxTotalBytes: 3 },
      now: 0,
    });
    await expect(
      store.put({
        bytes: new Uint8Array([2, 2]),
        limits: { maxObjectBytes: 3, maxTotalBytes: 3 },
        now: 0,
      })
    ).rejects.toThrow(/total byte limit/);
  });
});
