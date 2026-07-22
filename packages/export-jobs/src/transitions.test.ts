import { describe, expect, it } from "bun:test";
import type { ExportJobSnapshotV1, ExportJobState } from "./snapshot.js";
import {
  ExportJobTransitionConflict,
  checkpointExportJob,
  claimExportJob,
  finalizeExportJobArtifact,
  heartbeatExportJob,
  isExportJobTerminal,
  reclaimExpiredExportJobLease,
  transitionExportJob,
  updateExportJobProgress,
  updateExportJobStats,
  updateExportJobTerminalMetadata,
} from "./transitions.js";

function snapshot(state: ExportJobState = "queued"): ExportJobSnapshotV1 {
  return {
    schema: "atlcli.export-job/1",
    id: "job-1",
    revision: 0,
    requestRef: "request:job-1",
    format: "pdf",
    renderer: "pdf-typst",
    summary: {
      displayName: "Handbook",
      sourceLabel: "DOCS",
      siteOrigin: "https://example.atlassian.net",
      scopeKind: "space",
    },
    queue: { priority: "interactive", enqueuedAt: 1, groupKey: "site:docs" },
    state,
    attempt: 0,
    recoveryCount: 0,
    leaseEpoch: 0,
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
  };
}

function claim(input = snapshot()): ExportJobSnapshotV1 {
  return claimExportJob(input, {
    expectedRevision: input.revision,
    ownerId: "runner-a",
    now: 100,
    leaseDurationMs: 50,
  });
}

function expectConflict(fn: () => unknown, code: ExportJobTransitionConflict["code"]): void {
  try {
    fn();
    throw new Error("Expected transition conflict.");
  } catch (error) {
    expect(error).toBeInstanceOf(ExportJobTransitionConflict);
    expect((error as ExportJobTransitionConflict).code).toBe(code);
  }
}

