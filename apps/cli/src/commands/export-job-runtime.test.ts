import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import type {
  ExportJobExecutor,
  ExportJobRequestV1,
  PdfExportJobRequestV1,
} from "@atlcli/export-jobs";
import { createFileExportJobPersistence } from "@atlcli/export-node";
import {
  readOrdinaryExportProjectionV1,
  runOrdinaryExportJobV1,
  writeOrdinaryExportProjectionV1,
} from "./export-job-runtime.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atlcli-ordinary-job-"));
  roots.push(root);
  return root;
}

function request(outputPath: string): PdfExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id: "job-ordinary-1",
    idempotencyKey: "ordinary-key-1",
    format: "pdf",
    renderer: "pdf-typst",
    source: {
      kind: "confluence",
      siteOrigin: "https://example.atlassian.net",
      locator: { kind: "content-key", value: "DOCS:Architecture" },
      scope: { kind: "page" },
      completenessMode: "strict",
    },
    authRef: "cli-profile:test",
    displayName: "Architecture",
    requestedFilename: "architecture.pdf",
    createdAt: 100,
    priority: "interactive",
    output: { policy: "path", targetRef: outputPath, overwriteExisting: false },
    template: { id: "builtin-default", manifestVersion: "1" },
    settings: {},
    options: { resolveMacros: true },
  };
}

function successfulExecutor(input: {
  root: string;
  bytes: Uint8Array;
  order: string[];
  executions: { count: number };
}): ExportJobExecutor<PdfExportJobRequestV1> {
  return {
    format: "pdf",
    async execute(_request, context) {
      input.order.push("resolve-source");
      input.executions.count += 1;
      const sha256 = createHash("sha256").update(input.bytes).digest("hex");
      const stagedArtifact = await context.artifacts.stage({
        mediaType: "application/pdf",
        filename: "architecture.pdf",
        byteLength: input.bytes.byteLength,
        sha256,
        bytes: (async function* () { yield input.bytes; })(),
      });
      const reportRef = join(input.root, "engine-report.json");
      await writeFile(reportRef, JSON.stringify({ schema: "engine-report/1", pages: 3 }));
      return { stagedArtifact, reportRef };
    },
  };
}

