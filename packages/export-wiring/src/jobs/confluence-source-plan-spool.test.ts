import { describe, expect, it } from "bun:test";
import {
  InMemorySpoolStore,
  bindExportJobSpool,
  type ExportJobExecutionContext,
  type SpoolWriteLimitsV1,
} from "@atlcli/export-jobs";
import type { ConfluenceSourcePlanCheckpointV1 } from "./confluence-source-plan-checkpoint.js";
import { createConfluenceSourcePlanSpoolV1 } from "./confluence-source-plan-spool.js";
import { createExportTreeBodySpoolV1 } from "./tree-body-spool.js";

const limits: SpoolWriteLimitsV1 = {
  maxObjectBytes: 16 * 1024 * 1024,
  maxJobBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
};

function context(
  store: InMemorySpoolStore,
  leaseEpoch: number,
  checkpointRef?: string,
): ExportJobExecutionContext {
  const value: ExportJobExecutionContext = {
    jobId: "job-1",
    leaseEpoch,
    ...(checkpointRef ? { checkpointRef } : {}),
    signal: new AbortController().signal,
    spool: bindExportJobSpool(store, "job-1", leaseEpoch, limits),
    readSpool: (ref, options) => store.read(ref, options),
    artifacts: {
      async stage() { throw new Error("unused"); },
      async getStaged() { return undefined; },
    },
    async updateProgress() {},
    async updateStats() {},
    async appendEvent() {},
    async checkpoint(ref) { value.checkpointRef = ref; },
  };
  return value;
}

function checkpoint(): ConfluenceSourcePlanCheckpointV1 {
  return {
    schema: "atlcli.confluence-source-plan-checkpoint/1",
    jobId: "job-1",
    requestKey: "request-1",
    sourcePolicyKey: "adf-primary:v1",
    committedLeaseEpoch: 1,
    root: { id: "root", title: "Root", version: 1 },
    plan: {
      schema: "atlcli.export-tree-plan/1",
      scope: { kind: "page", pageId: "root" },
      policy: {
        completenessMode: "strict",
        maxPages: 500,
        maxFolders: 200,
      },
      rootId: "root",
      includeRoot: true,
      nodes: [{
        kind: "page",
        pageId: "root",
        title: "Root",
        depth: 0,
        effectiveDepth: 0,
        parentId: null,
        position: null,
        observedVersion: 1,
      }],
      notes: [],
      complete: true,
    },
  };
}

describe("createConfluenceSourcePlanSpoolV1", () => {
  it("recovers a pre-body plan through later tree-body checkpoints", async () => {
    const bytes = new InMemorySpoolStore();
    const first = context(bytes, 1);
    const plans = createConfluenceSourcePlanSpoolV1(first);
    const sourcePlan = checkpoint();
    const planRef = await plans.commit(sourcePlan, {
      leaseEpoch: 1,
      signal: first.signal,
    });
    await first.checkpoint(planRef);

    const bodies = createExportTreeBodySpoolV1(first, "request-1");
    const entry = { ordinal: 0, key: "root:v1", pageId: "root", title: "Root" };
    await bodies.prepare([entry], { signal: first.signal });
    await bodies.commit(entry, {
      ok: true,
      pageId: "root",
      title: "Root",
      source: { representation: "atlas_doc_format", degraded: false },
      blocks: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
      notes: [],
      meta: { version: 1, labels: [] },
    }, { signal: first.signal });

    const second = context(bytes, 2, first.checkpointRef);
    const recovered = await createConfluenceSourcePlanSpoolV1(second).load(
      {
        jobId: "job-1",
        requestKey: "request-1",
        sourcePolicyKey: "adf-primary:v1",
      },
      { signal: second.signal },
    );

    expect(recovered?.checkpoint).toEqual(sourcePlan);
    expect(recovered?.ref).toBe(planRef);
  });

  it("refuses a foreign source-policy identity", async () => {
    const bytes = new InMemorySpoolStore();
    const first = context(bytes, 1);
    const plans = createConfluenceSourcePlanSpoolV1(first);
    const ref = await plans.commit(checkpoint(), {
      leaseEpoch: 1,
      signal: first.signal,
    });
    await first.checkpoint(ref);

    await expect(plans.load(
      {
        jobId: "job-1",
        requestKey: "request-1",
        sourcePolicyKey: "storage-primary:v1",
      },
      { signal: first.signal },
    )).rejects.toThrow("identity does not match");
  });
});