describe("state transitions", () => {
  it("allows the direct lifecycle edges and increments the revision", () => {
    const running = claim();
    const waiting = transitionExportJob(running, {
      expectedRevision: running.revision,
      leaseEpoch: running.lease!.epoch,
      to: "waiting",
      at: 110,
      waiting: { reason: "backoff", until: 500 },
      checkpointRef: "checkpoint:waiting",
    });
    expect(waiting).toMatchObject({ state: "waiting", revision: 2, waiting: { reason: "backoff" } });
    expect(waiting.lease).toBeUndefined();

    const resumed = claim(waiting);
    const cancelling = transitionExportJob(resumed, {
      expectedRevision: resumed.revision,
      to: "cancelling",
      at: 120,
    });
    expect(cancelling.cancelRequestedAt).toBe(120);
    const cancelled = transitionExportJob(cancelling, {
      expectedRevision: cancelling.revision,
      leaseEpoch: cancelling.lease!.epoch,
      to: "cancelled",
      at: 130,
    });
    expect(cancelled).toMatchObject({ state: "cancelled", finishedAt: 130 });
    expect(cancelled.lease).toBeUndefined();
  });

  it("allows queued and unleased waiting jobs to cancel directly", () => {
    for (const current of [snapshot("queued"), { ...snapshot("waiting"), waiting: { reason: "auth" as const } }]) {
      const result = transitionExportJob(current, {
        expectedRevision: current.revision,
        to: "cancelled",
        at: 20,
      });
      expect(result).toMatchObject({ state: "cancelled", finishedAt: 20 });
    }
  });

  it("requires executor lease fencing for terminal and waiting writes", () => {
    const running = claim();
    const error = {
      code: "render.failed",
      message: "Render failed.",
      category: "render" as const,
      retryable: true,
      occurredAt: 120,
    };
    expectConflict(
      () => transitionExportJob(running, { expectedRevision: 1, to: "failed", at: 120, error }),
      "lease-mismatch",
    );
    expectConflict(
      () => transitionExportJob(running, { expectedRevision: 1, leaseEpoch: 99, to: "failed", at: 120, error }),
      "lease-mismatch",
    );
    expectConflict(
      () => transitionExportJob(running, {
        expectedRevision: 1,
        leaseEpoch: 1,
        to: "waiting",
        at: 120,
        waiting: { reason: "backoff", until: 500 },
      }),
      "invalid-transition",
    );
  });

  it("requires structured errors for failed and interrupted transitions", () => {
    for (const to of ["failed", "interrupted"] as const) {
      const running = claim();
      expectConflict(
        () => transitionExportJob(running, { expectedRevision: 1, leaseEpoch: 1, to, at: 120 }),
        "invalid-transition",
      );
    }
  });

  it("rejects executor transitions at or after lease expiry", () => {
    const running = claim();
    expectConflict(
      () => transitionExportJob(running, {
        expectedRevision: 1,
        leaseEpoch: 1,
        to: "failed",
        at: 150,
        error: {
          code: "render.failed",
          message: "Render failed.",
          category: "render",
          retryable: true,
          occurredAt: 150,
        },
      }),
      "lease-expired",
    );
  });

  it("rejects stale revisions without changing the input", () => {
    const queued = snapshot();
    expectConflict(
      () => transitionExportJob(queued, { expectedRevision: 9, to: "cancelled", at: 2 }),
      "revision-conflict",
    );
    expect(queued).toEqual(snapshot());
  });

  it("keeps every terminal state immutable except through terminal metadata", () => {
    for (const state of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
      const terminal = snapshot(state);
      expect(isExportJobTerminal(state)).toBe(true);
      expectConflict(
        () => transitionExportJob(terminal, { expectedRevision: 0, to: "cancelled", at: 2 }),
        "terminal-immutable",
      );
      expectConflict(
        () => claimExportJob(terminal, { expectedRevision: 0, ownerId: "runner", now: 2, leaseDurationMs: 10 }),
        "terminal-immutable",
      );
    }
  });

  it("rejects edges reserved for claim and lease recovery", () => {
    expectConflict(
      () => transitionExportJob(snapshot(), { expectedRevision: 0, to: "running", at: 2 }),
      "invalid-transition",
    );
    const running = claim();
    expectConflict(
      () => transitionExportJob(running, { expectedRevision: 1, leaseEpoch: 1, to: "queued", at: 2 }),
      "invalid-transition",
    );
  });
});

