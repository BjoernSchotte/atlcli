import { describe, expect, it } from "bun:test";
import type { ExportJobRequestV1 } from "./request.js";
import {
  ExportJobReplayConflict,
  deriveExportJobReplayV1,
  type ExportJobReplayRelationV1,
} from "./replay.js";
import type { ExportJobSnapshotV1, ExportJobState } from "./snapshot.js";

const request: ExportJobRequestV1 = {
  schema: "atlcli.export-job-request/1",
  id: "origin",
  idempotencyKey: "origin-action",
  format: "pdf",
  renderer: "pdf-typst",
  source: {
    kind: "confluence",
    siteOrigin: "https://example.atlassian.net",
    locator: { kind: "space-key", spaceKey: "DOCS" },
    scope: { kind: "space" },
    maxPages: 500,
    maxFolders: 200,
  },
  authRef: "session:default",
  displayName: "Documentation",
  requestedFilename: "docs.pdf",
  createdAt: 10,
  priority: "interactive",
  output: { policy: "path", targetRef: "/exports/docs.pdf", overwriteExisting: true },
  template: { id: "default", manifestVersion: "1" },
  settings: { page: "a4" },
  options: {
    resolveMacros: true,
    strict: true,
    noCache: true,
    exportedAt: 1_753_161_600_000,
  },
};

function snapshot(
  id: string,
  state: ExportJobState,
  derivedFrom?: ExportJobSnapshotV1["derivedFrom"],
): ExportJobSnapshotV1 {
  return {
    schema: "atlcli.export-job/1",
    id,
    revision: 7,
    requestRef: `requests/${id}`,
    format: "pdf",
    renderer: "pdf-typst",
    summary: {
      displayName: "Documentation",
      sourceLabel: "DOCS",
      siteOrigin: "https://example.atlassian.net",
      scopeKind: "space",
    },
    queue: { priority: "interactive", enqueuedAt: 10, groupKey: "example" },
    state,
    stage: "commit",
    progress: { stage: "commit", done: 1, total: 1, updatedAt: 20 },
    attempt: 3,
    recoveryCount: 2,
    leaseEpoch: 3,
    artifact:
      state === "succeeded"
        ? {
            ref: `artifacts/${id}`,
            mediaType: "application/pdf",
            filename: "docs.pdf",
            byteLength: 42,
            sha256: "abc",
            committedAt: 20,
          }
        : undefined,
    reportRef: `reports/${id}`,
    stats: {
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
      storage: { spoolBytes: 0, spoolPeakBytes: 0, outputBytes: 42 },
      memory: { heapPeakBytes: null, rendererPeakBytes: null },
      metricSupport: {},
      durationsMs: {},
      warnings: 0,
      errors: state === "failed" ? 1 : 0,
    },
    createdAt: 10,
    startedAt: 11,
    finishedAt: 20,
    deliveredAt: state === "succeeded" ? 21 : undefined,
    acknowledgedAt: 22,
    dismissedAt: 23,
    derivedFrom,
  };
}

function derive(state: ExportJobState, relation: ExportJobReplayRelationV1) {
  return deriveExportJobReplayV1({
    origin: snapshot("origin", state),
    originRequest: request,
    input: {
      relation,
      actionKey: "action-2",
      newJobId: "next",
      newIdempotencyKey: "idem-next",
      createdAt: 100,
    },
    existingDerived: [],
    existingDerivedRequests: [],
  });
}

