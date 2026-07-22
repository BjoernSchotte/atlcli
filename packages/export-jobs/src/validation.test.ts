import { describe, expect, it } from "bun:test";
import type { ExportJobEventV1 } from "./event.js";
import type {
  DocxExportJobRequestV1,
  ExportJobRequestV1,
  PdfExportJobRequestV1,
} from "./request.js";
import type { ExportJobSnapshotV1, ExportJobState } from "./snapshot.js";
import {
  ExportJobValidationError,
  parseExportJobEventV1,
  parseExportJobRequestV1,
  parseExportJobSnapshotV1,
} from "./validation.js";

const HASH = "a".repeat(64);

function pdfRequest(): PdfExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id: "job-1",
    idempotencyKey: "action-1",
    format: "pdf",
    renderer: "pdf-typst",
    source: {
      kind: "confluence",
      siteOrigin: "https://example.atlassian.net",
      locator: { kind: "space-key", spaceKey: "DOCS" },
      scope: { kind: "space" },
      maxPages: 500,
    },
    authRef: "session:default",
    displayName: "Documentation",
    requestedFilename: "docs.pdf",
    createdAt: 100,
    priority: "interactive",
    output: { policy: "collect" },
    template: { id: "default", manifestVersion: "1" },
    settings: {
      page: "a4",
      watermark: { text: "DRAFT", opacity: 0.08 },
      logo: {
        assetRef: "asset:logo:v1",
        sha256: HASH,
        byteLength: 42,
        mediaType: "image/png",
        alt: "Acme",
      },
      custom: { copies: 1, tagged: true, optional: null },
    },
    options: { resolveMacros: true },
  };
}

function docxRequest(): DocxExportJobRequestV1 {
  const { settings: _settings, ...base } = pdfRequest();
  return {
    ...base,
    format: "docx",
    renderer: "docx-typescript",
    requestedFilename: "docs.docx",
    template: { recordKey: "default", sha256: HASH, name: "Default" },
    options: { embedImages: true, resolveMacros: true, updateFields: "auto" },
  };
}

function stats(): ExportJobSnapshotV1["stats"] {
  return {
    pages: { discovered: 1, fetched: 1, composed: 1, skipped: 0 },
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
    metricSupport: {
      "storage.spoolPeakBytes": "unavailable",
      "memory.heapPeakBytes": "unavailable",
    },
    durationsMs: { queue: 5, fetch: 10 },
    warnings: 0,
    errors: 0,
  };
}

function snapshot(state: ExportJobState = "queued"): ExportJobSnapshotV1 {
  const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(state);
  const claimed = ["running", "waiting", "cancelling", "succeeded", "failed", "interrupted"].includes(state);
  return {
    schema: "atlcli.export-job/1",
    id: "job-1",
    revision: 0,
    requestRef: "requests/job-1",
    format: "pdf",
    renderer: "pdf-typst",
    summary: {
      displayName: "Documentation",
      sourceLabel: "DOCS",
      siteOrigin: "https://example.atlassian.net",
      scopeKind: "space",
    },
    queue: { priority: "interactive", enqueuedAt: 100, groupKey: "example.atlassian.net" },
    state,
    stage: state === "queued" ? undefined : "fetch",
    progress:
      state === "queued" ? undefined : { stage: "fetch", done: 1, total: 2, updatedAt: 110 },
    waiting: state === "waiting" ? { reason: "backoff", until: 200 } : undefined,
    attempt: claimed ? 1 : 0,
    recoveryCount: 0,
    leaseEpoch: claimed ? 1 : 0,
    lease:
      state === "running" || state === "cancelling"
        ? { ownerId: "worker-1", epoch: 1, acquiredAt: 101, heartbeatAt: 102, expiresAt: 200 }
        : undefined,
    cancelRequestedAt: state === "cancelled" || state === "cancelling" ? 115 : undefined,
    checkpointRef: state === "waiting" ? "checkpoint:waiting" : undefined,
    artifact:
      state === "succeeded"
        ? {
            ref: "artifacts/job-1",
            mediaType: "application/pdf",
            filename: "docs.pdf",
            byteLength: 42,
            sha256: HASH,
            committedAt: 120,
          }
        : undefined,
    stats: stats(),
    error:
      state === "failed" || state === "interrupted"
        ? {
            code: "render-failed",
            message: "Render failed",
            category: "render",
            retryable: false,
            stage: "render",
            occurredAt: 120,
          }
        : undefined,
    createdAt: 100,
    startedAt: claimed ? 101 : undefined,
    finishedAt: terminal ? 120 : undefined,
  };
}

