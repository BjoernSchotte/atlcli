import { describe, expect, it } from "bun:test";
import type { ExportJobSnapshotV1 } from "./snapshot.js";
import {
  COMPACT_HISTORY_MAX_JOBS_V1,
  COMPACT_HISTORY_RETENTION_MS_V1,
  DELIVERED_ARTIFACT_RETENTION_MS_V1,
  FULL_REPORT_RETENTION_MS_V1,
  planExportJobLifecycleRetentionV1,
} from "./lifecycle-retention.js";

const DAY = 24 * 60 * 60 * 1_000;

function succeeded(
  id: string,
  values: Partial<ExportJobSnapshotV1> = {},
): ExportJobSnapshotV1 {
  const createdAt = values.createdAt ?? DAY;
  const finishedAt = values.finishedAt ?? createdAt + 1;
  return {
    schema: "atlcli.export-job/1",
    id,
    revision: values.revision ?? 4,
    requestRef: `request:${id}`,
    format: "pdf",
    renderer: "pdf-typst",
    summary: {
      displayName: id,
      sourceLabel: id,
      siteOrigin: "https://example.atlassian.net",
      scopeKind: "page",
    },
    queue: {
      priority: "interactive",
      enqueuedAt: createdAt,
      groupKey: "https://example.atlassian.net",
    },
    state: "succeeded",
    stage: "commit",
    attempt: 1,
    recoveryCount: 0,
    leaseEpoch: 1,
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
      storage: { spoolBytes: 0, spoolPeakBytes: null, outputBytes: 3 },
      memory: { heapPeakBytes: null, rendererPeakBytes: null },
      metricSupport: {},
      durationsMs: {},
      warnings: 0,
      errors: 0,
    },
    createdAt,
    startedAt: createdAt,
    finishedAt,
    deliveredAt: values.deliveredAt,
    dismissedAt: values.dismissedAt,
    artifact: values.artifactReleasedAt === undefined
      ? {
          ref: `artifact:${id}`,
          mediaType: "application/pdf",
          filename: `${id}.pdf`,
          byteLength: 3,
          sha256: "a".repeat(64),
          committedAt: finishedAt,
        }
      : undefined,
    artifactReleasedAt: values.artifactReleasedAt,
    reportRef: values.reportReleasedAt === undefined ? `report:${id}` : undefined,
    reportReleasedAt: values.reportReleasedAt,
    reportSummary: {
      issues: { info: 0, warning: 0, error: 0 },
      topCodes: [],
      completeness: "complete",
    },
  };
}

describe("planExportJobLifecycleRetentionV1", () => {
  it("uses the last delivery/dismissal and the exact 24h and 7d boundaries", () => {
    const now = 20 * DAY;
    const boundary = succeeded("boundary", {
      createdAt: DAY,
      finishedAt: 2 * DAY,
      deliveredAt: now - DELIVERED_ARTIFACT_RETENTION_MS_V1 - 1,
      dismissedAt: now - DELIVERED_ARTIFACT_RETENTION_MS_V1,
    });
    const inGrace = succeeded("in-grace", {
      createdAt: DAY + 1,
      finishedAt: 2 * DAY,
      deliveredAt: now - DELIVERED_ARTIFACT_RETENTION_MS_V1 + 1,
    });

    expect(planExportJobLifecycleRetentionV1([boundary, inGrace], now).releases)
      .toEqual([
        {
          id: "in-grace",
          expectedRevision: 4,
          releaseArtifact: false,
          releaseReport: true,
        },
        {
          id: "boundary",
          expectedRevision: 4,
          releaseArtifact: true,
          releaseReport: true,
        },
      ]);
  });

  it("protects succeeded-undelivered bytes regardless of age or count", () => {
    const now = 100 * DAY;
    const retained = Array.from(
      { length: COMPACT_HISTORY_MAX_JOBS_V1 + 1 },
      (_, index) =>
        succeeded(`job-${String(index).padStart(3, "0")}`, {
          createdAt: index + 1,
          finishedAt: index + 2,
          deliveredAt: index === 0 ? undefined : DAY,
          ...(index === 0
            ? {}
            : {
                artifactReleasedAt: 10 * DAY,
                reportReleasedAt: 10 * DAY,
              }),
        }),
    );
    const plan = planExportJobLifecycleRetentionV1(retained, now);
    expect(plan.deleteJobIds).not.toContain("job-000");
    expect(plan.releases).toContainEqual({
      id: "job-000",
      expectedRevision: 4,
      releaseArtifact: false,
      releaseReport: true,
    });
  });

  it("keeps only the intersection of the newest 100 and younger-than-30d history", () => {
    const now = 60 * DAY;
    const rows = Array.from(
      { length: COMPACT_HISTORY_MAX_JOBS_V1 + 5 },
      (_, index) =>
        succeeded(`job-${String(index).padStart(3, "0")}`, {
          createdAt: now - 10 * DAY - index,
          finishedAt: now - 9 * DAY - index,
          deliveredAt: now - 8 * DAY,
          artifactReleasedAt: now - 7 * DAY,
          reportReleasedAt: now - 2 * DAY,
        }),
    );
    rows.push(succeeded("old", {
      createdAt: now - COMPACT_HISTORY_RETENTION_MS_V1,
      finishedAt: now - COMPACT_HISTORY_RETENTION_MS_V1 + 1,
      deliveredAt: now - 20 * DAY,
      artifactReleasedAt: now - 19 * DAY,
      reportReleasedAt: now - 18 * DAY,
    }));

    const plan = planExportJobLifecycleRetentionV1(rows, now);
    expect(plan.deleteJobIds).toContain("old");
    expect(plan.deleteJobIds).toHaveLength(6);
  });

  it("does not delete compact history before the independent report/event horizon", () => {
    const now = FULL_REPORT_RETENTION_MS_V1 - 1;
    const row = succeeded("young", {
      createdAt: 0,
      finishedAt: 0,
      deliveredAt: now,
    });
    const plan = planExportJobLifecycleRetentionV1([row], now);
    expect(plan.releases).toEqual([]);
    expect(plan.deleteJobIds).toEqual([]);
  });
});