describe("deriveExportJobReplayV1", () => {
  it.each(["failed", "interrupted", "cancelled"] as const)(
    "allows Retry from %s with fresh identity and retry priority",
    (state) => {
      const result = derive(state, "retry");
      expect(result).toEqual({
        kind: "create",
        request: {
          ...request,
          id: "next",
          idempotencyKey: "idem-next",
          createdAt: 100,
          priority: "retry",
        },
        derivedFrom: { jobId: "origin", relation: "retry", actionKey: "action-2" },
      });
    },
  );

  it("allows Run again only from succeeded and gives it interactive priority", () => {
    const result = derive("succeeded", "rerun");
    expect(result.kind).toBe("create");
    if (result.kind !== "create") throw new Error("expected a derived request");

    expect(result.request.priority).toBe("interactive");
    expect(result.derivedFrom).toEqual({
      jobId: "origin",
      relation: "rerun",
      actionKey: "action-2",
    });
    expect(result.request).toMatchObject({
      source: { maxPages: 500, maxFolders: 200 },
      output: {
        policy: "path",
        targetRef: "/exports/docs.pdf",
        overwriteExisting: true,
      },
      options: {
        strict: true,
        noCache: true,
        exportedAt: 1_753_161_600_000,
      },
    });
  });

  it("copies DOCX render and report policy unchanged into a Retry", () => {
    if (request.format !== "pdf") throw new Error("expected the PDF replay fixture");
    const { settings: _settings, options: _pdfOptions, ...requestBase } = request;
    const docxRequest: ExportJobRequestV1 = {
      ...requestBase,
      format: "docx",
      renderer: "docx-typescript",
      requestedFilename: "docs.docx",
      template: { recordKey: "template:default", sha256: "a".repeat(64), name: "Default" },
      options: {
        embedImages: true,
        resolveMacros: false,
        keepIgnored: true,
        strict: true,
        updateFields: "never",
      },
    };
    const origin = {
      ...snapshot("origin", "failed"),
      format: "docx" as const,
      renderer: "docx-typescript" as const,
    };

    const result = deriveExportJobReplayV1({
      origin,
      originRequest: docxRequest,
      input: {
        relation: "retry",
        actionKey: "docx-retry",
        newJobId: "docx-next",
        newIdempotencyKey: "docx-idem-next",
        createdAt: 101,
      },
      existingDerived: [],
      existingDerivedRequests: [],
    });

    expect(result.kind).toBe("create");
    if (result.kind !== "create") throw new Error("expected a derived request");
    expect(result.request).toMatchObject({
      format: "docx",
      source: { maxFolders: 200 },
      output: { overwriteExisting: true },
      options: {
        embedImages: true,
        resolveMacros: false,
        keepIgnored: true,
        strict: true,
        updateFields: "never",
      },
    });
  });

  it.each([
    ["queued", "retry"],
    ["running", "retry"],
    ["waiting", "retry"],
    ["cancelling", "retry"],
    ["succeeded", "retry"],
    ["queued", "rerun"],
    ["running", "rerun"],
    ["waiting", "rerun"],
    ["cancelling", "rerun"],
    ["failed", "rerun"],
    ["interrupted", "rerun"],
    ["cancelled", "rerun"],
  ] as const)("rejects %s -> %s", (state, relation) => {
    expect(derive(state, relation)).toEqual({
      kind: "not-allowed",
      relation,
      originState: state,
    });
  });

  it("returns an existing direct derivation for the same action key", () => {
    const existing = snapshot("already-created", "queued", {
      jobId: "origin",
      relation: "retry",
      actionKey: "action-2",
    });
    const result = deriveExportJobReplayV1({
      origin: snapshot("origin", "failed"),
      originRequest: request,
      input: {
        relation: "retry",
        actionKey: "action-2",
        newJobId: "must-not-be-used",
        newIdempotencyKey: "must-not-be-used",
        createdAt: 999,
      },
      existingDerived: [
        snapshot("other", "queued", {
          jobId: "origin",
          relation: "retry",
          actionKey: "other-action",
        }),
        existing,
      ],
      existingDerivedRequests: [
        {
          ...request,
          id: "already-created",
          idempotencyKey: "bound-idempotency-key",
          createdAt: 500,
          priority: "retry",
        },
      ],
    });

    expect(result).toEqual({ kind: "existing", snapshot: existing });
  });

  it("allows an output-only override while pinning source, render, and report policy", () => {
    const result = deriveExportJobReplayV1({
      origin: snapshot("origin", "succeeded"),
      originRequest: request,
      input: {
        relation: "rerun",
        actionKey: "different-destination",
        newJobId: "output-override",
        newIdempotencyKey: "idem-output-override",
        createdAt: 600,
        outputOverride: {
          policy: "path",
          targetRef: "/exports/archive/docs.pdf",
          overwriteExisting: false,
        },
      },
      existingDerived: [],
      existingDerivedRequests: [],
    });

    expect(result.kind).toBe("create");
    if (result.kind !== "create") throw new Error("expected a derived request");
    expect(result.request.output).toEqual({
      policy: "path",
      targetRef: "/exports/archive/docs.pdf",
      overwriteExisting: false,
    });
    expect(result.request.source).toEqual(request.source);
    expect(result.request.template).toEqual(request.template);
    expect(result.request.options).toEqual(request.options);
    if (result.request.format !== "pdf" || request.format !== "pdf") {
      throw new Error("expected PDF requests");
    }
    expect(result.request.settings).toEqual(request.settings);
  });

  it("deduplicates an identical output override for an already-bound action key", () => {
    const existing = snapshot("already-created", "queued", {
      jobId: "origin",
      relation: "retry",
      actionKey: "retry-to-archive",
    });
    const outputOverride = {
      policy: "path" as const,
      targetRef: "/exports/archive/docs.pdf",
      overwriteExisting: false,
    };
    const existingRequest: ExportJobRequestV1 = {
      ...request,
      id: existing.id,
      idempotencyKey: "bound-idempotency-key",
      createdAt: 500,
      priority: "retry",
      output: outputOverride,
    };
    const result = deriveExportJobReplayV1({
      origin: snapshot("origin", "failed"),
      originRequest: request,
      input: {
        relation: "retry",
        actionKey: "retry-to-archive",
        newJobId: "new-identity-is-ignored",
        newIdempotencyKey: "new-idempotency-key-is-ignored",
        createdAt: 700,
        outputOverride,
      },
      existingDerived: [existing],
      existingDerivedRequests: [existingRequest],
    });

    expect(result).toEqual({ kind: "existing", snapshot: existing });
  });

  it("fails closed when the same action key is reused with another output override", () => {
    const existing = snapshot("already-created", "queued", {
      jobId: "origin",
      relation: "retry",
      actionKey: "retry-to-archive",
    });
    const attempt = () =>
      deriveExportJobReplayV1({
        origin: snapshot("origin", "failed"),
        originRequest: request,
        input: {
          relation: "retry",
          actionKey: "retry-to-archive",
          newJobId: "new-identity-is-ignored",
          newIdempotencyKey: "new-idempotency-key-is-ignored",
          createdAt: 700,
          outputOverride: { policy: "path", targetRef: "/exports/two.pdf" },
        },
        existingDerived: [existing],
        existingDerivedRequests: [
          {
            ...request,
            id: existing.id,
            idempotencyKey: "bound-idempotency-key",
            createdAt: 500,
            priority: "retry",
            output: { policy: "path", targetRef: "/exports/one.pdf" },
          },
        ],
      });

    expect(attempt).toThrow(ExportJobReplayConflict);
    expect(attempt).toThrow(expect.objectContaining({ code: "action-payload-conflict" }));
  });

  it("fails closed when an existing derivation has no request to verify", () => {
    const existing = snapshot("already-created", "queued", {
      jobId: "origin",
      relation: "retry",
      actionKey: "retry-missing-request",
    });
    const attempt = () =>
      deriveExportJobReplayV1({
        origin: snapshot("origin", "failed"),
        originRequest: request,
        input: {
          relation: "retry",
          actionKey: "retry-missing-request",
          newJobId: "new-identity-is-ignored",
          newIdempotencyKey: "new-idempotency-key-is-ignored",
          createdAt: 700,
        },
        existingDerived: [existing],
        existingDerivedRequests: [],
      });

    expect(attempt).toThrow(expect.objectContaining({ code: "candidate-request-missing" }));
  });

  it("rejects unknown or malformed output override fields", () => {
    const attempt = () =>
      deriveExportJobReplayV1({
        origin: snapshot("origin", "failed"),
        originRequest: request,
        input: {
          relation: "retry",
          actionKey: "malformed-output",
          newJobId: "malformed-output",
          newIdempotencyKey: "idem-malformed-output",
          createdAt: 700,
          outputOverride: {
            policy: "path",
            targetRef: "/exports/docs.pdf",
            secret: "must-not-survive",
          } as never,
        },
        existingDerived: [],
        existingDerivedRequests: [],
      });

    expect(attempt).toThrow("request.output.secret");
  });

  it("returns no terminal runtime fields in a create derivation", () => {
    const result = derive("succeeded", "rerun");
    expect(result.kind).toBe("create");
    if (result.kind !== "create") throw new Error("expected a derived request");

    expect(Object.keys(result).sort()).toEqual(["derivedFrom", "kind", "request"]);
    expect(result.request).not.toHaveProperty("state");
    expect(result.request).not.toHaveProperty("artifact");
    expect(result.request).not.toHaveProperty("reportRef");
    expect(result.request).not.toHaveProperty("attempt");
  });
});