describe("claim, heartbeat, and reclaim", () => {
  it("claims once and allocates monotonically increasing epochs across waiting", () => {
    const first = claim();
    expect(first).toMatchObject({ state: "running", attempt: 1, leaseEpoch: 1, startedAt: 100 });
    expect(first.lease).toMatchObject({ ownerId: "runner-a", epoch: 1, expiresAt: 150 });
    expectConflict(
      () => claimExportJob(first, { expectedRevision: 1, ownerId: "runner-b", now: 101, leaseDurationMs: 50 }),
      "invalid-transition",
    );

    const waiting = transitionExportJob(first, {
      expectedRevision: 1,
      leaseEpoch: 1,
      to: "waiting",
      at: 110,
      waiting: { reason: "quota" },
      checkpointRef: "checkpoint:quota",
    });
    const second = claimExportJob(waiting, {
      expectedRevision: 2,
      ownerId: "runner-b",
      now: 200,
      leaseDurationMs: 50,
    });
    expect(second).toMatchObject({ attempt: 2, leaseEpoch: 2 });
    expect(second.lease?.epoch).toBe(2);
    expect(second.startedAt).toBe(100);
  });

  it("starts a fresh progress attempt after a waiting job is reclaimed", () => {
    const running = updateExportJobProgress(claim(), {
      expectedRevision: 1,
      leaseEpoch: 1,
      progress: { stage: "fetch", done: 4, total: 10, updatedAt: 110 },
    });
    const waiting = transitionExportJob(running, {
      expectedRevision: 2,
      leaseEpoch: 1,
      to: "waiting",
      at: 120,
      waiting: { reason: "backoff" },
      checkpointRef: "checkpoint:backoff",
    });
    const resumed = claimExportJob(waiting, {
      expectedRevision: 3,
      ownerId: "runner-b",
      now: 200,
      leaseDurationMs: 50,
    });
    expect(resumed).toMatchObject({ attempt: 2, leaseEpoch: 2 });
    expect(resumed.stage).toBeUndefined();
    expect(resumed.progress).toBeUndefined();
    expect(() => updateExportJobProgress(resumed, {
      expectedRevision: 4,
      leaseEpoch: 2,
      progress: { stage: "discover", done: 0, total: null, updatedAt: 201 },
    })).not.toThrow();
  });

  it("renews only the matching unexpired owner and epoch", () => {
    const running = claim();
    const renewed = heartbeatExportJob(running, {
      expectedRevision: 1,
      ownerId: "runner-a",
      leaseEpoch: 1,
      now: 120,
      leaseDurationMs: 100,
    });
    expect(renewed.lease).toMatchObject({ heartbeatAt: 120, expiresAt: 220 });
    expectConflict(
      () => heartbeatExportJob(running, { expectedRevision: 1, ownerId: "runner-b", leaseEpoch: 1, now: 120, leaseDurationMs: 10 }),
      "lease-mismatch",
    );
    expectConflict(
      () => heartbeatExportJob(running, { expectedRevision: 1, ownerId: "runner-a", leaseEpoch: 1, now: 150, leaseDurationMs: 10 }),
      "lease-expired",
    );
    expectConflict(
      () => heartbeatExportJob(running, { expectedRevision: 1, ownerId: "runner-a", leaseEpoch: 1, now: 120, leaseDurationMs: 20 }),
      "invalid-lease",
    );
  });

  it("rejects non-finite claim and heartbeat clocks and expiry overflow", () => {
    expectConflict(
      () => claimExportJob(snapshot(), { expectedRevision: 0, ownerId: "runner", now: Number.NaN, leaseDurationMs: 10 }),
      "invalid-metadata",
    );
    expectConflict(
      () => claimExportJob(snapshot(), { expectedRevision: 0, ownerId: "runner", now: Number.MAX_VALUE, leaseDurationMs: Number.MAX_VALUE }),
      "invalid-lease",
    );
    expectConflict(
      () => claimExportJob({ ...snapshot(), attempt: Number.NaN }, { expectedRevision: 0, ownerId: "runner", now: 1, leaseDurationMs: 10 }),
      "invalid-lease",
    );
    expectConflict(
      () => heartbeatExportJob(claim(), { expectedRevision: 1, ownerId: "runner-a", leaseEpoch: 1, now: Number.POSITIVE_INFINITY, leaseDurationMs: 10 }),
      "invalid-metadata",
    );
  });

  it("requeues an expired lease at a safe checkpoint and fences the stale epoch", () => {
    const running = { ...claim(), checkpointRef: "checkpoint:job-1:fetch" };
    expectConflict(
      () => reclaimExpiredExportJobLease(running, { expectedRevision: 1, now: 149 }),
      "lease-not-expired",
    );
    const queued = reclaimExpiredExportJobLease(running, { expectedRevision: 1, now: 150 });
    expect(queued).toMatchObject({ state: "queued", recoveryCount: 1, attempt: 1 });
    expect(queued.lease).toBeUndefined();

    const reclaimed = claimExportJob(queued, {
      expectedRevision: 2,
      ownerId: "runner-b",
      now: 151,
      leaseDurationMs: 50,
    });
    expect(reclaimed.lease?.epoch).toBe(2);
    expectConflict(
      () => updateExportJobProgress(reclaimed, {
        expectedRevision: 3,
        leaseEpoch: 1,
        progress: { stage: "fetch", done: 2, total: 10, updatedAt: 152 },
      }),
      "lease-mismatch",
    );
  });

  it("rejects non-finite lease reclaim clocks", () => {
    const running = claim();
    expectConflict(
      () => reclaimExpiredExportJobLease(running, {
        expectedRevision: running.revision,
        now: Number.NaN,
      }),
      "invalid-metadata",
    );
  });

  it("interrupts expired work without a safe checkpoint", () => {
    const interrupted = reclaimExpiredExportJobLease(claim(), { expectedRevision: 1, now: 150 });
    expect(interrupted).toMatchObject({
      state: "interrupted",
      finishedAt: 150,
      recoveryCount: 1,
      error: { code: "executor.lease_expired", category: "worker", retryable: true },
    });
    expect(interrupted.lease).toBeUndefined();
  });

  it("finishes cancelling work as cancelled when its runner lease expires", () => {
    const running = claim();
    const cancelling = transitionExportJob(running, {
      expectedRevision: 1,
      to: "cancelling",
      at: 120,
    });
    const cancelled = reclaimExpiredExportJobLease(cancelling, { expectedRevision: 2, now: 150 });
    expect(cancelled).toMatchObject({ state: "cancelled", finishedAt: 150, cancelRequestedAt: 120 });
    expect(cancelled.lease).toBeUndefined();
  });
});

