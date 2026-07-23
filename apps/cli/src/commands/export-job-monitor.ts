import {
  isExportJobTerminal,
  type ExportJobEventReaderV1,
  type ExportJobEventV1,
  type ExportJobSnapshotV1,
  type ExportJobStore,
} from "@atlcli/export-jobs";

export const EXPORT_JOB_MONITOR_EVENT_SCHEMA_V1 = "atlcli.export-job-event/1" as const;

export interface ExportJobMonitorEventV1 {
  schema: typeof EXPORT_JOB_MONITOR_EVENT_SCHEMA_V1;
  jobId: string;
  observedAt: number;
  revision: number;
  kind: "snapshot" | "event";
  snapshot?: ExportJobSnapshotV1;
  event?: ExportJobEventV1;
}

export type ExportJobMonitorModeV1 = "tty" | "lines" | "jsonl";

export interface ExportJobMonitorWriterV1 {
  write(chunk: string): unknown;
}

export interface WatchExportJobOptionsV1 {
  jobs: ExportJobStore & ExportJobEventReaderV1;
  jobId: string;
  mode: ExportJobMonitorModeV1;
  writer: ExportJobMonitorWriterV1;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function progressText(snapshot: ExportJobSnapshotV1): string | undefined {
  const progress = snapshot.progress;
  if (!progress) return undefined;
  const total = progress.total === null ? "?" : String(progress.total);
  return `${progress.done}/${total}`;
}

/** One compact, stable status projection shared by TTY and non-TTY monitors. */
export function formatExportJobStatusLineV1(snapshot: ExportJobSnapshotV1): string {
  const fields = [
    `job=${snapshot.id}`,
    `state=${snapshot.state}`,
    `format=${snapshot.format}`,
    snapshot.stage ? `stage=${snapshot.stage}` : undefined,
    progressText(snapshot) ? `progress=${progressText(snapshot)}` : undefined,
    snapshot.waiting ? `waiting=${snapshot.waiting.reason}` : undefined,
    snapshot.error ? `error=${snapshot.error.code}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return fields.join(" ");
}

/** A redacted event line: event contracts contain codes and refs, never raw source bodies. */
export function formatExportJobEventLineV1(jobId: string, event: ExportJobEventV1): string {
  const detail = (() => {
    switch (event.kind) {
      case "state":
        return `${event.from}->${event.to}`;
      case "stage":
        return event.stage;
      case "progress": {
        const total = event.progress.total === null ? "?" : String(event.progress.total);
        return `${event.progress.stage} ${event.progress.done}/${total}`;
      }
      case "retry":
        return event.code;
      case "issue":
        return `${event.level} ${event.code}`;
      case "recovery":
        return `epoch=${event.leaseEpoch}`;
      case "artifact":
        return `${event.artifact.filename} ${event.artifact.byteLength}B`;
    }
  })();
  return `job=${jobId} event=${event.seq} kind=${event.kind} ${detail}`;
}

function jsonlRecord(
  snapshot: ExportJobSnapshotV1,
  observedAt: number,
  value: { kind: "snapshot"; snapshot: ExportJobSnapshotV1 } | { kind: "event"; event: ExportJobEventV1 },
): ExportJobMonitorEventV1 {
  return {
    schema: EXPORT_JOB_MONITOR_EVENT_SCHEMA_V1,
    jobId: snapshot.id,
    observedAt,
    revision: snapshot.revision,
    ...value,
  };
}

function writeJsonLine(writer: ExportJobMonitorWriterV1, value: unknown): void {
  writer.write(`${JSON.stringify(value)}\n`);
}

async function readEventPages(
  jobs: ExportJobEventReaderV1,
  jobId: string,
  afterSeq: number,
): Promise<{ events: ExportJobEventV1[]; nextAfterSeq: number }> {
  const events: ExportJobEventV1[] = [];
  let cursor = afterSeq;
  for (;;) {
    const page = await jobs.readEvents(jobId, { afterSeq: cursor, limit: 250 });
    events.push(...page.events);
    if (page.nextAfterSeq < cursor) {
      throw new Error(`Export job ${jobId} returned a regressing event cursor.`);
    }
    if (page.events.length === 0 && page.hasMore) {
      throw new Error(`Export job ${jobId} returned an empty event page with hasMore=true.`);
    }
    cursor = page.nextAfterSeq;
    if (!page.hasMore) return { events, nextAfterSeq: cursor };
  }
}

/**
 * Poll a durable job owned by this or another process. Snapshots are truth;
 * events provide bounded detail. A terminal row must remain stable for one
 * further poll so a terminal event committed immediately after its CAS is read.
 */
export async function watchExportJobV1(options: WatchExportJobOptionsV1): Promise<ExportJobSnapshotV1> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new RangeError("Export job poll interval must be a non-negative finite number.");
  }

  let eventCursor = 0;
  let lastRevision: number | undefined;
  let lastTtyWidth = 0;
  let stableTerminalRevision: number | undefined;

  for (;;) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException("Export job watch aborted.", "AbortError");
    }
    const snapshot = await options.jobs.get(options.jobId);
    if (!snapshot) throw new Error(`Export job not found: ${options.jobId}`);

    const revisionChanged = lastRevision !== snapshot.revision;
    if (revisionChanged) {
      if (options.mode === "jsonl") {
        writeJsonLine(options.writer, jsonlRecord(snapshot, now(), { kind: "snapshot", snapshot }));
      } else if (options.mode === "lines") {
        options.writer.write(`${formatExportJobStatusLineV1(snapshot)}\n`);
      }
      lastRevision = snapshot.revision;
    }

    const page = await readEventPages(options.jobs, options.jobId, eventCursor);
    eventCursor = page.nextAfterSeq;
    for (const event of page.events) {
      if (options.mode === "jsonl") {
        writeJsonLine(options.writer, jsonlRecord(snapshot, now(), { kind: "event", event }));
      } else if (options.mode === "lines") {
        options.writer.write(`${formatExportJobEventLineV1(snapshot.id, event)}\n`);
      }
    }

    if (options.mode === "tty" && (revisionChanged || page.events.length > 0)) {
      const line = formatExportJobStatusLineV1(snapshot);
      const padding = " ".repeat(Math.max(0, lastTtyWidth - line.length));
      options.writer.write(`\r${line}${padding}`);
      lastTtyWidth = line.length;
    }

    if (isExportJobTerminal(snapshot.state)) {
      if (
        stableTerminalRevision === snapshot.revision &&
        !revisionChanged &&
        page.events.length === 0
      ) {
        if (options.mode === "tty") options.writer.write("\n");
        return snapshot;
      }
      stableTerminalRevision = snapshot.revision;
    } else {
      stableTerminalRevision = undefined;
    }

    await sleep(pollIntervalMs);
  }
}
