import { describe, expect, it } from "bun:test";
import {
  InMemorySpoolStore,
  bindExportJobSpool,
  type ExportJobExecutionContext,
  type SpoolRefV1,
  type SpoolWriteLimitsV1,
} from "@atlcli/export-jobs";
import type {
  ExportTreeBodyManifestEntryV1,
  ExportTreeBodyResultV1,
  TreeSource,
} from "@atlcli/confluence";
import { fetchExportTree } from "@atlcli/confluence";
import { createExportTreeBodySpoolV1 } from "./tree-body-spool.js";

const limits: SpoolWriteLimitsV1 = {
  maxObjectBytes: 128 * 1024 * 1024,
  maxJobBytes: 512 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
};

const entries: ExportTreeBodyManifestEntryV1[] = [
  { ordinal: 0, key: "root:v1", pageId: "root", title: "Root" },
  { ordinal: 1, key: "a:v1", pageId: "a", title: "A" },
  { ordinal: 2, key: "b:v1", pageId: "b", title: "B" },
];

function result(
  ordinal: number,
  text = `body-${ordinal}`,
): ExportTreeBodyResultV1 {
  const pageId = ordinal === 0 ? "root" : String.fromCharCode(96 + ordinal);
  const title = ordinal === 0 ? "Root" : pageId.toUpperCase();
  return {
    ok: true,
    pageId,
    title,
    blocks: [{ type: "paragraph", content: [{ type: "text", text }] }],
    notes: [],
    meta: { version: 1, labels: [], spaceKey: "DOCSY" },
  };
}

function context(
  store: InMemorySpoolStore,
  jobId: string,
  leaseEpoch: number,
  checkpointRef?: string,
): ExportJobExecutionContext {
  const execution: ExportJobExecutionContext = {
    jobId,
    leaseEpoch,
    ...(checkpointRef ? { checkpointRef } : {}),
    signal: new AbortController().signal,
    spool: bindExportJobSpool(store, jobId, leaseEpoch, limits),
    readSpool(ref, options) {
      if (ref.jobId !== jobId || ref.leaseEpoch > leaseEpoch) {
        throw new Error("Test host rejected recovery spool identity.");
      }
      return store.read(ref, options);
    },
    artifacts: {
      async stage() {
        throw new Error("Artifact staging is outside this test.");
      },
      async getStaged() {
        return undefined;
      },
    },
    async updateProgress() {},
    async updateStats() {},
    async appendEvent() {},
    async checkpoint(ref) {
      execution.checkpointRef = ref;
    },
  };
  return execution;
}

function checkpointSpoolRef(checkpointRef: string): SpoolRefV1 {
  const prefix = "atlcli.export-tree-spool/1:";
  if (!checkpointRef.startsWith(prefix)) {
    throw new Error("Expected an export-tree checkpoint.");
  }
  return JSON.parse(
    decodeURIComponent(checkpointRef.slice(prefix.length)),
  ) as SpoolRefV1;
}

function threePageSource(fetched: string[]): TreeSource {
  return {
    async getPage(id, { signal }) {
      signal?.throwIfAborted();
      fetched.push(id);
      return {
        id,
        title: id === "root" ? "Root" : id.toUpperCase(),
        storage: `<p>${id}</p>`,
        version: 1,
        labels: [],
        spaceKey: "DOCSY",
      };
    },
    async getPageVersion(id, { signal }) {
      signal?.throwIfAborted();
      return {
        title: id === "root" ? "Root" : id.toUpperCase(),
        version: 1,
      };
    },
    async getChildren(node, { signal }) {
      signal?.throwIfAborted();
      if (node.id !== "root") return [];
      return [
        { id: "a", kind: "page", title: "A", position: 0, observedVersion: 1 },
        { id: "b", kind: "page", title: "B", position: 1, observedVersion: 1 },
      ];
    },
    async getSpaceHomepageId(_spaceKey, { signal }) {
      signal?.throwIfAborted();
      return "root";
    },
  };
}