describe("progress fencing", () => {
  it("is monotonic within one stage and may reset for a new stage", () => {
    const running = claim();
    const fetch = updateExportJobProgress(running, {
      expectedRevision: 1,
      leaseEpoch: 1,
      progress: { stage: "fetch", done: 4, total: 10, updatedAt: 110 },
    });
    const fetchLater = updateExportJobProgress(fetch, {
      expectedRevision: 2,
      leaseEpoch: 1,
      progress: { stage: "fetch", done: 5, total: 10, updatedAt: 111 },
    });
    expect(fetchLater.progress?.done).toBe(5);
    const compose = updateExportJobProgress(fetchLater, {
      expectedRevision: 3,
      leaseEpoch: 1,
      progress: { stage: "compose", done: 0, total: null, updatedAt: 112 },
    });
    expect(compose).toMatchObject({ stage: "compose", revision: 4 });
  });

  it("rejects regressions and invalid counters", () => {
    const running = updateExportJobProgress(claim(), {
      expectedRevision: 1,
      leaseEpoch: 1,
      progress: { stage: "fetch", done: 4, total: 10, updatedAt: 110 },
    });
    expectConflict(
      () => updateExportJobProgress(running, {
        expectedRevision: 2,
        leaseEpoch: 1,
        progress: { stage: "fetch", done: 3, total: 10, updatedAt: 111 },
      }),
      "progress-regression",
    );
    expectConflict(
      () => updateExportJobProgress(running, {
        expectedRevision: 2,
        leaseEpoch: 1,
        progress: { stage: "fetch", done: 11, total: 10, updatedAt: 111 },
      }),
      "invalid-progress",
    );
    expectConflict(
      () => updateExportJobProgress(running, {
        expectedRevision: 2,
        leaseEpoch: 1,
        progress: { stage: "discover", done: 5, total: 10, updatedAt: 111 },
      }),
      "progress-regression",
    );
    expectConflict(
      () => updateExportJobProgress(running, {
        expectedRevision: 2,
        leaseEpoch: 1,
        progress: { stage: "fetch", done: 5, total: 10, updatedAt: 109 },
      }),
      "progress-regression",
    );
  });

  it("rejects progress at or after lease expiry", () => {
    expectConflict(
      () => updateExportJobProgress(claim(), {
        expectedRevision: 1,
        leaseEpoch: 1,
        progress: { stage: "fetch", done: 1, total: 2, updatedAt: 150 },
      }),
      "lease-expired",
    );
  });
});

