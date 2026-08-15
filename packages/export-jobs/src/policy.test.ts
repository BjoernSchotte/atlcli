import { describe, expect, it } from "bun:test";
import {
  decideResourceAdmission,
  DELIVERED_ARTIFACT_RETENTION_MS_V1,
  orderExportQueue,
  planRetentionEviction,
  projectExportBadge,
  type QueueJobV1,
  type RetentionOccupantV1,
} from "./policy.js";

function queued(
  id: string,
  priority: "interactive" | "retry",
  enqueuedAt: number,
  groupKey: string,
): QueueJobV1 {
  return { id, queue: { priority, enqueuedAt, groupKey } };
}

describe("queue policy", () => {
  it("puts interactive work before retries and round-robins FIFO site queues", () => {
    const input = [
      queued("a-2", "interactive", 3, "site-a"),
      queued("retry", "retry", 0, "site-b"),
      queued("b-1", "interactive", 2, "site-b"),
      queued("a-1", "interactive", 1, "site-a"),
      queued("a-3", "interactive", 4, "site-a"),
    ];

    expect(orderExportQueue(input).map((job) => job.id)).toEqual([
      "a-1",
      "b-1",
      "a-2",
      "a-3",
      "retry",
    ]);
    expect(input.map((job) => job.id)).toEqual(["a-2", "retry", "b-1", "a-1", "a-3"]);
  });

  it("uses job id as a deterministic FIFO tie breaker", () => {
    expect(
      orderExportQueue([
        queued("b", "interactive", 1, "same-site"),
        queued("a", "interactive", 1, "same-site"),
      ]).map((job) => job.id),
    ).toEqual(["a", "b"]);
  });
});

describe("badge projection", () => {
  it("uses active, failure, success, empty precedence and caps counts at 9+", () => {
    const tenActive = Array.from({ length: 10 }, () => ({ state: "waiting" as const }));
    expect(
      projectExportBadge([
        ...tenActive,
        { state: "failed" },
        { state: "succeeded" },
      ]),
    ).toMatchObject({
      kind: "active",
      text: "9+",
      activeCount: 10,
      unreadFailureCount: 1,
      unreadSuccessCount: 1,
    });

    expect(projectExportBadge([{ state: "failed" }, { state: "succeeded" }])).toMatchObject({
      kind: "failure",
      text: "!",
    });
    expect(projectExportBadge([{ state: "succeeded" }])).toMatchObject({
      kind: "success",
      text: "✓",
    });
    expect(
      projectExportBadge([
        { state: "failed", acknowledgedAt: 1 },
        { state: "succeeded", acknowledgedAt: 2, dismissedAt: 3 },
        { state: "cancelled" },
      ]),
    ).toEqual({
      kind: "empty",
      text: "",
      activeCount: 0,
      unreadFailureCount: 0,
      unreadSuccessCount: 0,
    });
  });

  it("does not treat dismissal alone as acknowledgement", () => {
    expect(projectExportBadge([{ state: "succeeded", dismissedAt: 2 }])).toMatchObject({
      kind: "success",
      text: "✓",
      unreadSuccessCount: 1,
    });
  });
});