function changed<T>(value: T, mutate: (copy: any) => void): unknown {
  const copy = structuredClone(value);
  mutate(copy);
  return copy;
}

describe("parseExportJobRequestV1", () => {
  it("accepts the closed PDF and TypeScript-DOCX request contracts", () => {
    expect(parseExportJobRequestV1(pdfRequest())).toEqual(pdfRequest());
    expect(parseExportJobRequestV1(docxRequest())).toEqual(docxRequest());
  });

  it.each([
    ["schema", (request: any) => (request.schema = "atlcli.export-job-request/2")],
    ["renderer", (request: any) => (request.renderer = "docx-typescript")],
    ["origin protocol", (request: any) => (request.source.siteOrigin = "file:///tmp/source")],
    ["origin path", (request: any) => (request.source.siteOrigin = "https://example.com/wiki")],
    ["locator", (request: any) => (request.source.locator.spaceKey = "")],
    ["scope", (request: any) => (request.source.scope = { kind: "tree" })],
    ["resolved ID in scope", (request: any) => (request.source.scope.spaceKey = "DOCS")],
    ["maxPages", (request: any) => (request.source.maxPages = 0)],
    ["filename", (request: any) => (request.requestedFilename = "")],
    ["settings NaN", (request: any) => (request.settings.custom.copies = Number.NaN)],
    ["settings object", (request: any) => (request.settings.custom.nested = { unsafe: true })],
    ["watermark range", (request: any) => (request.settings.watermark.opacity = 0)],
    ["logo hash", (request: any) => (request.settings.logo.sha256 = "bad")],
  ])("rejects invalid %s", (_name, mutate) => {
    expect(() => parseExportJobRequestV1(changed(pdfRequest(), mutate))).toThrow(
      ExportJobValidationError,
    );
  });

  it("treats authRef as an opaque non-empty reference", () => {
    const request = pdfRequest();
    request.authRef = "opaque://host-owned/value";
    expect(parseExportJobRequestV1(request).authRef).toBe(request.authRef);
    expect(() =>
      parseExportJobRequestV1(changed(request, (copy) => (copy.authRef = "  "))),
    ).toThrow("request.authRef");
  });
});

