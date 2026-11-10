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
