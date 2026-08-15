import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  cleanupTombstonedExportJob,
  deriveExportJobReplayV1,
  isExportJobTerminal,
  type ExportArtifactStore,
  type ExportFormat,
  type ExportJobEventReaderV1,
  type ExportJobEventV1,
  type ExportJobRequestV1,
  type ExportJobSnapshotV1,
  type ExportJobState,
  type ExportJobStore,
  type ExportSpoolStore,
  type PdfTemplatePackReferenceV1,
  type TemplatePackStoreV1,
} from "@atlcli/export-jobs";
import {
  ERROR_CODES,
  fail,
  getFlag,
  getFlags,
  hasFlag,
  type OutputOptions,
} from "@atlcli/core";
import {
  formatExportJobEventLineV1,
  formatExportJobStatusLineV1,
  watchExportJobV1,
  type ExportJobMonitorWriterV1,
} from "./export-job-monitor.js";

export interface ExportJobPersistenceV1 {
  jobs: ExportJobStore & ExportJobEventReaderV1;
  spool: ExportSpoolStore;
  artifacts: ExportArtifactStore;
  templatePacks?: TemplatePackStoreV1;
  /** Reconcile stale process leases and prepared finalizations before every command. */
  reconcile(now: number): Promise<unknown>;
  /** Apply the shared payload/history retention policy while the CLI is alive. */
  retention?(now: number): Promise<unknown>;
}

interface RawExportJobPersistenceV1 {
  jobs: ExportJobStore;
  spool: ExportSpoolStore;
  artifacts: ExportArtifactStore;
  templatePacks?: TemplatePackStoreV1;
  reconcile?: (now: number) => Promise<unknown>;
  retention?: (now: number) => Promise<unknown>;
}

type PersistenceFactoryV1 = () => ExportJobPersistenceV1 | Promise<ExportJobPersistenceV1>;
type RawPersistenceFactoryV1 = () => RawExportJobPersistenceV1 | Promise<RawExportJobPersistenceV1>;

interface NodePersistenceModuleV1 {
  createNodeExportJobPersistenceV1?: RawPersistenceFactoryV1;
  createFileExportJobPersistence?: RawPersistenceFactoryV1;
  reconcileStaleExportJobs?: (
    jobs: ExportJobStore,
    stores: { spool: ExportSpoolStore; artifacts: ExportArtifactStore },
    now: number,
  ) => Promise<unknown>;
  sweepFileExportJobRetentionV1?: (
    persistence: RawExportJobPersistenceV1,
    now: number,
  ) => Promise<unknown>;
}

function hasEventReader(jobs: ExportJobStore): jobs is ExportJobStore & ExportJobEventReaderV1 {
  return typeof (jobs as Partial<ExportJobEventReaderV1>).readEvents === "function";
}

function requireEventReader(
  persistence: RawExportJobPersistenceV1,
): RawExportJobPersistenceV1 & { jobs: ExportJobStore & ExportJobEventReaderV1 } {
  if (hasEventReader(persistence.jobs)) {
    return persistence as RawExportJobPersistenceV1 & {
      jobs: ExportJobStore & ExportJobEventReaderV1;
    };
  }
  throw new Error("The Node export persistence does not provide a durable event reader.");
}

/**
 * Lazily load Node-only persistence. The preferred factory name is selected as
 * soon as it exists; the current file-factory fallback is contained here.
 */
export async function createDefaultExportJobPersistenceV1(): Promise<ExportJobPersistenceV1> {
  const node = (await import("@atlcli/export-node")) as unknown as NodePersistenceModuleV1;
  const factory = node.createNodeExportJobPersistenceV1 ?? node.createFileExportJobPersistence;
  if (!factory) throw new Error("@atlcli/export-node has no export-job persistence factory.");
  const persistence = requireEventReader(await factory());
  const reconcileStale = node.reconcileStaleExportJobs;
  if (!persistence.reconcile && !reconcileStale) {
    throw new Error("@atlcli/export-node has no stale export-job reconciliation hook.");
  }
  const reconcile = persistence.reconcile
    ? persistence.reconcile.bind(persistence)
    : (now: number) =>
        reconcileStale!(
          persistence.jobs,
          { spool: persistence.spool, artifacts: persistence.artifacts },
          now,
        );
  const retention = persistence.retention ??
    (node.sweepFileExportJobRetentionV1
      ? (at: number) => node.sweepFileExportJobRetentionV1!(persistence, at)
      : undefined);
  return { ...persistence, reconcile, ...(retention ? { retention } : {}) };
}

