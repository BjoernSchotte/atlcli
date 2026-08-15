import type { ResourceEstimateV1 } from "./resource.js";
import type { ExportJobSnapshotV1, ExportJobState } from "./snapshot.js";

/** The durable fields needed to project a deterministic queue order. */
export type QueueJobV1 = Pick<ExportJobSnapshotV1, "id" | "queue">;

const PRIORITY_ORDER = {
  interactive: 0,
  retry: 1,
} as const;

function compareQueueJobs(a: QueueJobV1, b: QueueJobV1): number {
  return a.queue.enqueuedAt - b.queue.enqueuedAt || a.id.localeCompare(b.id);
}

/**
 * Project the initial queue policy without mutating durable records:
 * interactive exports precede retries, each site remains FIFO, and sites are
 * interleaved round-robin from the site whose head job was enqueued first.
 */
export function orderExportQueue<T extends QueueJobV1>(jobs: readonly T[]): T[] {
  const ordered: T[] = [];
  const priorities = Object.keys(PRIORITY_ORDER).sort(
    (a, b) =>
      PRIORITY_ORDER[a as keyof typeof PRIORITY_ORDER] -
      PRIORITY_ORDER[b as keyof typeof PRIORITY_ORDER],
  ) as Array<keyof typeof PRIORITY_ORDER>;

  for (const priority of priorities) {
    const groups = new Map<string, T[]>();
    for (const job of jobs) {
      if (job.queue.priority !== priority) continue;
      const group = groups.get(job.queue.groupKey) ?? [];
      group.push(job);
      groups.set(job.queue.groupKey, group);
    }
    for (const group of groups.values()) group.sort(compareQueueJobs);

    const groupOrder = [...groups.entries()]
      .sort(
        ([keyA, jobsA], [keyB, jobsB]) =>
          compareQueueJobs(jobsA[0]!, jobsB[0]!) || keyA.localeCompare(keyB),
      )
      .map(([groupKey]) => groupKey);

    let remaining = true;
    while (remaining) {
      remaining = false;
      for (const groupKey of groupOrder) {
        const next = groups.get(groupKey)?.shift();
        if (!next) continue;
        ordered.push(next);
        remaining = true;
      }
    }
  }

  return ordered;
}

/** Minimal persisted fields needed for the toolbar badge projection. */
export type BadgeJobV1 = Pick<
  ExportJobSnapshotV1,
  "state" | "acknowledgedAt" | "dismissedAt"
>;

export interface ExportBadgeProjectionV1 {
  kind: "active" | "failure" | "success" | "empty";
  text: string;
  activeCount: number;
  unreadFailureCount: number;
  unreadSuccessCount: number;
}

const ACTIVE_STATES: ReadonlySet<ExportJobState> = new Set([
  "queued",
  "running",
  "waiting",
  "cancelling",
]);

function isUnread(job: BadgeJobV1): boolean {
  return job.acknowledgedAt === undefined;
}

/** Project the durable badge precedence: active, unread failure, unread success. */
export function projectExportBadge(jobs: readonly BadgeJobV1[]): ExportBadgeProjectionV1 {
  const activeCount = jobs.filter((job) => ACTIVE_STATES.has(job.state)).length;
  const unreadFailureCount = jobs.filter(
    (job) => isUnread(job) && (job.state === "failed" || job.state === "interrupted"),
  ).length;
  const unreadSuccessCount = jobs.filter(
    (job) => isUnread(job) && job.state === "succeeded",
  ).length;

  if (activeCount > 0) {
    return {
      kind: "active",
      text: activeCount > 9 ? "9+" : String(activeCount),
      activeCount,
      unreadFailureCount,
      unreadSuccessCount,
    };
  }
  if (unreadFailureCount > 0) {
    return {
      kind: "failure",
      text: "!",
      activeCount,
      unreadFailureCount,
      unreadSuccessCount,
    };
  }
  if (unreadSuccessCount > 0) {
    return {
      kind: "success",
      text: "✓",
      activeCount,
      unreadFailureCount,
      unreadSuccessCount,
    };
  }
  return {
    kind: "empty",
    text: "",
    activeCount,
    unreadFailureCount,
    unreadSuccessCount,
  };
}

