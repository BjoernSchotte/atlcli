import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  InMemoryArtifactStore,
  InMemoryExportJobStore,
  InMemorySpoolStore,
  InMemoryTemplatePackStoreV1,
  templatePackReference,
  type DocxExportJobRequestV1,
  type ExportJobSnapshotV1,
  type PdfExportJobRequestV1,
  type TemplatePackReachabilityV1,
} from "@atlcli/export-jobs";
import { handleExportJobs, type ExportJobPersistenceV1 } from "./export-jobs.js";

const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function request(
  id: string,
  createdAt = 1,
  output: DocxExportJobRequestV1["output"] = { policy: "collect" },
): DocxExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `idem:${id}`,
    format: "docx",
    renderer: "docx-typescript",
    source: {
      kind: "confluence",
      siteOrigin: "https://example.atlassian.net",
      locator: { kind: "space-key", spaceKey: "DOCS" },
      scope: { kind: "space" },
    },
    authRef: "profile:test",
    displayName: id,
    createdAt,
    priority: "interactive",
    output,
    template: { recordKey: "default", sha256: "0".repeat(64), name: "Default" },
    options: { embedImages: true, resolveMacros: true },
  };
}

function pdfRequest(
  id: string,
  template: PdfExportJobRequestV1["template"],
): PdfExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `idem:${id}`,
    format: "pdf",
    renderer: "pdf-typst",
    source: {
      kind: "confluence",
      siteOrigin: "https://example.atlassian.net",
      locator: { kind: "space-key", spaceKey: "DOCS" },
      scope: { kind: "space" },
    },
    authRef: "profile:test",
    displayName: id,
    createdAt: 1,
    priority: "interactive",
    output: { policy: "collect" },
    template,
    settings: {},
    options: { resolveMacros: true },
  };
}

function persistence(now = 1_000): ExportJobPersistenceV1 {
  const artifacts = new InMemoryArtifactStore({ now: () => 10 });
  return {
    jobs: new InMemoryExportJobStore({ now: () => 10, artifactStore: artifacts }),
    spool: new InMemorySpoolStore({ now: () => 10 }),
    artifacts,
    async reconcile(observedAt) {
      expect(observedAt).toBe(now);
    },
  };
}

function capture(): { writer: { write(chunk: string): void }; read(): string } {
  let value = "";
  return {
    writer: { write(chunk) { value += chunk; } },
    read: () => value,
  };
}

function failTest(message: string): never {
  throw new Error(message);
}

function deps(store: ExportJobPersistenceV1, output = capture()) {
  return {
    dependencies: {
      createPersistence: async () => store,
      stdout: output.writer,
      stderr: output.writer,
      now: () => 1_000,
      createId: () => "derived-job",
      fail: failTest,
      sleep: async () => {},
      isTTY: false,
    },
    output,
  };
}