describe("checkpoint fencing", () => {
  it("attaches a checkpoint under the current revision and live lease", () => {
    const running = updateExportJobProgress(claim(), {
      expectedRevision: 1,
      leaseEpoch: 1,
      progress: { stage: "fetch", done: 4, total: 10, updatedAt: 110 },
    });
    const checkpointed = checkpointExportJob(running, {
      expectedRevision: 2,
      leaseEpoch: 1,
      at: 111,
      checkpointRef: "checkpoint:job-1:fetch:4",
    });
    expect(checkpointed).toMatchObject({
      revision: 3,
      state: "running",
      checkpointRef: "checkpoint:job-1:fetch:4",
    });
  });

  it("rejects stale revision, stale epoch, expired lease, and empty refs", () => {
    const running = claim();
    expectConflict(
      () => checkpointExportJob(running, { expectedRevision: 0, leaseEpoch: 1, at: 110, checkpointRef: "checkpoint:x" }),
      "revision-conflict",
    );
    expectConflict(
      () => checkpointExportJob(running, { expectedRevision: 1, leaseEpoch: 2, at: 110, checkpointRef: "checkpoint:x" }),
      "lease-mismatch",
    );
    expectConflict(
      () => checkpointExportJob(running, { expectedRevision: 1, leaseEpoch: 1, at: 150, checkpointRef: "checkpoint:x" }),
      "lease-expired",
    );
    expectConflict(
      () => checkpointExportJob(running, { expectedRevision: 1, leaseEpoch: 1, at: 110, checkpointRef: "  " }),
      "invalid-metadata",
    );
    expectConflict(
      () => checkpointExportJob(running, { expectedRevision: 1, leaseEpoch: 1, at: 99, checkpointRef: "checkpoint:x" }),
      "invalid-lease",
    );
  });

  it("rejects checkpoints that predate progress or target unleased states", () => {
    const running = updateExportJobProgress(claim(), {
      expectedRevision: 1,
      leaseEpoch: 1,
      progress: { stage: "fetch", done: 4, total: 10, updatedAt: 120 },
    });
    expectConflict(
      () => checkpointExportJob(running, { expectedRevision: 2, leaseEpoch: 1, at: 119, checkpointRef: "checkpoint:x" }),
      "invalid-metadata",
    );
    expectConflict(
      () => checkpointExportJob(snapshot("waiting"), { expectedRevision: 0, leaseEpoch: 1, at: 10, checkpointRef: "checkpoint:x" }),
      "invalid-transition",
    );
  });
});

describe("statistics fencing", () => {
  it("accepts monotonic counters under the live lease", () => {
    const running = claim();
    const stats = structuredClone(running.stats);
    stats.pages.discovered = 2;
    stats.storage.spoolPeakBytes = 128;
    stats.metricSupport["storage.spoolPeakBytes"] = "measured";
    const next = updateExportJobStats(running, {
      expectedRevision: running.revision,
      leaseEpoch: running.lease!.epoch,
      at: 120,
      stats,
    });
    expect(next.revision).toBe(running.revision + 1);
    expect(next.stats.pages.discovered).toBe(2);
  });

  it("rejects stale leases, counter regressions, and metric-support regressions", () => {
    const running = claim();
    const stats = structuredClone(running.stats);
    stats.pages.discovered = 2;
    expectConflict(
      () => updateExportJobStats(running, {
        expectedRevision: running.revision,
        leaseEpoch: 2,
        at: 120,
        stats,
      }),
      "lease-mismatch",
    );

    const measured = structuredClone(running);
    measured.stats.pages.discovered = 2;
    measured.stats.metricSupport["memory.heapPeakBytes"] = "measured";
    const regressed = structuredClone(measured.stats);
    regressed.pages.discovered = 1;
    expectConflict(
      () => updateExportJobStats(measured, {
        expectedRevision: measured.revision,
        leaseEpoch: measured.lease!.epoch,
        at: 120,
        stats: regressed,
      }),
      "invalid-stats",
    );
    regressed.pages.discovered = 2;
    regressed.metricSupport["memory.heapPeakBytes"] = "unavailable";
    expectConflict(
      () => updateExportJobStats(measured, {
        expectedRevision: measured.revision,
        leaseEpoch: measured.lease!.epoch,
        at: 120,
        stats: regressed,
      }),
      "invalid-stats",
    );
  });
});