describe("parseExportJobSnapshotV1", () => {
  it.each(["queued", "running", "waiting", "cancelling", "succeeded", "failed", "cancelled", "interrupted"] as const)(
    "accepts a valid %s snapshot",
    (state) => expect(parseExportJobSnapshotV1(snapshot(state)).state).toBe(state),
  );

  it("requires running jobs to carry the current lease epoch", () => {
    expect(() =>
      parseExportJobSnapshotV1(changed(snapshot("running"), (copy) => delete copy.lease)),
    ).toThrow("running jobs require an active lease");
    expect(() =>
      parseExportJobSnapshotV1(changed(snapshot("running"), (copy) => (copy.lease.epoch = 2))),
    ).toThrow("must equal snapshot.leaseEpoch");
  });

  it("rejects a waiting job that retained an active lease", () => {
    expect(() =>
      parseExportJobSnapshotV1(
        changed(snapshot("waiting"), (copy) => {
          copy.leaseEpoch = 1;
          copy.lease = {
            ownerId: "worker",
            epoch: 1,
            acquiredAt: 101,
            heartbeatAt: 102,
            expiresAt: 200,
          };
        }),
      ),
    ).toThrow("waiting jobs must not retain a lease");
  });

  it("rejects a queued job that carries an active lease", () => {
    expect(() =>
      parseExportJobSnapshotV1(
        changed(snapshot("queued"), (copy) => {
          copy.attempt = 1;
          copy.leaseEpoch = 1;
          copy.startedAt = 101;
          copy.lease = {
            ownerId: "worker",
            epoch: 1,
            acquiredAt: 101,
            heartbeatAt: 102,
            expiresAt: 200,
          };
        }),
      ),
    ).toThrow("only valid for running or cancelling jobs");
  });

  it("rejects unknown persisted fields at request and snapshot boundaries", () => {
    expect(() =>
      parseExportJobRequestV1(changed(pdfRequest(), (copy) => (copy.accessToken = "secret"))),
    ).toThrow("request.accessToken");
    expect(() =>
      parseExportJobSnapshotV1(changed(snapshot(), (copy) => (copy.unknown = true))),
    ).toThrow("snapshot.unknown");
  });

  it("rejects non-plain record values", () => {
    expect(() =>
      parseExportJobRequestV1(changed(pdfRequest(), (copy) => (copy.settings = new Date()))),
    ).toThrow("plain data object");
    expect(() =>
      parseExportJobRequestV1(changed(pdfRequest(), (copy) => (copy.settings.custom = new Map()))),
    ).toThrow("plain data object");
  });

  it("rejects unreachable claim and waiting snapshots", () => {
    expect(() =>
      parseExportJobSnapshotV1(
        changed(snapshot("running"), (copy) => {
          copy.attempt = 0;
          copy.leaseEpoch = 0;
          copy.lease.epoch = 0;
          delete copy.startedAt;
        }),
      ),
    ).toThrow(ExportJobValidationError);
    expect(() =>
      parseExportJobSnapshotV1(
        changed(snapshot("waiting"), (copy) => delete copy.checkpointRef),
      ),
    ).toThrow("checkpointRef");
  });

  it.each([
    ["succeeded artifact", snapshot("succeeded"), (copy: any) => delete copy.artifact],
    ["failed error", snapshot("failed"), (copy: any) => delete copy.error],
    ["interrupted error", snapshot("interrupted"), (copy: any) => delete copy.error],
    ["cancelled request", snapshot("cancelled"), (copy: any) => delete copy.cancelRequestedAt],
    ["terminal finish", snapshot("succeeded"), (copy: any) => delete copy.finishedAt],
  ])("rejects a terminal snapshot without %s", (_name, input, mutate) => {
    expect(() => parseExportJobSnapshotV1(changed(input, mutate))).toThrow(
      ExportJobValidationError,
    );
  });

  it("enforces terminal presentation and artifact timestamp ordering", () => {
    expect(() =>
      parseExportJobSnapshotV1(
        changed(snapshot("succeeded"), (copy) => (copy.artifact.committedAt = 119)),
      ),
    ).toThrow("snapshot.artifact.committedAt");
    expect(() =>
      parseExportJobSnapshotV1(
        changed(snapshot("succeeded"), (copy) => (copy.acknowledgedAt = 119)),
      ),
    ).toThrow("snapshot.acknowledgedAt");
  });

  it.each([
    ["renderer", (copy: any) => (copy.renderer = "docx-typescript")],
    ["request ref", (copy: any) => (copy.requestRef = "")],
    ["negative counter", (copy: any) => (copy.stats.pages.fetched = -1)],
    ["progress total", (copy: any) => (copy.progress.done = 3)],
    ["artifact hash", (copy: any) => (copy.artifact.sha256 = "not-a-hash")],
  ])("rejects invalid %s", (_name, mutate) => {
    expect(() => parseExportJobSnapshotV1(changed(snapshot("succeeded"), mutate))).toThrow(
      ExportJobValidationError,
    );
  });
});

function eventFixtures(): ExportJobEventV1[] {
  return [
    { kind: "state", seq: 1, at: 100, from: "queued", to: "running" },
    { kind: "stage", seq: 2, at: 101, stage: "fetch" },
    {
      kind: "progress",
      seq: 3,
      at: 102,
      progress: { stage: "fetch", done: 1, total: 2, detail: "Page 1", updatedAt: 102 },
    },
    { kind: "retry", seq: 4, at: 103, code: "rate-limited", nextAttemptAt: 200 },
    {
      kind: "issue",
      seq: 5,
      at: 104,
      level: "warning",
      code: "asset-unavailable",
      source: { pageId: "123", pageTitle: "Overview", blockId: "b1", assetRef: "asset:1" },
    },
    { kind: "recovery", seq: 6, at: 105, fromCheckpoint: "checkpoints/job-1", leaseEpoch: 2 },
    {
      kind: "artifact",
      seq: 7,
      at: 106,
      artifact: {
        ref: "artifacts/job-1",
        mediaType: "application/pdf",
        filename: "docs.pdf",
        byteLength: 42,
        sha256: HASH,
        committedAt: 106,
      },
    },
  ];
}

