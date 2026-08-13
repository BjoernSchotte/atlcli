import { describe, expect, it } from "bun:test";
import {
  createEmptyExportJobStatsV1,
  InMemoryExportJobStore,
  type DocxExportJobRequestV1,
} from "@atlcli/export-jobs";
import {
  EXPORT_JOB_MONITOR_EVENT_SCHEMA_V1,
  formatConfluenceHierarchyDiagnosticV1,
  formatExportJobStatusLineV1,
  watchExportJobV1,
} from "./export-job-monitor.js";

function request(id: string): DocxExportJobRequestV1 {
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
    displayName: "Documentation",
    createdAt: 1,
    priority: "interactive",
    output: { policy: "collect" },
    template: { recordKey: "default", sha256: "0".repeat(64), name: "Default" },
    options: { embedImages: true, resolveMacros: true },
  };
}

function capture(): { writer: { write(chunk: string): void }; read(): string } {
  let value = "";
  return {
    writer: { write(chunk) { value += chunk; } },
    read: () => value,
  };
}

describe("watchExportJobV1", () => {
  it("renders safe hierarchy diagnostics and progress detail without source content", () => {
    const fallback = formatConfluenceHierarchyDiagnosticV1({
      code: "hierarchy-fallback",
      deployment: "cloud",
      operation: "page-direct-children",
      status: 404,
      requestId: "request-123",
      fallback: "page-descendants",
    });
    expect(fallback).toBe(
      "Cloud hierarchy: operation=page-direct-children status=404 fallback=page-descendants depth=1 request=request-123",
    );

    const line = formatExportJobStatusLineV1({
      schema: "atlcli.export-job/1",
      id: "job",
      revision: 1,
      requestRef: "request",
      format: "docx",
      renderer: "docx-typescript",
      summary: {
        displayName: "Documentation",
        sourceLabel: "Confluence",
        siteOrigin: "https://example.atlassian.net",
        scopeKind: "tree",
      },
      queue: { priority: "interactive", enqueuedAt: 1, groupKey: "group" },
      state: "running",
      attempt: 1,
      recoveryCount: 0,
      leaseEpoch: 1,
      stats: createEmptyExportJobStatsV1(),
      createdAt: 1,
      stage: "discover",
      progress: {
        stage: "discover",
        done: 0,
        total: null,
        detail: fallback,
        updatedAt: 1,
      },
    });
    expect(line).toContain("stage=discover progress=0/? detail=Cloud hierarchy:");
    expect(line).not.toContain("page title");
    expect(line).not.toContain("response body");
  });

  it("polls an externally owned job and emits stable non-TTY lines", async () => {
    const store = new InMemoryExportJobStore({ now: () => 10 });
    await store.create({ request: request("job") });
    const running = await store.claimNext({
      ownerId: "other-process",
      now: 10,
      leaseDurationMs: 1_000,
    });
    if (!running) throw new Error("expected an externally owned job");
    const output = capture();
    let polls = 0;

    const terminal = await watchExportJobV1({
      jobs: store,
      jobId: "job",
      mode: "lines",
      writer: output.writer,
      now: () => 10,
      pollIntervalMs: 0,
      sleep: async () => {
        polls += 1;
        if (polls === 1) {
          const current = await store.get("job");
          if (!current) throw new Error("missing job");
          const failed = await store.compareAndSet({
            kind: "transition",
            id: "job",
            expectedRevision: current.revision,
            leaseEpoch: current.leaseEpoch,
            to: "failed",
            at: 10,
            error: {
              code: "render.failed",
              message: "Render failed.",
              category: "render",
              retryable: true,
              occurredAt: 10,
            },
          });
          await store.appendEvent("job", {
            expectedRevision: failed.revision,
            event: { kind: "issue", seq: 1, at: 10, level: "error", code: "render.failed" },
          });
        }
      },
    });

    expect(terminal.state).toBe("failed");
    expect(output.read()).toContain("job=job state=running format=docx");
    expect(output.read()).toContain("job=job state=failed format=docx");
    expect(output.read()).toContain("event=1 kind=issue error render.failed");
    expect(output.read()).not.toContain("\r");
    expect(output.read()).not.toContain("\u001b");
  });

  it("emits one valid versioned JSON object per line and drains terminal events", async () => {
    const store = new InMemoryExportJobStore({ now: () => 10 });
    await store.create({ request: request("job") });
    const cancelled = await store.compareAndSet({
      kind: "transition",
      id: "job",
      expectedRevision: 0,
      to: "cancelled",
      at: 10,
    });
    await store.appendEvent("job", {
      expectedRevision: cancelled.revision,
      event: { kind: "state", seq: 1, at: 10, from: "queued", to: "cancelled" },
    });
    const output = capture();

    await watchExportJobV1({
      jobs: store,
      jobId: "job",
      mode: "jsonl",
      writer: output.writer,
      now: () => 11,
      pollIntervalMs: 0,
      sleep: async () => {},
    });

    const records = output.read().trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.kind)).toEqual(["snapshot", "event"]);
    expect(records.every((record) => record.schema === EXPORT_JOB_MONITOR_EVENT_SCHEMA_V1)).toBe(true);
    expect(records.every((record) => record.jobId === "job")).toBe(true);
  });

  it("uses one carriage-return status line only for TTY mode", async () => {
    const store = new InMemoryExportJobStore({ now: () => 10 });
    await store.create({ request: request("job") });
    await store.compareAndSet({
      kind: "transition",
      id: "job",
      expectedRevision: 0,
      to: "cancelled",
      at: 10,
    });
    const output = capture();

    await watchExportJobV1({
      jobs: store,
      jobId: "job",
      mode: "tty",
      writer: output.writer,
      pollIntervalMs: 0,
      sleep: async () => {},
    });

    expect(output.read().startsWith("\rjob=job state=cancelled")).toBe(true);
    expect(output.read().endsWith("\n")).toBe(true);
    expect(output.read()).not.toContain("\u001b");
  });

  it("drains more than one event page before terminal watch completion", async () => {
    const store = new InMemoryExportJobStore({ now: () => 10 });
    await store.create({ request: request("job") });
    const cancelled = await store.compareAndSet({
      kind: "transition",
      id: "job",
      expectedRevision: 0,
      to: "cancelled",
      at: 10,
    });
    for (let seq = 1; seq <= 300; seq += 1) {
      await store.appendEvent("job", {
        expectedRevision: cancelled.revision,
        event: { kind: "issue", seq, at: 10 + seq, level: "info", code: `detail-${seq}` },
      });
    }
    const output = capture();

    await watchExportJobV1({
      jobs: store,
      jobId: "job",
      mode: "jsonl",
      writer: output.writer,
      pollIntervalMs: 0,
      sleep: async () => {},
    });

    const records = output.read().trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(301);
    expect(records.at(-1)?.event.seq).toBe(300);
  });
});