describe("artifact finalization", () => {
  function finalizeInput(running: ExportJobSnapshotV1) {
    return {
      id: running.id,
      expectedRevision: running.revision,
      leaseEpoch: running.lease!.epoch,
      stagedArtifact: {
        ref: "staged:job-1:1",
        mediaType: "application/pdf" as const,
        filename: "Handbook.pdf",
        byteLength: 42,
        sha256: "abc",
        jobId: running.id,
        leaseEpoch: running.lease!.epoch,
        stagedAt: 120,
      },
      finishedAt: 130,
    };
  }

  it("is the only successful terminal transition and commits staged metadata", () => {
    const running = claim();
    const result = finalizeExportJobArtifact(running, finalizeInput(running));
    expect(result).toMatchObject({
      state: "succeeded",
      stage: "commit",
      finishedAt: 130,
      artifact: { ref: "staged:job-1:1", byteLength: 42, committedAt: 130 },
    });
    expect(result.lease).toBeUndefined();
    expectConflict(
      () => transitionExportJob(running, { expectedRevision: 1, leaseEpoch: 1, to: "succeeded", at: 130 }),
      "invalid-transition",
    );
  });

  it("rejects stale revision, job id, epoch, and expired finalization", () => {
    const running = claim();
    const base = finalizeInput(running);
    expectConflict(
      () => finalizeExportJobArtifact(running, { ...base, expectedRevision: 0 }),
      "revision-conflict",
    );
    expectConflict(
      () => finalizeExportJobArtifact(running, { ...base, stagedArtifact: { ...base.stagedArtifact, jobId: "other" } }),
      "invalid-metadata",
    );
    expectConflict(
      () => finalizeExportJobArtifact(running, { ...base, stagedArtifact: { ...base.stagedArtifact, leaseEpoch: 2 } }),
      "lease-mismatch",
    );
    expectConflict(
      () => finalizeExportJobArtifact(running, { ...base, finishedAt: 150 }),
      "lease-expired",
    );
  });
});

describe("terminal presentation metadata", () => {
  it("allows delivery, acknowledgement, and dismissal without changing terminal execution data", () => {
    const terminal = {
      ...snapshot("succeeded"),
      finishedAt: 100,
      artifact: {
        ref: "artifact:job-1",
        mediaType: "application/pdf" as const,
        filename: "Handbook.pdf",
        byteLength: 42,
        sha256: "abc",
        committedAt: 100,
      },
    };
    const result = updateExportJobTerminalMetadata(terminal, {
      expectedRevision: 0,
      deliveredAt: 110,
      acknowledgedAt: 110,
      dismissedAt: 120,
    });
    expect(result).toMatchObject({
      state: "succeeded",
      revision: 1,
      deliveredAt: 110,
      acknowledgedAt: 110,
      dismissedAt: 120,
      artifact: terminal.artifact,
    });
  });

  it("keeps dismissal separate from acknowledgement and timestamps set-once", () => {
    const dismissed = updateExportJobTerminalMetadata({ ...snapshot("failed"), finishedAt: 10 }, {
      expectedRevision: 0,
      dismissedAt: 20,
    });
    expect(dismissed.acknowledgedAt).toBeUndefined();
    expectConflict(
      () => updateExportJobTerminalMetadata(dismissed, { expectedRevision: 1, dismissedAt: 21 }),
      "invalid-metadata",
    );
  });

  it("rejects terminal metadata on unfinished jobs", () => {
    expectConflict(
      () => updateExportJobTerminalMetadata(snapshot(), { expectedRevision: 0, acknowledgedAt: 2 }),
      "invalid-metadata",
    );
  });

  it("rejects terminal metadata before finishedAt", () => {
    expectConflict(
      () => updateExportJobTerminalMetadata(
        { ...snapshot("succeeded"), finishedAt: 100 },
        { expectedRevision: 0, acknowledgedAt: 99 },
      ),
      "invalid-metadata",
    );
  });
});
