import { describe, expect, it } from "bun:test";
import { createEmptyExportJobStatsV1 } from "./statistics.js";
import type {
  ExportJobSnapshotV1,
  ExportJobState,
} from "./snapshot.js";
import {
  projectExportActivityRowV1,
  projectExportActivityV1,
} from "./activity.js";

function snapshot(
  id: string,
  state: ExportJobState,
  overrides: Partial<ExportJobSnapshotV1> = {},
): ExportJobSnapshotV1 {
  const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(
    state,
  );
  const base: ExportJobSnapshotV1 = {
    schema: "atlcli.export-job/1",
    id,
    revision: 0,
    requestRef: `request:${id}`,
    format: "pdf",
    renderer: "pdf-typst",
    summary: {
      displayName: id,
      sourceLabel: "DOCS",
      siteOrigin: "https://a.atlassian.net",
      scopeKind: "space",
    },
    queue: {
      priority: "interactive",
      enqueuedAt: 1,
      groupKey: "https://a.atlassian.net",
    },
    state,
    attempt: state === "queued" ? 0 : 1,
    recoveryCount: 0,
    leaseEpoch: state === "queued" ? 0 : 1,
    stats: createEmptyExportJobStatsV1(),
    createdAt: 1,
    ...(state === "waiting"
      ? {
          waiting: { reason: "auth" as const },
          checkpointRef: `checkpoint:${id}`,
        }
      : {}),
    ...(state === "succeeded"
      ? {
          artifact: {
            ref: `artifact:${id}`,
            mediaType: "application/pdf" as const,
            filename: `${id}.pdf`,
            byteLength: 123,
            sha256: "a".repeat(64),
            committedAt: 10,
          },
        }
      : {}),
    ...(state === "failed" || state === "interrupted"
      ? {
          error: {
            code: "render-failed",
            message: "render failed",
            category: "render" as const,
            retryable: true,
            occurredAt: 10,
          },
        }
      : {}),
    ...(state === "cancelled" ? { cancelRequestedAt: 9 } : {}),
    ...(terminal ? { finishedAt: 10 } : {}),
  };
  return { ...base, ...overrides };
}

describe("browser-safe Activity projection", () => {
  it("orders states and acknowledged history by the common Activity contract", () => {
    const rows = projectExportActivityV1([
      snapshot("acknowledged-failure", "failed", {
        createdAt: 100,
        acknowledgedAt: 101,
      }),
      snapshot("unread-failure", "failed", { createdAt: 5 }),
      snapshot("unread-success", "succeeded", { createdAt: 6 }),
      snapshot("queued", "queued", { createdAt: 7 }),
      snapshot("waiting", "waiting", { createdAt: 8 }),
      snapshot("running", "running", { createdAt: 9 }),
    ]);

    expect(rows.map((row) => row.id)).toEqual([
      "running",
      "waiting",
      "queued",
      "unread-success",
      "unread-failure",
      "acknowledged-failure",
    ]);
  });

  it("uses the admission policy for global queue positions, not render order", () => {
    const a1 = snapshot("a-1", "queued", {
      createdAt: 30,
      queue: {
        priority: "interactive",
        enqueuedAt: 1,
        groupKey: "site-a",
      },
    });
    const a2 = snapshot("a-2", "queued", {
      createdAt: 40,
      queue: {
        priority: "interactive",
        enqueuedAt: 2,
        groupKey: "site-a",
      },
    });
    const b1 = snapshot("b-1", "queued", {
      format: "docx",
      renderer: "docx-typescript",
      summary: {
        displayName: "b-1",
        sourceLabel: "B",
        siteOrigin: "https://b.atlassian.net",
        scopeKind: "page",
      },
      createdAt: 10,
      queue: {
        priority: "interactive",
        enqueuedAt: 3,
        groupKey: "site-b",
      },
    });
    const retry = snapshot("retry", "queued", {
      queue: { priority: "retry", enqueuedAt: 0, groupKey: "site-c" },
    });

    const rows = projectExportActivityV1([a2, retry, b1, a1]);
    expect(rows.map((row) => [row.id, row.queueProjection])).toEqual([
      ["a-1", { kind: "estimated", position: 1 }],
      ["b-1", { kind: "estimated", position: 2 }],
      ["a-2", { kind: "estimated", position: 3 }],
      ["retry", { kind: "estimated", position: 4 }],
    ]);

    const filtered = projectExportActivityV1([a2, retry, b1, a1], {
      formats: ["docx"],
      queuePositionKind: "exact",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.queueProjection).toEqual({
      kind: "exact",
      position: 2,
    });
  });

  it("projects named waiting reasons instead of inventing a queue position", () => {
    const row = projectExportActivityRowV1(
      snapshot("auth", "waiting", {
        waiting: { reason: "auth", until: 500 },
      }),
    );
    expect(row.queueProjection).toEqual({
      kind: "waiting",
      reason: "auth",
      until: 500,
    });
    expect(row.actions).toMatchObject({
      cancel: true,
      resume: true,
      retry: false,
    });
  });

  it("filters without deleting history and hides dismissed rows by default", () => {
    const visible = snapshot("visible", "succeeded", {
      createdAt: 20,
      summary: {
        displayName: "visible",
        sourceLabel: "DOCS",
        siteOrigin: "https://wanted.atlassian.net",
        scopeKind: "space",
      },
    });
    const dismissed = snapshot("dismissed", "succeeded", {
      createdAt: 30,
      dismissedAt: 31,
      summary: visible.summary,
    });
    const old = snapshot("old", "succeeded", {
      createdAt: 5,
      summary: visible.summary,
    });

    expect(
      projectExportActivityV1([visible, dismissed, old], {
        siteOrigin: "https://wanted.atlassian.net",
        states: ["succeeded"],
        createdAfter: 10,
      }).map((row) => row.id),
    ).toEqual(["visible"]);
    expect(
      projectExportActivityV1([visible, dismissed], {
        includeDismissed: true,
      }).map((row) => row.id),
    ).toEqual(["dismissed", "visible"]);
  });

  it("projects terminal delivery metadata and immutable replay actions", () => {
    const succeeded = projectExportActivityRowV1(
      snapshot("done", "succeeded"),
    );
    expect(succeeded).toMatchObject({
      bytes: 123,
      unread: true,
      actions: {
        rerun: true,
        download: true,
        acknowledge: true,
        dismiss: true,
      },
    });

    const failed = projectExportActivityRowV1(
      snapshot("failed", "failed", { acknowledgedAt: 11 }),
    );
    expect(failed).toMatchObject({
      unread: false,
      actions: {
        retry: true,
        rerun: false,
        acknowledge: false,
        dismiss: true,
      },
    });
  });
});
