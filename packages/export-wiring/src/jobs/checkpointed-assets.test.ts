import { describe, expect, it } from "bun:test";
import {
  InMemorySpoolStore,
  bindExportJobSpool,
  type ExportJobExecutionContext,
  type SpoolWriteLimitsV1,
} from "@atlcli/export-jobs";
import type { ExportTreeBodyManifestEntryV1 } from "@atlcli/confluence";
import {
  checkpointDocxAssetsV1,
  checkpointPdfAssetsV1,
} from "./checkpointed-assets.js";
import { createExportTreeBodySpoolV1 } from "./tree-body-spool.js";

const limits: SpoolWriteLimitsV1 = {
  maxObjectBytes: 128 * 1024 * 1024,
  maxJobBytes: 512 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
};

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

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

const treeEntries: ExportTreeBodyManifestEntryV1[] = [
  { ordinal: 0, key: "root:v1", pageId: "root", title: "Root" },
];

describe("checkpointed job assets", () => {
  it("recovers a PDF asset across lease epochs without another host fetch", async () => {
    const store = new InMemorySpoolStore();
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const first = context(store, "pdf-job", 1);
    let fetches = 0;
    const resolver = checkpointPdfAssetsV1(first, "request-key", {
      async resolve() {
        fetches += 1;
        return { bytes, mediaType: "image/png", filename: "figure.png" };
      },
    });
    const ref = { kind: "attachment" as const, pageId: "42", filename: "figure.png" };

    expect(await resolver.resolve(ref)).toEqual({
      bytes,
      mediaType: "image/png",
      filename: "figure.png",
    });
    expect(await resolver.resolve(ref)).toEqual({
      bytes,
      mediaType: "image/png",
      filename: "figure.png",
    });
    expect(fetches).toBe(1);
    expect(first.checkpointRef).toStartWith("atlcli.export-asset-spool/1:");

    const digest = await sha256(bytes);
    expect(await store.stat({
      jobId: "pdf-job",
      leaseEpoch: 1,
      namespace: "assets",
      key: digest,
    })).toMatchObject({ byteLength: 4, sha256: digest });

    const second = context(store, "pdf-job", 2, first.checkpointRef);
    const recovered = checkpointPdfAssetsV1(second, "request-key", {
      async resolve() {
        throw new Error("Recovered asset must not hit the host.");
      },
    });
    expect(await recovered.resolve(ref)).toEqual({
      bytes,
      mediaType: "image/png",
      filename: "figure.png",
    });
  });

  it("deduplicates equal DOCX bytes physically across different references", async () => {
    const store = new InMemorySpoolStore();
    const execution = context(store, "docx-job", 1);
    const bytes = Uint8Array.of(9, 8, 7);
    let fetches = 0;
    const assets = checkpointDocxAssetsV1(execution, "request-key", {
      async fetch() {
        fetches += 1;
        return bytes;
      },
    });

    const [one, two] = await Promise.all([
      assets.fetch({ url: "/download/attachments/1/a.png", pageId: "1", filename: "a.png" }),
      assets.fetch({ url: "/download/attachments/2/b.png", pageId: "2", filename: "b.png" }),
    ]);
    expect(one).toEqual(bytes);
    expect(two).toEqual(bytes);
    expect(fetches).toBe(2);

    const digest = await sha256(bytes);
    expect(await store.stat({
      jobId: "docx-job",
      leaseEpoch: 1,
      namespace: "assets",
      key: digest,
    })).toMatchObject({ byteLength: 3, sha256: digest });
  });

  it("lets source recovery traverse asset checkpoints published after the tree", async () => {
    const store = new InMemorySpoolStore();
    const first = context(store, "mixed-job", 1);
    const tree = createExportTreeBodySpoolV1(first, "request-key");
    await tree.prepare(treeEntries, { signal: first.signal });
    await tree.commit(
      treeEntries[0]!,
      {
        ok: true,
        pageId: "root",
        title: "Root",
        source: { representation: "storage", degraded: false },
        blocks: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }],
        notes: [],
        meta: { version: 1, labels: [], spaceKey: "TEST" },
      },
      { signal: first.signal },
    );
    const assets = checkpointDocxAssetsV1(first, "request-key", {
      async fetch() {
        return Uint8Array.of(1, 3, 3, 7);
      },
    });
    await assets.fetch({ url: "/download/attachments/root/figure.png" });
    expect(first.checkpointRef).toStartWith("atlcli.export-asset-spool/1:");

    const second = context(store, "mixed-job", 2, first.checkpointRef);
    const recoveredTree = createExportTreeBodySpoolV1(second, "request-key");
    await recoveredTree.prepare(treeEntries, { signal: second.signal });
    expect(await recoveredTree.load(treeEntries[0]!, { signal: second.signal }))
      .toMatchObject({ ok: true, pageId: "root", title: "Root" });
  });

  it("reserves unknown-length host fetches before starting them", async () => {
    const store = new InMemorySpoolStore();
    const execution = context(store, "bounded-job", 1);
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const assets = checkpointDocxAssetsV1(execution, "request-key", {
      async fetch() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return Uint8Array.of(active + 1);
      },
    });

    const runs = ["a", "b", "c"].map((name) =>
      assets.fetch({ url: `https://assets.example/${name}.png` }),
    );
    while (releases.length < 2) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(peak).toBe(2);
    expect(releases).toHaveLength(2);
    releases.shift()!();
    while (releases.length < 2) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    releases.splice(0).forEach((release) => release());
    await Promise.all(runs);
    expect(peak).toBe(2);
  });
});