export interface ExportJobsCommandDependenciesV1 {
  createPersistence?: PersistenceFactoryV1;
  /** Production foreground runner; it owns progress and final report presentation when present. */
  executeReplay?: (
    request: ExportJobRequestV1,
    snapshot: ExportJobSnapshotV1,
  ) => Promise<void>;
  stdout?: ExportJobMonitorWriterV1;
  isTTY?: boolean;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  createId?: () => string;
  fail?: (message: string) => never;
}

const STATES: readonly ExportJobState[] = [
  "queued",
  "running",
  "waiting",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];
const FORMATS: readonly ExportFormat[] = ["docx", "pdf"];
const TERMINAL_STATES = new Set<ExportJobState>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

function commandHelp(): string {
  return `atlcli wiki export jobs <command>

Inspect and manage durable DOCX/PDF export activity.

Commands:
  list [--status <state>] [--format <fmt>] [--since <date>] [--json]
  show <id> [--json]
  watch <id> [--jsonl]
  cancel <id>
  resume <queued-id>
  retry <failed-id> [--output <path>] [--force]
  rerun <succeeded-id> [--output <path>] [--force]
  clear --before <duration> --confirm [--json]

Filters:
  --status   Comma-separated lifecycle states; may be repeated
  --format   docx or pdf; may be repeated
  --since    ISO date or relative duration such as 30m, 12h, or 7d

Watch polls the durable journal, including work owned by another process.
There is intentionally no --detach mode.`;
}

function write(writer: ExportJobMonitorWriterV1, value: string): void {
  writer.write(value.endsWith("\n") ? value : `${value}\n`);
}

function writeJson(writer: ExportJobMonitorWriterV1, value: unknown): void {
  writer.write(`${JSON.stringify(value, null, 2)}\n`);
}

function defaultFailure(opts: OutputOptions, message: string): never {
  return fail(opts, 1, ERROR_CODES.USAGE, message);
}

function flagValues(
  flags: Record<string, string | boolean | string[]>,
  key: string,
): string[] {
  return getFlags(flags, key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseEnumList<T extends string>(
  values: string[],
  allowed: readonly T[],
  label: string,
  failCommand: (message: string) => never,
): T[] | undefined {
  if (values.length === 0) return undefined;
  const invalid = values.filter((value) => !allowed.includes(value as T));
  if (invalid.length > 0) {
    failCommand(`Invalid ${label}: ${invalid.join(", ")}. Use ${allowed.join(", ")}.`);
  }
  return [...new Set(values as T[])];
}

function parseRelativeMilliseconds(value: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : unit === "d"
              ? 86_400_000
              : 604_800_000;
  const result = amount * multiplier;
  return Number.isSafeInteger(result) ? result : undefined;
}

function parseSince(
  value: string | undefined,
  now: number,
  failCommand: (message: string) => never,
): number | undefined {
  if (value === undefined) return undefined;
  const relative = parseRelativeMilliseconds(value);
  if (relative !== undefined) return now - relative;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) failCommand(`Invalid --since value: ${value}.`);
  return parsed;
}

function parseBefore(
  value: string | undefined,
  now: number,
  failCommand: (message: string) => never,
): number {
  if (value === undefined) failCommand("jobs clear requires --before <duration>.");
  const relative = parseRelativeMilliseconds(value);
  if (relative === undefined) {
    failCommand(`Invalid --before duration: ${value}. Use values such as 30m, 12h, or 7d.`);
  }
  return now - relative;
}

function stateRank(job: ExportJobSnapshotV1): number {
  if (job.state === "running" || job.state === "cancelling") return 0;
  if (job.state === "waiting") return 1;
  if (job.state === "queued") return 2;
  if (job.state === "succeeded" && job.acknowledgedAt === undefined) return 3;
  if (job.state === "failed" || job.state === "interrupted" || job.state === "cancelled") return 4;
  return 5;
}

function orderActivity(jobs: ExportJobSnapshotV1[]): ExportJobSnapshotV1[] {
  return [...jobs].sort(
    (left, right) =>
      stateRank(left) - stateRank(right) ||
      right.createdAt - left.createdAt ||
      right.id.localeCompare(left.id),
  );
}

async function requireJob(
  jobs: ExportJobStore,
  id: string | undefined,
  failCommand: (message: string) => never,
): Promise<ExportJobSnapshotV1> {
  if (!id) failCommand("An export job id is required.");
  const job = await jobs.get(id);
  if (!job) failCommand(`Export job not found: ${id}`);
  return job;
}

function isRevisionConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "revision-conflict"
  );
}