describe("ordinary export job runtime", () => {
  it("durably creates the unresolved request before source resolution, then delivers atomically", async () => {
    const root = await fixtureRoot();
    const outputPath = join(root, "architecture.pdf");
    const persistence = createFileExportJobPersistence({ rootDir: join(root, "state") });
    const order: string[] = [];
    const executions = { count: 0 };
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49]);

    const result = await runOrdinaryExportJobV1({
      request: request(outputPath),
      executor: successfulExecutor({ root, bytes, order, executions }),
      persistence,
      ownerId: "owner-1",
      pollIntervalMs: 0,
      loadReport: async (ref) => JSON.parse(await readFile(ref, "utf8")),
      onDurableCreate: async (snapshot) => {
        order.push("durable-create");
        const stored = await persistence.jobs.getRequest(snapshot.requestRef);
        expect(stored?.source.locator).toEqual({ kind: "content-key", value: "DOCS:Architecture" });
      },
    });

    expect(order).toEqual(["durable-create", "resolve-source"]);
    expect(executions.count).toBe(1);
    expect(result.snapshot).toMatchObject({ state: "succeeded", deliveredAt: expect.any(Number) });
    expect(result.report).toEqual({ schema: "engine-report/1", pages: 3 });
    expect(new Uint8Array(await readFile(outputPath))).toEqual(bytes);
  });

  it("streams ordinary command activity as versioned JSONL until delivery is terminal", async () => {
    const root = await fixtureRoot();
    const chunks: string[] = [];
    await runOrdinaryExportJobV1({
      request: request(join(root, "monitored.pdf")),
      executor: successfulExecutor({
        root,
        bytes: new Uint8Array([1, 2, 3, 4]),
        order: [],
        executions: { count: 0 },
      }),
      persistence: createFileExportJobPersistence({ rootDir: join(root, "state") }),
      pollIntervalMs: 0,
      monitor: { mode: "jsonl", writer: { write: (chunk) => chunks.push(chunk) } },
    });

    const records = chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.length).toBeGreaterThan(1);
    expect(records.every((record) => record.schema === "atlcli.export-job-event/1")).toBe(true);
    expect(records.some((record) => record.snapshot?.state === "succeeded")).toBe(true);
  });

  it("two processes join one idempotent job and only one executor owns the claim", async () => {
    const root = await fixtureRoot();
    const outputPath = join(root, "architecture.pdf");
    const persistence = createFileExportJobPersistence({ rootDir: join(root, "state") });
    const executions = { count: 0 };
    const executor = successfulExecutor({
      root,
      bytes: new Uint8Array([1, 2, 3]),
      order: [],
      executions,
    });
    const shared = request(outputPath);

    const [left, right] = await Promise.all([
      runOrdinaryExportJobV1({ request: shared, executor, persistence, ownerId: "left", pollIntervalMs: 1 }),
      runOrdinaryExportJobV1({ request: shared, executor, persistence, ownerId: "right", pollIntervalMs: 1 }),
    ]);

    expect(executions.count).toBe(1);
    expect(left.snapshot.id).toBe(right.snapshot.id);
    expect(left.snapshot.deliveredAt).toBeDefined();
    expect(right.snapshot.deliveredAt).toBeDefined();
  });

  it("claims only its own job and leaves older same-profile work queued", async () => {
    const root = await fixtureRoot();
    const persistence = createFileExportJobPersistence({ rootDir: join(root, "state") });
    const current = request(join(root, "current.pdf"));
    const older: PdfExportJobRequestV1 = {
      ...request(join(root, "older.pdf")),
      id: "job-older",
      idempotencyKey: "ordinary-key-older",
      createdAt: 1,
    };
    await persistence.jobs.create({ request: older });

    const result = await runOrdinaryExportJobV1({
      request: current,
      executor: successfulExecutor({
        root,
        bytes: new Uint8Array([4, 5, 6]),
        order: [],
        executions: { count: 0 },
      }),
      persistence,
      pollIntervalMs: 0,
    });

    expect(result.snapshot.id).toBe(current.id);
    expect((await persistence.jobs.get(older.id))?.state).toBe("queued");
  });

  it("delivers directory targets using the finalized artifact filename", async () => {
    const root = await fixtureRoot();
    const outputDir = join(root, "exports");
    const persistence = createFileExportJobPersistence({ rootDir: join(root, "state") });
    const directoryRequest: PdfExportJobRequestV1 = {
      ...request(outputDir),
      output: { policy: "path", targetRef: outputDir, targetKind: "directory" },
      requestedFilename: undefined,
    };
    const bytes = new Uint8Array([7, 8, 9]);

    await runOrdinaryExportJobV1({
      request: directoryRequest,
      executor: successfulExecutor({ root, bytes, order: [], executions: { count: 0 } }),
      persistence,
      pollIntervalMs: 0,
    });

    expect(new Uint8Array(await readFile(join(outputDir, "architecture.pdf")))).toEqual(bytes);
  });

  it("round-trips the durable CLI report projection without exposing it as a path ref", async () => {
    const root = await fixtureRoot();
    const persistence = createFileExportJobPersistence({ rootDir: join(root, "state") });
    const value = { outputPath: "/exports/report.pdf", sourcePages: [{ id: "123" }] };
    await writeOrdinaryExportProjectionV1(persistence, {
      schema: "atlcli.cli-export-projection/1",
      jobId: "job/projection",
      format: "pdf",
      value,
    });
    expect(await readOrdinaryExportProjectionV1<typeof value>(persistence, "job/projection", "pdf")).toEqual(value);
    await expect(readOrdinaryExportProjectionV1(persistence, "job/projection", "docx")).rejects.toThrow(
      "Invalid CLI export projection",
    );
  });

  it("persists cancellation before aborting the claimed executor", async () => {
    const root = await fixtureRoot();
    const outputPath = join(root, "cancelled.pdf");
    const persistence = createFileExportJobPersistence({ rootDir: join(root, "state") });
    const controller = new AbortController();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const executor: ExportJobExecutor<PdfExportJobRequestV1> = {
      format: "pdf",
      async execute(_request, context): Promise<never> {
        started();
        return await new Promise<never>((_resolve, reject) => {
          if (context.signal.aborted) reject(context.signal.reason);
          else context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        });
      },
    };

    const running = runOrdinaryExportJobV1({
      request: request(outputPath),
      executor,
      persistence,
      ownerId: "owner-cancel",
      signal: controller.signal,
      pollIntervalMs: 0,
    });
    await startedPromise;
    controller.abort();
    const result = await running;

    expect(result.snapshot.state).toBe("cancelled");
    expect(result.snapshot.artifact).toBeUndefined();
    expect(result.snapshot.deliveredAt).toBeUndefined();
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a crash after exact file delivery but before delivered metadata", async () => {
    const root = await fixtureRoot();
    const outputPath = join(root, "already-delivered.pdf");
    const persistence = createFileExportJobPersistence({ rootDir: join(root, "state") });
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const executor: ExportJobExecutor<PdfExportJobRequestV1> = {
      format: "pdf",
      async execute(_request, context) {
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const stagedArtifact = await context.artifacts.stage({
          mediaType: "application/pdf",
          filename: "already-delivered.pdf",
          byteLength: bytes.byteLength,
          sha256,
          bytes: (async function* () { yield bytes; })(),
        });
        // Simulate the previous owner dying after its atomic delivery write and
        // before it could persist `deliveredAt`.
        await writeFile(outputPath, bytes);
        return { stagedArtifact };
      },
    };

    const result = await runOrdinaryExportJobV1({
      request: request(outputPath),
      executor,
      persistence,
      pollIntervalMs: 0,
    });
    expect(result.snapshot.deliveredAt).toBeDefined();
    expect(new Uint8Array(await readFile(outputPath))).toEqual(bytes);
  });

  it("rejects a format mismatch before creating durable state", async () => {
    const root = await fixtureRoot();
    const persistence = createFileExportJobPersistence({ rootDir: join(root, "state") });
    const mismatched: ExportJobExecutor<ExportJobRequestV1> = {
      format: "docx",
      async execute() { throw new Error("unreachable"); },
    };
    await expect(
      runOrdinaryExportJobV1({
        request: request(join(root, "x.pdf")),
        executor: mismatched,
        persistence,
      }),
    ).rejects.toThrow("format does not match");
    expect(await persistence.jobs.list({ includeDismissed: true })).toEqual([]);
  });
});