describe("retention and eviction", () => {
  const now = DELIVERED_ARTIFACT_RETENTION_MS_V1 * 2;
  const policy = {
    now,
    bytesNeeded: 400,
    diagnosticGraceMs: 200,
  };

  it("orders expired temp, regenerable previews, delivered artifacts, then diagnostic temp", () => {
    const occupants: RetentionOccupantV1[] = [
      {
        ref: "failed-temp",
        kind: "temp",
        byteLength: 100,
        jobState: "failed",
        finishedAt: now - 300,
      },
      {
        ref: "delivered",
        kind: "artifact",
        byteLength: 100,
        jobState: "succeeded",
        finishedAt: now - DELIVERED_ARTIFACT_RETENTION_MS_V1 - 200,
        deliveredAt: now - DELIVERED_ARTIFACT_RETENTION_MS_V1 - 100,
      },
      {
        ref: "preview",
        kind: "preview",
        byteLength: 100,
        regenerable: true,
      },
      {
        ref: "expired",
        kind: "checkpoint",
        byteLength: 100,
        expiresAt: now - 100,
      },
    ];

    expect(planRetentionEviction(occupants, policy)).toEqual({
      evictions: [
        { ref: "expired", byteLength: 100, reason: "expired-temp" },
        { ref: "preview", byteLength: 100, reason: "regenerable-preview" },
        { ref: "delivered", byteLength: 100, reason: "released-terminal-artifact" },
        {
          ref: "failed-temp",
          byteLength: 100,
          reason: "terminal-diagnostic-grace-elapsed",
        },
      ],
      reclaimedBytes: 400,
      shortfallBytes: 0,
    });
  });

  it("never evicts active or succeeded-undelivered work and respects finishedAt grace", () => {
    const protectedOccupants: RetentionOccupantV1[] = [
      {
        ref: "active-expired",
        kind: "temp",
        byteLength: 200,
        jobState: "running",
        expiresAt: 1,
      },
      {
        ref: "undelivered",
        kind: "artifact",
        byteLength: 200,
        jobState: "succeeded",
        finishedAt: 1,
      },
      {
        ref: "failure-in-grace",
        kind: "temp",
        byteLength: 200,
        jobState: "failed",
        finishedAt: now - 100,
      },
      {
        ref: "artifact-in-grace",
        kind: "artifact",
        byteLength: 200,
        jobState: "succeeded",
        finishedAt: now - DELIVERED_ARTIFACT_RETENTION_MS_V1,
        deliveredAt: now - DELIVERED_ARTIFACT_RETENTION_MS_V1 + 1,
      },
      {
        ref: "non-regenerable-preview",
        kind: "preview",
        byteLength: 200,
        regenerable: false,
      },
    ];

    expect(
      planRetentionEviction(protectedOccupants, { ...policy, bytesNeeded: 100 }),
    ).toEqual({ evictions: [], reclaimedBytes: 0, shortfallBytes: 100 });
  });

  it("uses finishedAt diagnostic grace for interrupted temporary data", () => {
    expect(
      planRetentionEviction(
        [
          {
            ref: "interrupted-temp",
            kind: "temp",
            byteLength: 100,
            jobState: "interrupted",
            finishedAt: 700,
          },
        ],
        { ...policy, bytesNeeded: 100 },
      ),
    ).toMatchObject({
      evictions: [
        {
          ref: "interrupted-temp",
          reason: "terminal-diagnostic-grace-elapsed",
        },
      ],
      shortfallBytes: 0,
    });
  });
});

describe("resource admission", () => {
  const estimate = {
    heapBytes: 100,
    spoolBytes: 200,
    outputBytes: 300,
    rasterPixels: 400,
    confidence: "estimated" as const,
  };

  it("admits only when every resource and the heavy slot are available", () => {
    expect(
      decideResourceAdmission(
        estimate,
        {
          heapBytes: 100,
          spoolBytes: 200,
          outputBytes: 300,
          rasterPixels: 400,
          heavyRenderSlots: 1,
        },
        { workKind: "export", queuedExports: 1 },
      ),
    ).toEqual({ admitted: true, confidence: "estimated", shortfalls: [] });
  });

  it("reports every exact capacity shortfall", () => {
    expect(
      decideResourceAdmission(
        estimate,
        {
          heapBytes: 60,
          spoolBytes: 150,
          outputBytes: 300,
          rasterPixels: 400,
          heavyRenderSlots: 0,
        },
        { workKind: "export", queuedExports: 0 },
      ),
    ).toMatchObject({
      admitted: false,
      shortfalls: [
        {
          resource: "heapBytes",
          required: 100,
          available: 60,
          shortfall: 40,
          reason: "capacity",
        },
        {
          resource: "spoolBytes",
          required: 200,
          available: 150,
          shortfall: 50,
          reason: "capacity",
        },
        {
          resource: "heavyRenderSlots",
          required: 1,
          available: 0,
          shortfall: 1,
          reason: "capacity",
        },
      ],
    });
  });

  it("reserves an otherwise free heavy slot from previews while an export is queued", () => {
    expect(
      decideResourceAdmission(
        estimate,
        {
          heapBytes: 100,
          spoolBytes: 200,
          outputBytes: 300,
          rasterPixels: 400,
          heavyRenderSlots: 1,
        },
        { workKind: "preview", queuedExports: 1 },
      ),
    ).toMatchObject({
      admitted: false,
      shortfalls: [
        {
          resource: "heavyRenderSlots",
          available: 0,
          shortfall: 1,
          reason: "reserved-for-export",
        },
      ],
    });
  });
});