async function readAllEvents(
  jobs: ExportJobEventReaderV1,
  jobId: string,
): Promise<ExportJobEventV1[]> {
  const events: ExportJobEventV1[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await jobs.readEvents(jobId, { afterSeq, limit: 250 });
    events.push(...page.events);
    if (page.nextAfterSeq < afterSeq || (page.hasMore && page.events.length === 0)) {
      throw new Error(`Export job ${jobId} returned an invalid event page.`);
    }
    afterSeq = page.nextAfterSeq;
    if (!page.hasMore) return events;
  }
}

async function acknowledgeShownJob(
  jobs: ExportJobStore,
  initial: ExportJobSnapshotV1,
  now: () => number,
): Promise<ExportJobSnapshotV1> {
  let current = initial;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!isExportJobTerminal(current.state) || current.acknowledgedAt !== undefined) return current;
    try {
      return await jobs.acknowledge(current.id, current.revision, now());
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      const refreshed = await jobs.get(current.id);
      if (!refreshed) throw new Error(`Export job disappeared while acknowledging: ${current.id}`);
      current = refreshed;
    }
  }
  throw new Error(`Export job ${initial.id} changed repeatedly while acknowledging it.`);
}

async function listJobs(
  persistence: ExportJobPersistenceV1,
  flags: Record<string, string | boolean | string[]>,
  json: boolean,
  writer: ExportJobMonitorWriterV1,
  now: () => number,
  failCommand: (message: string) => never,
): Promise<void> {
  const states = parseEnumList(flagValues(flags, "status"), STATES, "--status", failCommand);
  const formats = parseEnumList(flagValues(flags, "format"), FORMATS, "--format", failCommand);
  const createdAfter = parseSince(getFlag(flags, "since"), now(), failCommand);
  const jobs = orderActivity(
    await persistence.jobs.list({
      ...(states ? { states } : {}),
      ...(formats ? { formats } : {}),
      ...(createdAfter !== undefined ? { createdAfter } : {}),
      limit: 500,
    }),
  );
  if (json) {
    writeJson(writer, { schema: "atlcli.export-jobs-list/1", jobs });
    return;
  }
  if (jobs.length === 0) {
    write(writer, "No export jobs found.");
    return;
  }
  for (const job of jobs) write(writer, formatExportJobStatusLineV1(job));
}

async function showJob(
  persistence: ExportJobPersistenceV1,
  id: string | undefined,
  json: boolean,
  writer: ExportJobMonitorWriterV1,
  now: () => number,
  failCommand: (message: string) => never,
): Promise<void> {
  const initial = await requireJob(persistence.jobs, id, failCommand);
  const job = await acknowledgeShownJob(persistence.jobs, initial, now);
  const [request, events] = await Promise.all([
    persistence.jobs.getRequest(job.requestRef),
    readAllEvents(persistence.jobs, job.id),
  ]);
  if (json) {
    writeJson(writer, { schema: "atlcli.export-job-detail/1", job, request, events });
    return;
  }
  write(writer, formatExportJobStatusLineV1(job));
  write(writer, `title=${job.summary.displayName} source=${job.summary.sourceLabel}`);
  write(
    writer,
    `pages=${job.stats.pages.fetched}/${job.stats.pages.discovered} assets=${job.stats.assets.embedded}/${job.stats.assets.discovered} warnings=${job.stats.warnings} errors=${job.stats.errors}`,
  );
  if (job.artifact) {
    write(writer, `artifact=${job.artifact.filename} bytes=${job.artifact.byteLength}`);
  }
  for (const event of events) write(writer, formatExportJobEventLineV1(job.id, event));
}