describe("createExportTreeBodySpoolV1", () => {
  it("recovers committed normalized pages across lease epochs and continues contiguously", async () => {
    const store = new InMemorySpoolStore();
    const first = context(store, "job-1", 1);
    const initial = createExportTreeBodySpoolV1(first, "request-key");

    await initial.prepare(entries, { signal: first.signal });
    await initial.commit(entries[0]!, result(0), { signal: first.signal });
    await initial.commit(entries[1]!, result(1), { signal: first.signal });
    const recoveredCheckpoint = first.checkpointRef;
    expect(recoveredCheckpoint).toBeDefined();
    expect(checkpointSpoolRef(recoveredCheckpoint!).leaseEpoch).toBe(1);

    const second = context(store, "job-1", 2, recoveredCheckpoint);
    const resumed = createExportTreeBodySpoolV1(second, "request-key");
    await resumed.prepare(entries, { signal: second.signal });
    expect(await resumed.load(entries[0]!, { signal: second.signal }))
      .toEqual(result(0));
    expect(await resumed.load(entries[1]!, { signal: second.signal }))
      .toEqual(result(1));
    expect(await resumed.load(entries[2]!, { signal: second.signal }))
      .toBeUndefined();

    await resumed.commit(entries[2]!, result(2, "resumed-body"), {
      signal: second.signal,
    });
    expect(await resumed.load(entries[2]!, { signal: second.signal }))
      .toEqual(result(2, "resumed-body"));
    expect(checkpointSpoolRef(second.checkpointRef!).leaseEpoch).toBe(2);
  });

  it("refuses a changed discovery manifest instead of mixing source versions", async () => {
    const store = new InMemorySpoolStore();
    const first = context(store, "job-1", 1);
    const initial = createExportTreeBodySpoolV1(first, "request-key");
    await initial.prepare(entries, { signal: first.signal });
    await initial.commit(entries[0]!, result(0), { signal: first.signal });

    const second = context(store, "job-1", 2, first.checkpointRef);
    const resumed = createExportTreeBodySpoolV1(second, "request-key");
    await expect(
      resumed.prepare(
        entries.map((entry) =>
          entry.ordinal === 1 ? { ...entry, key: "a:v2" } : entry
        ),
        { signal: second.signal },
      ),
    ).rejects.toThrow("discovery changed");
  });

  it("rejects checkpoint coordinates outside the claimed job or lease history", async () => {
    const store = new InMemorySpoolStore();
    const first = context(store, "job-1", 1);
    const initial = createExportTreeBodySpoolV1(first, "request-key");
    await initial.prepare(entries, { signal: first.signal });

    const otherJob = context(store, "job-2", 2, first.checkpointRef);
    await expect(
      createExportTreeBodySpoolV1(otherJob, "request-key").prepare(entries, {
        signal: otherJob.signal,
      }),
    ).rejects.toThrow("escaped its job or lease history");

    const futureRef: SpoolRefV1 = {
      jobId: "job-1",
      leaseEpoch: 3,
      namespace: "source-manifest",
      key: "manifest",
    };
    const futureCheckpoint =
      `atlcli.export-tree-spool/1:${encodeURIComponent(JSON.stringify(futureRef))}`;
    const earlierLease = context(store, "job-1", 2, futureCheckpoint);
    await expect(
      createExportTreeBodySpoolV1(earlierLease, "request-key").prepare(entries, {
        signal: earlierLease.signal,
      }),
    ).rejects.toThrow("escaped its job or lease history");
  });

  it("lets the productive tree fetch resume at the first uncommitted body slot", async () => {
    const store = new InMemorySpoolStore();
    const firstContext = context(store, "job-1", 1);
    const durable = createExportTreeBodySpoolV1(firstContext, "request-key");
    const controller = new AbortController();
    const firstFetched: string[] = [];

    await expect(
      fetchExportTree(
        threePageSource(firstFetched),
        { kind: "tree", rootPageId: "root" },
        {
          signal: controller.signal,
          bodyStore: {
            prepare: (manifest, options) => durable.prepare(manifest, options),
            load: (entry, options) => durable.load(entry, options),
            async commit(entry, value, options) {
              await durable.commit(entry, value, options);
              if (entry.ordinal === 1) {
                controller.abort(new DOMException("Simulated host crash", "AbortError"));
              }
            },
          },
        },
      ),
    ).rejects.toThrow("Simulated host crash");
    expect(firstFetched).toEqual(["root", "a", "b"]);

    const secondContext = context(
      store,
      "job-1",
      2,
      firstContext.checkpointRef,
    );
    const secondFetched: string[] = [];
    const resumed = await fetchExportTree(
      threePageSource(secondFetched),
      { kind: "tree", rootPageId: "root" },
      {
        bodyStore: createExportTreeBodySpoolV1(secondContext, "request-key"),
      },
    );
    expect(secondFetched).toEqual(["b"]);
    expect(resumed.nodes.map((node) => node.title)).toEqual(["Root", "A", "B"]);
    expect(resumed.nodes.every(
      (node) => node.kind !== "page" || node.blocks.length === 1,
    )).toBe(true);
  });
});
