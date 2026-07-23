import {
  createEmptyExportJobStatsV1,
  projectExportActivityV1,
  type ExportJobSnapshotV1,
  type ExportJobState,
} from "@atlcli/export-jobs";

function snapshot(
  id: string,
  state: ExportJobState,
  options: {
    format?: "pdf" | "docx";
    site?: string;
    group?: string;
    enqueuedAt?: number;
    createdAt?: number;
    priority?: "interactive" | "retry";
    acknowledgedAt?: number;
    waiting?: ExportJobSnapshotV1["waiting"];
  } = {},
): ExportJobSnapshotV1 {
  const format = options.format ?? "pdf";
  const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(
    state,
  );
  return {
    schema: "atlcli.export-job/1",
    id,
    revision: 0,
    requestRef: `request:${id}`,
    format,
    renderer: format === "pdf" ? "pdf-typst" : "docx-typescript",
    summary: {
      displayName: `Activity ${id}`,
      sourceLabel: "Browser conformance",
      siteOrigin: options.site ?? "https://a.atlassian.net",
      scopeKind: "page",
    },
    queue: {
      priority: options.priority ?? "interactive",
      enqueuedAt: options.enqueuedAt ?? 1,
      groupKey: options.group ?? "site-a",
    },
    state,
    ...(state === "waiting"
      ? {
          waiting: options.waiting ?? { reason: "auth" },
          checkpointRef: `checkpoint:${id}`,
        }
      : {}),
    attempt: state === "queued" ? 0 : 1,
    recoveryCount: 0,
    leaseEpoch: state === "queued" ? 0 : 1,
    stats: createEmptyExportJobStatsV1(),
    createdAt: options.createdAt ?? 1,
    ...(terminal ? { finishedAt: 20 } : {}),
    ...(state === "failed" || state === "interrupted"
      ? {
          error: {
            code: "browser-case-failure",
            message: "synthetic failure",
            category: "render" as const,
            retryable: true,
            occurredAt: 20,
          },
        }
      : {}),
    ...(state === "cancelled" ? { cancelRequestedAt: 19 } : {}),
    ...(options.acknowledgedAt === undefined
      ? {}
      : { acknowledgedAt: options.acknowledgedAt }),
  };
}

/**
 * Contract-only generic-browser proof: the same Activity and fair queue
 * projection used by the extension runs in an ordinary Vite page.
 */
export async function runActivityMonitorCase(): Promise<unknown> {
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  for (const forbidden of ["Buffer", "process", "chrome", "browser"]) {
    if (globals[forbidden] !== undefined) {
      throw new Error(`generic Activity imported forbidden global ${forbidden}`);
    }
  }

  const snapshots = [
    snapshot("acknowledged", "failed", {
      createdAt: 100,
      acknowledgedAt: 101,
    }),
    snapshot("failure", "failed", { createdAt: 90 }),
    snapshot("a-2", "queued", {
      enqueuedAt: 2,
      createdAt: 80,
    }),
    snapshot("retry", "queued", {
      group: "site-c",
      enqueuedAt: 0,
      priority: "retry",
      createdAt: 70,
    }),
    snapshot("b-1", "queued", {
      format: "docx",
      site: "https://b.atlassian.net",
      group: "site-b",
      enqueuedAt: 3,
      createdAt: 60,
    }),
    snapshot("a-1", "queued", {
      enqueuedAt: 1,
      createdAt: 50,
    }),
    snapshot("waiting-auth", "waiting", {
      waiting: { reason: "auth" },
      createdAt: 40,
    }),
    snapshot("running", "running", { createdAt: 30 }),
  ];

  const rows = projectExportActivityV1(snapshots);
  const order = rows.map((row) => row.id);
  const expectedOrder = [
    "running",
    "waiting-auth",
    "a-1",
    "b-1",
    "a-2",
    "retry",
    "failure",
    "acknowledged",
  ];
  if (JSON.stringify(order) !== JSON.stringify(expectedOrder)) {
    throw new Error(`unexpected Activity order: ${JSON.stringify(order)}`);
  }

  const queue = Object.fromEntries(
    rows
      .filter((row) => row.state === "queued")
      .map((row) => [row.id, row.queueProjection]),
  );
  const expectedQueue = {
    "a-1": { kind: "estimated", position: 1 },
    "b-1": { kind: "estimated", position: 2 },
    "a-2": { kind: "estimated", position: 3 },
    retry: { kind: "estimated", position: 4 },
  };
  if (JSON.stringify(queue) !== JSON.stringify(expectedQueue)) {
    throw new Error(`unexpected queue projection: ${JSON.stringify(queue)}`);
  }

  const waiting = rows.find((row) => row.id === "waiting-auth");
  if (
    waiting?.queueProjection?.kind !== "waiting" ||
    waiting.queueProjection.reason !== "auth" ||
    waiting.actions.resume !== true
  ) {
    throw new Error("waiting/auth row lost its named blocker or Resume action");
  }

  const filtered = projectExportActivityV1(snapshots, {
    formats: ["docx"],
    queuePositionKind: "exact",
  });
  if (
    filtered.length !== 1 ||
    filtered[0]?.id !== "b-1" ||
    filtered[0].queueProjection?.kind !== "exact" ||
    filtered[0].queueProjection.position !== 2
  ) {
    throw new Error(
      `filtered monitor lost global exact position: ${JSON.stringify(filtered)}`,
    );
  }

  return {
    order,
    queue,
    waiting: waiting.queueProjection,
    filteredPosition: filtered[0].queueProjection,
    forbiddenGlobalsAbsent: true,
  };
}