export type RetentionOccupantKindV1 = "temp" | "checkpoint" | "preview" | "artifact";

/** One byte-owning occupant considered by the common retention policy. */
export interface RetentionOccupantV1 {
  ref: string;
  kind: RetentionOccupantKindV1;
  byteLength: number;
  jobState?: ExportJobState;
  finishedAt?: number;
  deliveredAt?: number;
  dismissedAt?: number;
  expiresAt?: number;
  /** Preview bytes are eligible only when the host declares them regenerable. */
  regenerable?: boolean;
}

export interface RetentionPolicyV1 {
  now: number;
  bytesNeeded: number;
  diagnosticGraceMs: number;
}

export { DELIVERED_ARTIFACT_RETENTION_MS_V1 } from "./lifecycle-retention.js";
import { DELIVERED_ARTIFACT_RETENTION_MS_V1 } from "./lifecycle-retention.js";

export type EvictionReasonV1 =
  | "expired-temp"
  | "regenerable-preview"
  | "released-terminal-artifact"
  | "terminal-diagnostic-grace-elapsed";

export interface PlannedEvictionV1 {
  ref: string;
  byteLength: number;
  reason: EvictionReasonV1;
}

export interface RetentionEvictionPlanV1 {
  evictions: PlannedEvictionV1[];
  reclaimedBytes: number;
  shortfallBytes: number;
}

interface EligibleOccupant {
  occupant: RetentionOccupantV1;
  rank: number;
  eligibleAt: number;
  reason: EvictionReasonV1;
}

function evictionEligibility(
  occupant: RetentionOccupantV1,
  policy: RetentionPolicyV1,
): EligibleOccupant | null {
  if (occupant.jobState && ACTIVE_STATES.has(occupant.jobState)) return null;

  const succeededUndelivered =
    occupant.jobState === "succeeded" &&
    occupant.deliveredAt === undefined &&
    occupant.dismissedAt === undefined;
  if (succeededUndelivered) return null;

  if (
    (occupant.kind === "temp" || occupant.kind === "checkpoint") &&
    occupant.expiresAt !== undefined &&
    occupant.expiresAt <= policy.now
  ) {
    return {
      occupant,
      rank: 0,
      eligibleAt: occupant.expiresAt,
      reason: "expired-temp",
    };
  }

  if (occupant.kind === "preview" && occupant.regenerable === true) {
    return {
      occupant,
      rank: 1,
      eligibleAt: occupant.expiresAt ?? Number.NEGATIVE_INFINITY,
      reason: "regenerable-preview",
    };
  }

  if (
    occupant.kind === "artifact" &&
    occupant.jobState === "succeeded" &&
    occupant.finishedAt !== undefined &&
    (occupant.deliveredAt !== undefined || occupant.dismissedAt !== undefined)
  ) {
    const terminalUseAt = Math.max(
      occupant.finishedAt,
      occupant.deliveredAt ?? Number.NEGATIVE_INFINITY,
      occupant.dismissedAt ?? Number.NEGATIVE_INFINITY,
    );
    const eligibleAt = terminalUseAt + DELIVERED_ARTIFACT_RETENTION_MS_V1;
    if (eligibleAt <= policy.now) {
      return {
        occupant,
        rank: 2,
        eligibleAt,
        reason: "released-terminal-artifact",
      };
    }
  }

  if (
    (occupant.kind === "temp" || occupant.kind === "checkpoint") &&
    (occupant.jobState === "failed" ||
      occupant.jobState === "cancelled" ||
      occupant.jobState === "interrupted") &&
    occupant.finishedAt !== undefined
  ) {
    const eligibleAt = occupant.finishedAt + policy.diagnosticGraceMs;
    if (eligibleAt <= policy.now) {
      return {
        occupant,
        rank: 3,
        eligibleAt,
        reason: "terminal-diagnostic-grace-elapsed",
      };
    }
  }

  return null;
}