async function cancelJob(
  jobs: ExportJobStore,
  id: string | undefined,
  now: () => number,
  failCommand: (message: string) => never,
): Promise<ExportJobSnapshotV1> {
  let current = await requireJob(jobs, id, failCommand);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (current.state === "cancelling" || current.state === "cancelled") return current;
    if (TERMINAL_STATES.has(current.state)) {
      failCommand(`Export job ${current.id} is already ${current.state} and cannot be cancelled.`);
    }
    try {
      return await jobs.compareAndSet({
        kind: "transition",
        id: current.id,
        expectedRevision: current.revision,
        to: current.state === "running" ? "cancelling" : "cancelled",
        at: now(),
      });
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      const refreshed = await jobs.get(current.id);
      if (!refreshed) throw new Error(`Export job disappeared while cancelling: ${current.id}`);
      current = refreshed;
    }
  }
  throw new Error(`Export job ${current.id} changed repeatedly while cancellation was requested.`);
}

async function replayJob(
  persistence: ExportJobPersistenceV1,
  relation: "retry" | "rerun",
  id: string | undefined,
  flags: Record<string, string | boolean | string[]>,
  now: () => number,
  createId: () => string,
  failCommand: (message: string) => never,
): Promise<{ request: ExportJobRequestV1; snapshot: ExportJobSnapshotV1 }> {
  const origin = await requireJob(persistence.jobs, id, failCommand);
  const originRequest = await persistence.jobs.getRequest(origin.requestRef);
  if (!originRequest) throw new Error(`Export job ${origin.id} has no retained request.`);

  const outputPath = getFlag(flags, "output") ?? getFlag(flags, "o");
  if ((hasFlag(flags, "output") || hasFlag(flags, "o")) && !outputPath) {
    failCommand("--output requires a path.");
  }
  const outputOverride: ExportJobRequestV1["output"] | undefined = outputPath
      ? {
          policy: "path",
          targetRef: resolve(outputPath),
          targetKind: "file",
          overwriteExisting: hasFlag(flags, "force"),
        }
    : relation === "rerun"
      ? { ...originRequest.output, overwriteExisting: hasFlag(flags, "force") }
      : hasFlag(flags, "force")
        ? { ...originRequest.output, overwriteExisting: true }
        : undefined;
  const newJobId = createId();
  const existingDerived = (await persistence.jobs.list({ includeDismissed: true, limit: 500 })).filter(
    (candidate) =>
      candidate.derivedFrom?.jobId === origin.id && candidate.derivedFrom.relation === relation,
  );
  const existingDerivedRequests = (
    await Promise.all(
      existingDerived.map((candidate) => persistence.jobs.getRequest(candidate.requestRef)),
    )
  ).filter((request): request is ExportJobRequestV1 => request !== undefined);
  const derivation = deriveExportJobReplayV1({
    origin,
    originRequest,
    input: {
      relation,
      actionKey: `cli:${relation}:${newJobId}`,
      newJobId,
      newIdempotencyKey: `cli:${relation}:${newJobId}`,
      createdAt: now(),
      ...(outputOverride ? { outputOverride } : {}),
    },
    existingDerived,
    existingDerivedRequests,
  });
  if (derivation.kind === "not-allowed") {
    failCommand(`Cannot ${relation === "retry" ? "retry" : "rerun"} a ${origin.state} export job.`);
  }
  if (derivation.kind === "existing") {
    const existingRequest = await persistence.jobs.getRequest(derivation.snapshot.requestRef);
    if (!existingRequest) {
      throw new Error(`Derived export job ${derivation.snapshot.id} has no retained request.`);
    }
    return { request: existingRequest, snapshot: derivation.snapshot };
  }
  const packReference: PdfTemplatePackReferenceV1 | undefined =
    derivation.request.format === "pdf" && derivation.request.template.kind === "pack"
      ? derivation.request.template
      : undefined;
  if (packReference) {
    if (!persistence.templatePacks) {
      throw new Error("This host has no durable PDF template-pack store.");
    }
    await persistence.templatePacks.verify(packReference);
  }
  const snapshot = await persistence.jobs.create({
    request: derivation.request,
    derivedFrom: derivation.derivedFrom,
  });
  if (packReference) {
    await persistence.templatePacks!.link({
      jobId: snapshot.id,
      requestRef: snapshot.requestRef,
      recordKey: packReference.recordKey,
      archiveSha256: packReference.archiveSha256,
      at: now(),
    });
  }
  return { request: derivation.request, snapshot };
}

