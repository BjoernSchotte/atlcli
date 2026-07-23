import { describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { PdfExportJobRequestV1 } from "@atlcli/export-jobs";
import { IndexedDbExportJobCatalog } from "../../utils/export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import { createExtensionExportQueueRunner } from "../../utils/export-jobs/queue-runner.js";

globalThis.IDBKeyRange = IDBKeyRange;

function request(id: string, createdAt: number): PdfExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `idem:${id}`,
    format: "pdf",
    renderer: "pdf-typst",
    source: {
      kind: "confluence",
      siteOrigin: "https://site.atlassian.net",
      locator: { kind: "page-id", id: "42" },
      scope: { kind: "page" },
    },
    authRef: "session:https://site.atlassian.net",
    displayName: id,
    requestedFilename: `${id}.pdf`,
    createdAt,
    priority: "interactive",
    output: { policy: "collect" },
    template: { id: "builtin.editorial-indigo", manifestVersion: "1.0.0" },
    settings: {},
    options: { resolveMacros: true },
  };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(1);
  }
}

describe("createExtensionExportQueueRunner", () => {
  it("returns after claim, serializes execution, and automatically pumps the next job", async () => {
    const factory = new IDBFactory();
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 10 });
    const bytes = new IndexedDbExportByteStore({ factory, now: () => 10 });
    await catalog.create({ request: request("first", 1) });
    await catalog.create({ request: request("second", 2) });
    const entered: string[] = [];
    const finishes = new Map<string, () => void>();
    const runner = createExtensionExportQueueRunner({
      catalog,
      bytes,
      ownerId: "offscreen:test",
      now: () => 10,
      execute: async (claimed) => {
        entered.push(claimed.id);
        await new Promise<void>((resolve) => finishes.set(claimed.id, resolve));
      },
    });

    expect(await runner.wake()).toBe("first");
    await Promise.resolve();
    expect(entered).toEqual(["first"]);
    expect(runner.activeJobId()).toBe("first");
    expect(await runner.wake(["second"])).toBeUndefined();
    expect((await catalog.get("second"))?.state).toBe("queued");

    finishes.get("first")?.();
    await waitUntil(
      () => entered.includes("second"),
      "The queue did not automatically start the second job.",
    );
    expect(entered).toEqual(["first", "second"]);
    expect(runner.activeJobId()).toBe("second");
    finishes.get("second")?.();
    await Bun.sleep(0);
  });

  it("coalesces duplicate wakeups so only one caller observes the claim", async () => {
    const factory = new IDBFactory();
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 10 });
    const bytes = new IndexedDbExportByteStore({ factory, now: () => 10 });
    await catalog.create({ request: request("only", 1) });
    let finish!: () => void;
    const runner = createExtensionExportQueueRunner({
      catalog,
      bytes,
      ownerId: "offscreen:test",
      now: () => 10,
      execute: () => new Promise<void>((resolve) => { finish = resolve; }),
    });

    const results = await Promise.all([runner.wake(["only"]), runner.wake(["only"])]);
    expect(results.filter((id) => id === "only")).toHaveLength(1);
    expect((await catalog.get("only"))?.leaseEpoch).toBe(1);
    finish();
  });

  it("reclaims an expired owner with a fresh fenced lease epoch", async () => {
    const factory = new IDBFactory();
    let now = 10;
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => now });
    const bytes = new IndexedDbExportByteStore({ factory, now: () => now });
    await catalog.create({ request: request("recover", 1) });
    const old = await catalog.claimNext({
      ownerId: "offscreen:old",
      now,
      leaseDurationMs: 10,
    });
    expect(old?.leaseEpoch).toBe(1);
    now = 21;
    let claimedEpoch = 0;
    let finish!: () => void;
    const runner = createExtensionExportQueueRunner({
      catalog,
      bytes,
      ownerId: "offscreen:new",
      now: () => now,
      leaseDurationMs: 10,
      execute: (claimed) => {
        claimedEpoch = claimed.leaseEpoch;
        return new Promise<void>((resolve) => { finish = resolve; });
      },
    });

    expect(await runner.wake(["recover"])).toBe("recover");
    await Promise.resolve();
    expect(claimedEpoch).toBe(2);
    expect(await catalog.get("recover")).toMatchObject({
      state: "running",
      leaseEpoch: 2,
      recoveryCount: 1,
      lease: { ownerId: "offscreen:new" },
    });
    finish();
  });

  it("retries startup after a transient recovery failure", async () => {
    const factory = new IDBFactory();
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 10 });
    const realBytes = new IndexedDbExportByteStore({ factory, now: () => 10 });
    let attempts = 0;
    const bytes = {
      ...realBytes,
      recoverIncompleteWrites: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        return realBytes.recoverIncompleteWrites();
      },
    } as IndexedDbExportByteStore;
    const runner = createExtensionExportQueueRunner({
      catalog,
      bytes,
      execute: async () => {},
    });

    await expect(runner.startup()).rejects.toThrow("transient");
    await expect(runner.startup()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
