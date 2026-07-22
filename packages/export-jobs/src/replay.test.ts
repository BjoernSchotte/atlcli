import { describe, expect, it } from "bun:test";
import type { ExportJobRequestV1 } from "./request.js";
import { deriveExportJobReplayV1, type ExportJobReplayRelationV1 } from "./replay.js";
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
  },
  authRef: "session:default",
  displayName: "Documentation",
  requestedFilename: "docs.pdf",
  createdAt: 10,
  priority: "interactive",
  output: { policy: "collect" },
  template: { id: "default", manifestVersion: "1" },
  settings: { page: "a4" },
  options: { resolveMacros: true },
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
    });

    expect(result).toEqual({ kind: "existing", snapshot: existing });
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
