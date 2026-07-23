import { describe, expect, it } from "bun:test";
import type { ExportJobSnapshotV1 } from "@atlcli/export-jobs";
import type { PdfExportReport } from "@atlcli/pdf/browser";
import {
  runSubmittedExtensionPdfExport,
  type RunSubmittedExtensionPdfExportDepsV1,
} from "../../utils/export-jobs/pdf-run.js";
import type { PdfExportRequest } from "../../utils/ports/export.js";

function snapshot(
  revision: number,
  state: ExportJobSnapshotV1["state"],
  overrides: Partial<ExportJobSnapshotV1> = {},
): ExportJobSnapshotV1 {
  return {
    schema: "atlcli.export-job/1",
    id: "pdf-run",
    revision,
    requestRef: "request:pdf-run",
    format: "pdf",
    renderer: "pdf-typst",
    summary: {
      displayName: "Guide",
      sourceLabel: "42",
      siteOrigin: "https://site.atlassian.net",
      scopeKind: "page",
    },
    queue: {
      priority: "interactive",
      enqueuedAt: 1,
      groupKey: "https://site.atlassian.net",
    },
    state,
    attempt: state === "queued" ? 0 : 1,
    recoveryCount: 0,
    leaseEpoch: state === "queued" ? 0 : 1,
    stats: {
      pages: { discovered: 0, fetched: 0, composed: 0, skipped: 0 },
      assets: {
        discovered: 0,
        fetched: 0,
        embedded: 0,
        skipped: 0,
        deduplicated: 0,
        logicalBytes: 0,
        physicalBytes: 0,
      },
      diagrams: { discovered: 0, rendered: 0, rasterized: 0, failed: 0 },
      macros: { discovered: 0, rendered: 0, approximated: 0, unresolved: 0 },
      retries: { total: 0, rateLimited: 0, network: 0, worker: 0 },
      storage: { spoolBytes: 0, spoolPeakBytes: null, outputBytes: 0 },
      memory: { heapPeakBytes: null, rendererPeakBytes: null },
      metricSupport: {},
      durationsMs: {},
      warnings: 0,
      errors: 0,
    },
    createdAt: 1,
    ...overrides,
  };
}

const request = (signal?: AbortSignal): PdfExportRequest => ({
  pageUrl: "https://site.atlassian.net/wiki/spaces/DOCS/pages/42/Guide",
  page: {
    details: { id: "42", title: "Guide", storage: "<p>not durable</p>" },
    markdown: "not durable",
    wordCount: 2,
    attachments: [],
  },
  ...(signal ? { signal } : {}),
});

const report = {
  filename: "Guide.pdf",
  profile: "tagged",
  complete: true,
} as PdfExportReport;

function baseDeps(
  states: ExportJobSnapshotV1[],
): RunSubmittedExtensionPdfExportDepsV1 {
  let index = 0;
  return {
    submit: async () => ({
      request: {} as never,
      snapshot: states[0]!,
    }),
    catalog: {
      get: async () => states[Math.min(index++, states.length - 1)],
      compareAndSet: async () => {
        throw new Error("Unexpected transition.");
      },
      deliver: async () => states.at(-1)!,
    },
    bytes: {
      read: async function* () {
        yield Uint8Array.from([37, 80]);
        yield Uint8Array.from([68, 70]);
      },
    },
    readReport: async () => report,
    emit: async () => {},
    sleep: async () => {},
  };
}

describe("sidepanel durable PDF observer", () => {
  it("projects durable stages, downloads retained bytes, and marks delivery", async () => {
    const phases: string[] = [];
    const progress: unknown[] = [];
    const emitted: Uint8Array[] = [];
    const delivered: Array<[string, number]> = [];
    const states = [
      snapshot(0, "queued"),
      snapshot(1, "running", {
        stage: "fetch",
        progress: {
          stage: "fetch",
          done: 2,
          total: 3,
          detail: "Chapter two",
          updatedAt: 2,
        },
      }),
      snapshot(2, "running", { stage: "render" }),
      snapshot(3, "succeeded", {
        stage: "commit",
        finishedAt: 3,
        artifact: {
          ref: "artifact:pdf-run:1",
          mediaType: "application/pdf",
          filename: "Guide.pdf",
          byteLength: 4,
          sha256: "a".repeat(64),
          committedAt: 3,
        },
        reportRef: "report:pdf-run",
        reportSummary: {
          issues: { info: 0, warning: 0, error: 0 },
          topCodes: [],
          completeness: "complete",
        },
      }),
    ];
    const deps = baseDeps(states);
    deps.catalog.deliver = async (id, revision) => {
      delivered.push([id, revision]);
      return states.at(-1)!;
    };
    deps.emit = async ({ bytes }) => { emitted.push(bytes); };
    const observed = request();
    observed.onPhase = (phase) => phases.push(phase);
    observed.onProgress = (value) => progress.push(value);

    expect(await runSubmittedExtensionPdfExport(observed, deps)).toBe(report);
    expect(phases).toEqual(["queued", "fetching", "compiling", "downloading"]);
    expect(progress).toEqual([{
      fetched: 2,
      total: 3,
      currentTitle: "Chapter two",
    }]);
    expect(emitted.map((value) => [...value])).toEqual([[37, 80, 68, 70]]);
    expect(delivered).toEqual([["pdf-run", 3]]);
  });

  it("turns explicit observer abort into durable cancellation", async () => {
    const controller = new AbortController();
    const running = snapshot(1, "running", { stage: "fetch" });
    const transitions: string[] = [];
    const deps = baseDeps([running]);
    deps.sleep = async () => {
      controller.abort(new DOMException("User cancelled.", "AbortError"));
    };
    deps.catalog.compareAndSet = async (update) => {
      transitions.push(update.kind === "transition" ? update.to : update.kind);
      return snapshot(2, "cancelling");
    };

    await expect(
      runSubmittedExtensionPdfExport(request(controller.signal), deps),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(transitions).toEqual(["cancelling"]);
  });

  it("surfaces the durable executor failure and never emits", async () => {
    const failed = snapshot(2, "failed", {
      stage: "render",
      finishedAt: 2,
      error: {
        code: "pdf.compile",
        message: "Typst worker failed",
        category: "render",
        retryable: true,
        stage: "render",
        occurredAt: 2,
      },
    });
    let emitted = false;
    const deps = baseDeps([failed]);
    deps.emit = async () => { emitted = true; };
    await expect(runSubmittedExtensionPdfExport(request(), deps))
      .rejects.toThrow("Typst worker failed");
    expect(emitted).toBe(false);
  });
});