async function resumableJob(
  persistence: ExportJobPersistenceV1,
  id: string | undefined,
  failCommand: (message: string) => never,
): Promise<{ request: ExportJobRequestV1; snapshot: ExportJobSnapshotV1 }> {
  const snapshot = await requireJob(persistence.jobs, id, failCommand);
  if (snapshot.state !== "queued") {
    failCommand(`Cannot resume a ${snapshot.state} export job; Resume requires queued work.`);
  }
  const request = await persistence.jobs.getRequest(snapshot.requestRef);
  if (!request) throw new Error(`Export job ${snapshot.id} has no retained request.`);
  return { request, snapshot };
}

async function interruptUnstartedForegroundJob(
  jobs: ExportJobStore,
  id: string,
  error: unknown,
  now: () => number,
): Promise<void> {
  const current = await jobs.get(id);
  if (current?.state !== "queued") return;
  const interruptedAt = Math.max(now(), current.createdAt);
  await jobs.compareAndSet({
    kind: "transition",
    id: current.id,
    expectedRevision: current.revision,
    to: "interrupted",
    at: interruptedAt,
    error: {
      code: "host.replay-start-failed",
      message: error instanceof Error ? error.message : String(error),
      category: "unknown",
      retryable: true,
      occurredAt: interruptedAt,
    },
  });
}

async function clearJobs(
  persistence: ExportJobPersistenceV1,
  flags: Record<string, string | boolean | string[]>,
  now: () => number,
  failCommand: (message: string) => never,
): Promise<{ deletedJobIds: string[]; cleanedBytes: number }> {
  if (!hasFlag(flags, "confirm")) failCommand("Use --confirm to clear export jobs.");
  const finishedBefore = parseBefore(getFlag(flags, "before"), now(), failCommand);
  const deletedJobIds: string[] = [];
  let cleanedBytes = 0;

  for (;;) {
    const deletion = await persistence.jobs.deleteTerminal({ finishedBefore, limit: 500 });
    if (deletion.deletedJobIds.length === 0) break;
    for (const jobId of deletion.deletedJobIds) {
      const tombstone = await persistence.jobs.getTombstone(jobId);
      if (!tombstone) throw new Error(`Deletion tombstone missing for export job ${jobId}.`);
      const cleanup = await cleanupTombstonedExportJob(
        { spool: persistence.spool, artifacts: persistence.artifacts },
        tombstone,
      );
      await persistence.jobs.markTombstoneCleanupComplete(jobId, tombstone.ref, now());
      cleanedBytes += cleanup.bytesDeleted;
      deletedJobIds.push(jobId);
    }
  }
  return { deletedJobIds, cleanedBytes };
}