async function failJob(
  persistence: ExportJobPersistenceV1,
  id: string,
  createdAt = 1,
  output?: DocxExportJobRequestV1["output"],
): Promise<ExportJobSnapshotV1> {
  await persistence.jobs.create({ request: request(id, createdAt, output) });
  const running = await persistence.jobs.claimNext({
    ownerId: "test",
    now: 10,
    leaseDurationMs: 2_000,
  });
  if (!running || running.id !== id) throw new Error("expected claimed job");
  return persistence.jobs.compareAndSet({
    kind: "transition",
    id,
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
}

async function succeedJob(
  persistence: ExportJobPersistenceV1,
  id: string,
  output?: DocxExportJobRequestV1["output"],
): Promise<ExportJobSnapshotV1> {
  await persistence.jobs.create({ request: request(id, 1, output) });
  const running = await persistence.jobs.claimNext({
    ownerId: "test",
    now: 10,
    leaseDurationMs: 2_000,
  });
  if (!running || running.id !== id) throw new Error("expected claimed job");
  const staged = await persistence.artifacts.stage(id, running.leaseEpoch, {
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    filename: `${id}.docx`,
    byteLength: 3,
    sha256: ABC_SHA256,
    bytes: (async function* () { yield Uint8Array.from([97, 98, 99]); })(),
  });
  return persistence.jobs.finalizeArtifact({
    id,
    expectedRevision: running.revision,
    leaseEpoch: running.leaseEpoch,
    stagedArtifact: staged,
    finishedAt: 20,
  });
}

async function failPdfJob(
  persistence: ExportJobPersistenceV1,
  input: PdfExportJobRequestV1,
): Promise<ExportJobSnapshotV1> {
  await persistence.jobs.create({ request: input });
  const running = await persistence.jobs.claimNext({
    ownerId: "test",
    now: 10,
    leaseDurationMs: 2_000,
  });
  if (!running || running.id !== input.id) throw new Error("expected claimed PDF job");
  return persistence.jobs.compareAndSet({
    kind: "transition",
    id: input.id,
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
}

describe("handleExportJobs", () => {
  it("reconciles stale durable work before executing a valid command", async () => {
    const store = persistence();
    let reconciliations = 0;
    store.reconcile = async (observedAt) => {
      expect(observedAt).toBe(1_000);
      reconciliations += 1;
    };
    const { dependencies } = deps(store);

    await handleExportJobs(["list"], {}, { json: false }, dependencies);

    expect(reconciliations).toBe(1);
  });

  it("lists filtered activity as one versioned JSON document", async () => {
    const store = persistence();
    await failJob(store, "failed", 9);
    await store.jobs.create({ request: request("queued", 8) });
    const { dependencies, output } = deps(store);

    await handleExportJobs(
      ["list"],
      { status: "failed", format: "docx", since: "992ms", json: true },
      { json: true },
      dependencies,
    );

    const result = JSON.parse(output.read());
    expect(result.schema).toBe("atlcli.export-jobs-list/1");
    expect(result.jobs.map((job: ExportJobSnapshotV1) => job.id)).toEqual(["failed"]);
  });

  it("shows detail with events and acknowledges terminal activity", async () => {
    const store = persistence();
    const failed = await failJob(store, "failed");
    await store.jobs.appendEvent("failed", {
      expectedRevision: failed.revision,
      event: { kind: "issue", seq: 1, at: 21, level: "error", code: "render.failed" },
    });
    const { dependencies, output } = deps(store);

    await handleExportJobs(["show", "failed"], { json: true }, { json: true }, dependencies);

    const detail = JSON.parse(output.read());
    expect(detail.schema).toBe("atlcli.export-job-detail/1");
    expect(detail.job.acknowledgedAt).toBe(1_000);
    expect(detail.events).toHaveLength(1);
    expect((await store.jobs.get("failed"))?.acknowledgedAt).toBe(1_000);
  });

  it("requests cancellation with a revision-fenced transition", async () => {
    const store = persistence();
    await store.jobs.create({ request: request("queued") });
    const { dependencies, output } = deps(store);

    await handleExportJobs(["cancel", "queued"], {}, { json: false }, dependencies);

    expect((await store.jobs.get("queued"))?.state).toBe("cancelled");
    expect(output.read()).toContain("state=cancelled");
  });

  it("creates a linked retry with only the explicit output target overridden", async () => {
    const store = persistence();
    await failJob(store, "failed");
    const { dependencies, output } = deps(store);

    await handleExportJobs(
      ["retry", "failed"],
      { output: "./retry.docx" },
      { json: false },
      dependencies,
    );

    const derived = await store.jobs.get("derived-job");
    const derivedRequest = derived ? await store.jobs.getRequest(derived.requestRef) : undefined;
    expect(derived?.derivedFrom).toEqual({
      jobId: "failed",
      relation: "retry",
      actionKey: "cli:retry:derived-job",
    });
    expect(derivedRequest?.output).toMatchObject({
      policy: "path",
      targetRef: resolve("retry.docx"),
      overwriteExisting: false,
    });
    expect(derivedRequest?.source).toEqual(request("failed").source);
    expect(output.read()).toContain("Retry queued: derived-job");
  });

  it("verifies and links a content-addressed PDF pack when retry creates a job", async () => {
    const store = persistence();
    const backingStore = new InMemoryTemplatePackStoreV1();
    const record = await backingStore.put({
      bytes: new Uint8Array([1, 2, 3]),
      limits: { maxObjectBytes: 8, maxTotalBytes: 8 },
      now: 1,
    });
    const links: Array<TemplatePackReachabilityV1 & { at: number }> = [];
    store.templatePacks = {
      put: backingStore.put.bind(backingStore),
      get: backingStore.get.bind(backingStore),
      verify: backingStore.verify.bind(backingStore),
      reconcile: backingStore.reconcile.bind(backingStore),
      async link(input) {
        links.push(structuredClone(input));
        await backingStore.link(input);
      },
    };
    await failPdfJob(store, pdfRequest("failed-pdf", templatePackReference(record)));
    const { dependencies } = deps(store);

    await handleExportJobs(
      ["retry", "failed-pdf"],
      {},
      { json: false },
      dependencies,
    );

    const derived = await store.jobs.get("derived-job");
    if (!derived) throw new Error("expected a derived PDF job");
    expect(links).toEqual([
      {
        jobId: "derived-job",
        requestRef: derived.requestRef,
        recordKey: record.recordKey,
        archiveSha256: record.archiveSha256,
        at: 1_000,
      },
    ]);
  });

  it("preserves an original overwrite authorization for Retry without a new target", async () => {
    const store = persistence();
    await failJob(store, "failed", 1, {
      policy: "path",
      targetRef: "/exports/original.docx",
      overwriteExisting: true,
    });
    const { dependencies } = deps(store);

    await handleExportJobs(["retry", "failed"], {}, { json: false }, dependencies);

    const derived = await store.jobs.get("derived-job");
    const derivedRequest = derived ? await store.jobs.getRequest(derived.requestRef) : undefined;
    expect(derivedRequest?.output).toEqual({
      policy: "path",
      targetRef: "/exports/original.docx",
      overwriteExisting: true,
    });
  });

  it("executes a newly derived replay through the production hook exactly once", async () => {
    const store = persistence();
    await failJob(store, "failed");
    const { dependencies, output } = deps(store);
    const calls: Array<{ requestId: string; snapshotId: string }> = [];

    await handleExportJobs(["retry", "failed"], {}, { json: false }, {
      ...dependencies,
      async executeReplay(replayRequest, snapshot) {
        calls.push({ requestId: replayRequest.id, snapshotId: snapshot.id });
      },
    });

    expect(calls).toEqual([{ requestId: "derived-job", snapshotId: "derived-job" }]);
    expect(output.read()).toBe("");
  });

  it("resumes the same queued job without creating a derived history row", async () => {
    const store = persistence();
    const queued = await store.jobs.create({
      request: request("checkpointed", 1, {
        policy: "path",
        targetRef: "/exports/checkpointed.docx",
      }),
    });
    const { dependencies, output } = deps(store);
    const calls: Array<{
      requestId: string;
      snapshotId: string;
      requestRef: string;
    }> = [];

    await handleExportJobs(["resume", "checkpointed"], {}, { json: false }, {
      ...dependencies,
      async executeReplay(resumeRequest, snapshot) {
        calls.push({
          requestId: resumeRequest.id,
          snapshotId: snapshot.id,
          requestRef: snapshot.requestRef,
        });
      },
    });

    expect(calls).toEqual([{
      requestId: "checkpointed",
      snapshotId: "checkpointed",
      requestRef: queued.requestRef,
    }]);
    expect(await store.jobs.list({ includeDismissed: true })).toHaveLength(1);
    expect(output.read()).toBe("");
  });

  it("rejects Resume for terminal jobs instead of silently deriving a new row", async () => {
    const store = persistence();
    await failJob(store, "failed");
    const { dependencies } = deps(store);

    await expect(
      handleExportJobs(["resume", "failed"], {}, { json: false }, {
        ...dependencies,
        async executeReplay() {
          throw new Error("must not execute");
        },
      }),
    ).rejects.toThrow("Resume requires queued work");
    expect(await store.jobs.get("derived-job")).toBeUndefined();
  });

  it("marks a queued Resume interrupted when foreground preflight cannot start", async () => {
    const store = persistence();
    await store.jobs.create({ request: request("checkpointed") });
    const { dependencies } = deps(store);

    await expect(
      handleExportJobs(["resume", "checkpointed"], {}, { json: false }, {
        ...dependencies,
        async executeReplay() {
          throw new Error("profile unavailable");
        },
      }),
    ).rejects.toThrow("profile unavailable");
    expect(await store.jobs.get("checkpointed")).toMatchObject({
      state: "interrupted",
      error: {
        code: "host.replay-start-failed",
        message: "profile unavailable",
        retryable: true,
      },
    });
  });

  it("executes an idempotently existing replay through the production hook exactly once", async () => {
    const store = persistence();
    await failJob(store, "failed");
    const first = deps(store);
    await handleExportJobs(["retry", "failed"], {}, { json: false }, first.dependencies);
    const second = deps(store);
    let calls = 0;

    await handleExportJobs(["retry", "failed"], {}, { json: false }, {
      ...second.dependencies,
      async executeReplay(replayRequest, snapshot) {
        calls += 1;
        expect(replayRequest.id).toBe("derived-job");
        expect(snapshot.id).toBe("derived-job");
      },
    });

    expect(calls).toBe(1);
    expect(second.output.read()).toBe("");
  });

  it("propagates foreground replay hook failures without printing queued success", async () => {
    const store = persistence();
    await failJob(store, "failed");
    const { dependencies, output } = deps(store);

    await expect(
      handleExportJobs(["retry", "failed"], {}, { json: false }, {
        ...dependencies,
        async executeReplay() {
          throw new Error("foreground replay failed");
        },
      }),
    ).rejects.toThrow("foreground replay failed");
    expect(output.read()).toBe("");
    expect(await store.jobs.get("derived-job")).toMatchObject({
      state: "interrupted",
      error: { code: "host.replay-start-failed", retryable: true },
    });
  });

  it("reruns a successful export without inheriting its overwrite authorization", async () => {
    const store = persistence();
    await succeedJob(store, "successful", {
      policy: "path",
      targetRef: "/exports/original.docx",
      overwriteExisting: true,
    });
    const { dependencies } = deps(store);

    await handleExportJobs(["rerun", "successful"], {}, { json: false }, dependencies);

    expect(await store.jobs.get("derived-job")).toMatchObject({
      state: "queued",
      derivedFrom: { jobId: "successful", relation: "rerun" },
    });
    const derived = await store.jobs.get("derived-job");
    const derivedRequest = derived ? await store.jobs.getRequest(derived.requestRef) : undefined;
    expect(derivedRequest?.output).toEqual({
      policy: "path",
      targetRef: "/exports/original.docx",
      overwriteExisting: false,
    });
  });

  it("tombstones eligible terminal rows and completes owned-byte cleanup", async () => {
    const store = persistence();
    await failJob(store, "old-failure");
    const { dependencies, output } = deps(store);

    await handleExportJobs(
      ["clear"],
      { before: "1ms", confirm: true, json: true },
      { json: true },
      dependencies,
    );

    const result = JSON.parse(output.read());
    expect(result).toEqual({
      schema: "atlcli.export-job-clear/1",
      deletedJobIds: ["old-failure"],
      cleanedBytes: 0,
    });
    expect(await store.jobs.get("old-failure")).toBeUndefined();
    expect((await store.jobs.getTombstone("old-failure"))?.cleanupCompletedAt).toBe(1_000);
  });

  it("rejects detached execution explicitly", async () => {
    const store = persistence();
    const { dependencies } = deps(store);
    await expect(
      handleExportJobs(["list"], { detach: true }, { json: false }, dependencies),
    ).rejects.toThrow("--detach is not supported");
  });

  it("rejects unknown subcommands as usage errors", async () => {
    const store = persistence();
    const { dependencies } = deps(store);
    await expect(
      handleExportJobs(["unknown"], {}, { json: false }, dependencies),
    ).rejects.toThrow("Unknown export jobs command: unknown");
  });
});