/**
 * Select the minimum ordered set of eligible bytes needed for admission.
 * Missing lifecycle timestamps fail closed and therefore never authorize loss.
 */
export function planRetentionEviction(
  occupants: readonly RetentionOccupantV1[],
  policy: RetentionPolicyV1,
): RetentionEvictionPlanV1 {
  const bytesNeeded = Math.max(0, policy.bytesNeeded);
  if (bytesNeeded === 0) return { evictions: [], reclaimedBytes: 0, shortfallBytes: 0 };

  const eligible = occupants
    .map((occupant) => evictionEligibility(occupant, policy))
    .filter((candidate): candidate is EligibleOccupant => candidate !== null)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.eligibleAt - b.eligibleAt ||
        a.occupant.ref.localeCompare(b.occupant.ref),
    );

  const evictions: PlannedEvictionV1[] = [];
  let reclaimedBytes = 0;
  for (const candidate of eligible) {
    if (reclaimedBytes >= bytesNeeded) break;
    if (candidate.occupant.byteLength <= 0) continue;
    evictions.push({
      ref: candidate.occupant.ref,
      byteLength: candidate.occupant.byteLength,
      reason: candidate.reason,
    });
    reclaimedBytes += candidate.occupant.byteLength;
  }

  return {
    evictions,
    reclaimedBytes,
    shortfallBytes: Math.max(0, bytesNeeded - reclaimedBytes),
  };
}

export type ResourceShortfallKindV1 =
  | "heapBytes"
  | "spoolBytes"
  | "outputBytes"
  | "rasterPixels"
  | "heavyRenderSlots";

export interface ResourceCapacityV1 {
  heapBytes: number;
  spoolBytes: number;
  outputBytes: number;
  rasterPixels: number;
  heavyRenderSlots: number;
}

export interface ResourceAdmissionOptionsV1 {
  workKind: "export" | "preview";
  queuedExports: number;
}

export interface ResourceShortfallV1 {
  resource: ResourceShortfallKindV1;
  required: number;
  available: number;
  shortfall: number;
  reason: "capacity" | "reserved-for-export";
}

export interface ResourceAdmissionDecisionV1 {
  admitted: boolean;
  confidence: ResourceEstimateV1["confidence"];
  shortfalls: ResourceShortfallV1[];
}

/** Decide render admission without acquiring a slot or mutating host counters. */
export function decideResourceAdmission(
  estimate: ResourceEstimateV1,
  available: ResourceCapacityV1,
  options: ResourceAdmissionOptionsV1,
): ResourceAdmissionDecisionV1 {
  const shortfalls: ResourceShortfallV1[] = [];
  const resources: Array<keyof Omit<ResourceCapacityV1, "heavyRenderSlots">> = [
    "heapBytes",
    "spoolBytes",
    "outputBytes",
    "rasterPixels",
  ];

  for (const resource of resources) {
    const required = Math.max(0, estimate[resource]);
    const free = Math.max(0, available[resource]);
    if (required <= free) continue;
    shortfalls.push({
      resource,
      required,
      available: free,
      shortfall: required - free,
      reason: "capacity",
    });
  }

  const previewBlocked = options.workKind === "preview" && options.queuedExports > 0;
  const freeSlots = Math.max(0, available.heavyRenderSlots);
  if (previewBlocked || freeSlots < 1) {
    shortfalls.push({
      resource: "heavyRenderSlots",
      required: 1,
      available: previewBlocked ? 0 : freeSlots,
      shortfall: 1,
      reason: previewBlocked ? "reserved-for-export" : "capacity",
    });
  }

  return {
    admitted: shortfalls.length === 0,
    confidence: estimate.confidence,
    shortfalls,
  };
}