describe("parseExportJobEventV1", () => {
  it("accepts every closed event shape", () => {
    for (const event of eventFixtures()) {
      expect(parseExportJobEventV1(event)).toEqual(event);
    }
  });

  it("accepts a complete DOCX artifact event", () => {
    const event: ExportJobEventV1 = {
      kind: "artifact",
      seq: 1,
      at: 100,
      artifact: {
        ref: "artifacts/job-1",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "docs.docx",
        byteLength: 42,
        sha256: HASH,
        committedAt: 100,
      },
    };
    expect(parseExportJobEventV1(event)).toEqual(event);
  });

  it.each([
    ["sequence below one", (event: any) => (event.seq = 0)],
    ["unsafe sequence", (event: any) => (event.seq = Number.MAX_SAFE_INTEGER + 1)],
    ["unsafe event time", (event: any) => (event.at = Number.POSITIVE_INFINITY)],
    ["unknown state", (event: any) => (event.to = "paused")],
  ])("rejects %s", (_name, mutate) => {
    const event = eventFixtures()[0]!;
    expect(() => parseExportJobEventV1(changed(event, mutate))).toThrow(ExportJobValidationError);
  });

  it("rejects unknown stages in stage and progress events", () => {
    expect(() =>
      parseExportJobEventV1(changed(eventFixtures()[1]!, (copy) => (copy.stage = "download"))),
    ).toThrow("event.stage");
    expect(() =>
      parseExportJobEventV1(
        changed(eventFixtures()[2]!, (copy) => (copy.progress.stage = "download")),
      ),
    ).toThrow("event.progress.stage");
  });

  it("enforces retry code and timestamp bounds", () => {
    const event = eventFixtures()[3]!;
    expect(() =>
      parseExportJobEventV1(changed(event, (copy) => (copy.code = " "))),
    ).toThrow("event.code");
    expect(() =>
      parseExportJobEventV1(changed(event, (copy) => (copy.code = "x".repeat(257)))),
    ).toThrow("event.code");
    expect(() =>
      parseExportJobEventV1(changed(event, (copy) => (copy.nextAttemptAt = copy.at - 1))),
    ).toThrow("event.nextAttemptAt");
  });

  it("keeps issue level and source closed and redacted", () => {
    const event = eventFixtures()[4]!;
    expect(() =>
      parseExportJobEventV1(changed(event, (copy) => (copy.level = "debug"))),
    ).toThrow("event.level");
    expect(() =>
      parseExportJobEventV1(changed(event, (copy) => (copy.source.accessToken = "secret"))),
    ).toThrow("event.source.accessToken");
    expect(() =>
      parseExportJobEventV1(changed(event, (copy) => (copy.source.pageId = " "))),
    ).toThrow("event.source.pageId");
  });

  it("requires recovery epochs to start at one", () => {
    const event = eventFixtures()[5]!;
    expect(() =>
      parseExportJobEventV1(changed(event, (copy) => (copy.leaseEpoch = 0))),
    ).toThrow("event.leaseEpoch");
  });

  it.each([
    ["unknown media type", (event: any) => (event.artifact.mediaType = "application/octet-stream")],
    ["empty reference", (event: any) => (event.artifact.ref = "")],
    ["empty filename", (event: any) => (event.artifact.filename = "")],
    ["zero bytes", (event: any) => (event.artifact.byteLength = 0)],
    ["invalid hash", (event: any) => (event.artifact.sha256 = "not-a-hash")],
    ["unsafe timestamp", (event: any) => (event.artifact.committedAt = Number.POSITIVE_INFINITY)],
    ["secret field", (event: any) => (event.artifact.signedUrl = "https://secret.example")],
  ])("rejects artifact events with %s", (_name, mutate) => {
    const event = eventFixtures()[6]!;
    expect(() => parseExportJobEventV1(changed(event, mutate))).toThrow(ExportJobValidationError);
  });

  it("rejects unknown top-level fields for every event kind", () => {
    for (const event of eventFixtures()) {
      expect(() =>
        parseExportJobEventV1(changed(event, (copy) => (copy.cookie = "secret"))),
      ).toThrow("event.cookie");
    }
  });
});