export async function handleExportJobs(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
  dependencies: ExportJobsCommandDependenciesV1 = {},
): Promise<void> {
  const stdout = dependencies.stdout ?? process.stdout;
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? randomUUID;
  const failCommand = dependencies.fail ?? ((message: string) => defaultFailure(opts, message));
  const subcommand = args[0];

  if (!subcommand || hasFlag(flags, "help") || hasFlag(flags, "h")) {
    write(stdout, commandHelp());
    return;
  }
  if (hasFlag(flags, "detach")) {
    failCommand("--detach is not supported; use jobs watch from another process.");
  }
  if (hasFlag(flags, "json") && hasFlag(flags, "jsonl")) {
    failCommand("Use either --json or --jsonl, not both.");
  }
  if (hasFlag(flags, "jsonl") && subcommand !== "watch") {
    failCommand("--jsonl is supported only by jobs watch.");
  }
  const commands = new Set([
    "list",
    "show",
    "watch",
    "cancel",
    "resume",
    "retry",
    "rerun",
    "clear",
  ]);
  if (!commands.has(subcommand)) failCommand(`Unknown export jobs command: ${subcommand}`);

  const createPersistence = dependencies.createPersistence ?? createDefaultExportJobPersistenceV1;
  const persistence = await createPersistence();
  await persistence.reconcile(now());
  await persistence.retention?.(now());
  const json = opts.json || hasFlag(flags, "json");

  switch (subcommand) {
    case "list":
      await listJobs(persistence, flags, json, stdout, now, failCommand);
      return;
    case "show":
      await showJob(persistence, args[1], json, stdout, now, failCommand);
      return;
    case "watch": {
      const job = await requireJob(persistence.jobs, args[1], failCommand);
      const mode = hasFlag(flags, "jsonl")
        ? "jsonl"
        : (dependencies.isTTY ?? process.stdout.isTTY)
          ? "tty"
          : "lines";
      await watchExportJobV1({
        jobs: persistence.jobs,
        jobId: job.id,
        mode,
        writer: stdout,
        now,
        ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
      });
      return;
    }
    case "cancel": {
      const job = await cancelJob(persistence.jobs, args[1], now, failCommand);
      if (json) writeJson(stdout, { schema: "atlcli.export-job-action/1", action: "cancel", job });
      else write(stdout, formatExportJobStatusLineV1(job));
      return;
    }
    case "resume": {
      const resumed = await resumableJob(persistence, args[1], failCommand);
      const executeReplay = dependencies.executeReplay;
      if (!executeReplay) {
        return failCommand("This host has no foreground export runner for Resume.");
      }
      try {
        await executeReplay(resumed.request, resumed.snapshot);
      } catch (error) {
        await interruptUnstartedForegroundJob(
          persistence.jobs,
          resumed.snapshot.id,
          error,
          now,
        );
        throw error;
      }
      return;
    }
    case "retry":
    case "rerun": {
      const replay = await replayJob(
        persistence,
        subcommand,
        args[1],
        flags,
        now,
        createId,
        failCommand,
      );
      if (dependencies.executeReplay) {
        try {
          await dependencies.executeReplay(replay.request, replay.snapshot);
        } catch (error) {
          // A replay is durable before host auth/template preflight. If that
          // preflight cannot even start the exact-id runner, do not leave a
          // permanently queued row that no daemon will ever claim.
          await interruptUnstartedForegroundJob(
            persistence.jobs,
            replay.snapshot.id,
            error,
            now,
          );
          throw error;
        }
        return;
      }
      if (json) {
        writeJson(stdout, {
          schema: "atlcli.export-job-action/1",
          action: subcommand,
          job: replay.snapshot,
        });
      } else {
        write(
          stdout,
          `${subcommand === "retry" ? "Retry" : "Run again"} queued: ${replay.snapshot.id}`,
        );
      }
      return;
    }
    case "clear": {
      const result = await clearJobs(persistence, flags, now, failCommand);
      if (json) writeJson(stdout, { schema: "atlcli.export-job-clear/1", ...result });
      else write(stdout, `Cleared ${result.deletedJobIds.length} export job(s), ${result.cleanedBytes} byte(s).`);
      return;
    }
    default:
      failCommand(`Unknown export jobs command: ${subcommand}`);
  }
}
