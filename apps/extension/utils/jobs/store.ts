/**
 * Format-neutral Activity port for durable browser exports.
 *
 * Common DOCX/PDF jobs are projected directly from `ExportJobSnapshotV1`.
 * Legacy PDF records remain a read/action compatibility source for one
 * retention window, but they no longer define the UI model.
 */
import {
  deriveExportJobReplayV1,
  isExportJobTerminal,
  type ExportJobEventV1,
  type ExportJobRequestV1,
  type ExportJobReplayRelationV1,
  type ExportJobState,
} from "@atlcli/export-jobs";
import {
  cancelPdfJob,
  deletePdfJob,
  getPdfJob,
  listPdfJobMeta,
  markPdfJobConsumed,
  type StoredPdfJobMeta,
} from "../pdf/job-store.js";
import {
  commonExportActivityRow,
  legacyPdfActivityRow,
  listExtensionExportActivity,
  type ExtensionExportActivityRowV1,
} from "../export-jobs/activity.js";
import { IndexedDbExportJobCatalog } from "../export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../export-jobs/chunk-store.js";

export type ExportActivityJob = ExtensionExportActivityRowV1;

export interface ExportActivityReportIssue {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  source?: string;
}

export interface ExportActivityDetail {
  job: ExportActivityJob;
  events: ExportJobEventV1[];
  request: {
    availability: "retained" | "expired" | "unsupported";
    renderer?: string;
    template?: string;
    fingerprint?: string;
  };
  report: {
    availability: "retained" | "expired" | "not-produced" | "unsupported";
    issues: ExportActivityReportIssue[];
    facts: Array<{ label: string; value: string }>;
  };
}

export interface ExportActivityListOptions {
  /** Omit to include all sites. */
  siteOrigin?: string;
  formats?: Array<"pdf" | "docx">;
  states?: ExportJobState[];
  createdAfter?: number;
}

export interface DurableJobsPort {
  list(options?: ExportActivityListOptions): Promise<ExportActivityJob[]>;
  detail(route: string): Promise<ExportActivityDetail | undefined>;
  cancel(route: string): Promise<void>;
  retry(route: string, actionKey: string): Promise<string | undefined>;
  rerun(route: string, actionKey: string): Promise<string | undefined>;
  /** Resume the same checkpointed waiting/auth job after the user signs in. */
  resume(route: string): Promise<boolean>;
  acknowledge(route: string): Promise<void>;
  dismiss(route: string): Promise<void>;
  download(route: string): Promise<boolean>;
}

export interface DurableJobsDeps {
  list: typeof listPdfJobMeta;
  read: typeof getPdfJob;
  cancelJob: typeof cancelPdfJob;
  deleteJob: typeof deletePdfJob;
  consume: typeof markPdfJobConsumed;
  requestCancel: (jobId: string) => Promise<void>;
  emit: (filename: string, bytes: Uint8Array) => Promise<void>;
}

function legacyJobId(route: string): string {
  return route.startsWith("legacy-pdf:") ? route.slice("legacy-pdf:".length) : route;
}

function matchesListOptions(
  job: ExportActivityJob,
  options: ExportActivityListOptions,
): boolean {
  return (
    (options.siteOrigin === undefined || job.siteOrigin === options.siteOrigin) &&
    (!options.formats || options.formats.includes(job.format)) &&
    (!options.states || options.states.includes(job.state)) &&
    (options.createdAfter === undefined || job.createdAt > options.createdAfter)
  );
}

/**
 * Compatibility adapter for pre-common PDF rows.
 *
 * Retry/Run-again cannot be truthful because the legacy record did not retain
 * a replay-safe common request. Those actions are therefore unavailable.
 */
export function createDurableJobsStore(deps: DurableJobsDeps): DurableJobsPort {
  return {
    async list(options = {}): Promise<ExportActivityJob[]> {
      return (await deps.list())
        .filter((meta) => meta.activityVisibility !== "private")
        .filter((meta) => (meta.kind ?? "export") === "export")
        .map(legacyPdfActivityRow)
        .filter((job) => matchesListOptions(job, options));
    },

    async detail(route: string): Promise<ExportActivityDetail | undefined> {
      const job = (await this.list()).find(
        (candidate) => candidate.key === `legacy-pdf:${legacyJobId(route)}`,
      );
      if (!job) return undefined;
      return {
        job,
        events: [],
        request: { availability: "unsupported" },
        report: {
          availability: "unsupported",
          issues: job.error
            ? [
                {
                  level: "error",
                  code: job.error.code,
                  message: job.error.message,
                },
              ]
            : [],
          facts: [],
        },
      };
    },

    async cancel(route: string): Promise<void> {
      const id = legacyJobId(route);
      await deps.requestCancel(id).catch(() => undefined);
      await deps.cancelJob(id).catch(() => undefined);
    },

    async retry(): Promise<undefined> {
      return undefined;
    },

    async rerun(): Promise<undefined> {
      return undefined;
    },

    async resume(): Promise<boolean> {
      return false;
    },

    async acknowledge(): Promise<void> {
      // Legacy rows have no non-destructive acknowledgement field.
    },

    async dismiss(route: string): Promise<void> {
      await deps.deleteJob(legacyJobId(route));
    },

    async download(route: string): Promise<boolean> {
      const id = legacyJobId(route);
      const job = await deps.read(id, undefined, { bundle: false, pdf: true });
      if (!job?.pdf || job.status !== "complete") return false;
      await deps.emit(job.filename ?? `${job.title ?? "export"}.pdf`, job.pdf);
      await deps.consume(id).catch(() => undefined);
      await deps.deleteJob(id).catch(() => undefined);
      return true;
    },
  };
}

export interface ExtensionDurableJobsDeps {
  catalog: IndexedDbExportJobCatalog;
  bytes: IndexedDbExportByteStore;
  legacy: DurableJobsPort;
  listLegacyPdf?: () => Promise<StoredPdfJobMeta[]>;
  emit: (filename: string, bytes: Uint8Array, mimeType: string) => Promise<void>;
  wake?: (
    jobIds: string[],
    options?: { resumeWaiting?: boolean },
  ) => Promise<{ claimedJobId?: string; error?: string }>;
  readReport?: (
    format: "pdf" | "docx",
    reportRef: string,
  ) => Promise<unknown | undefined>;
  randomUUID?: () => string;
  now?: () => number;
}

function splitActivityRoute(route: string): {
  source: "common" | "legacy-pdf";
  jobId: string;
} {
  const separator = route.indexOf(":");
  const source = route.slice(0, separator);
  const jobId = route.slice(separator + 1);
  if (
    (source !== "common" && source !== "legacy-pdf") ||
    separator < 1 ||
    jobId.length === 0
  ) {
    throw new TypeError("Activity action requires a namespaced job id.");
  }
  return { source, jobId };
}

async function collectBytes(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function assertActionKey(actionKey: string): void {
  if (actionKey.trim().length === 0 || actionKey.length > 4_096) {
    throw new TypeError("Activity replay requires a non-empty bounded action key.");
  }
}

function reportSource(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const parts = [
    typeof source.pageTitle === "string" ? source.pageTitle : undefined,
    typeof source.pageId === "string" ? `page ${source.pageId}` : undefined,
    typeof source.blockId === "string" ? `block ${source.blockId}` : undefined,
    typeof source.assetRef === "string" ? source.assetRef : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function normalizeReport(report: unknown): {
  issues: ExportActivityReportIssue[];
  facts: Array<{ label: string; value: string }>;
} {
  if (!report || typeof report !== "object") return { issues: [], facts: [] };
  const value = report as Record<string, unknown>;
  const issues: ExportActivityReportIssue[] = [];
  if (Array.isArray(value.notes)) {
    for (const note of value.notes) {
      if (!note || typeof note !== "object") continue;
      const entry = note as Record<string, unknown>;
      if (
        (entry.level !== "info" && entry.level !== "warning") ||
        typeof entry.code !== "string" ||
        typeof entry.message !== "string"
      ) {
        continue;
      }
      const source = reportSource(entry.source);
      issues.push({
        level: entry.level,
        code: entry.code,
        message: entry.message,
        ...(source ? { source } : {}),
      });
    }
  }
  if (Array.isArray(value.compilerDiagnostics)) {
    for (const diagnostic of value.compilerDiagnostics) {
      if (!diagnostic || typeof diagnostic !== "object") continue;
      const entry = diagnostic as Record<string, unknown>;
      if (
        (entry.severity !== "warning" && entry.severity !== "error") ||
        typeof entry.message !== "string"
      ) {
        continue;
      }
      issues.push({
        level: entry.severity,
        code: "compiler-diagnostic",
        message: entry.message,
        ...(typeof entry.path === "string" ? { source: entry.path } : {}),
      });
    }
  }
  const factFields: Array<[string, string]> = [
    ["compilerVersion", "Compiler"],
    ["pageCount", "PDF pages"],
    ["embeddedImages", "Embedded images"],
    ["renderedDiagrams", "Rendered diagrams"],
    ["skippedAssets", "Skipped assets"],
    ["resolvedCount", "Resolved placeholders"],
    ["skippedImages", "Skipped images"],
    ["durationMs", "Engine duration (ms)"],
  ];
  const facts = factFields.flatMap(([key, label]) => {
    const fact = value[key];
    return typeof fact === "string" || typeof fact === "number"
      ? [{ label, value: String(fact) }]
      : [];
  });
  return { issues, facts };
}

function requestSummary(
  request: ExportJobRequestV1 | undefined,
): ExportActivityDetail["request"] {
  if (!request) return { availability: "expired" };
  return request.format === "docx"
    ? {
        availability: "retained",
        renderer: request.renderer,
        template: request.template.name,
        fingerprint: request.template.sha256,
      }
    : {
        availability: "retained",
        renderer: request.renderer,
        template: request.template.id,
        fingerprint: `${request.template.id}@${request.template.manifestVersion}`,
      };
}

async function readAllEvents(
  catalog: IndexedDbExportJobCatalog,
  jobId: string,
): Promise<ExportJobEventV1[]> {
  const events: ExportJobEventV1[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await catalog.readEvents(jobId, { afterSeq, limit: 100 });
    events.push(...page.events);
    if (!page.hasMore) return events;
    if (page.nextAfterSeq <= afterSeq) {
      throw new Error(`Activity event cursor stalled for export ${jobId}.`);
    }
    afterSeq = page.nextAfterSeq;
  }
}

async function updateTerminalMetadata(
  catalog: IndexedDbExportJobCatalog,
  jobId: string,
  operation: "acknowledge" | "dismiss" | "deliver",
  at: number,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await catalog.get(jobId);
    if (!current || !isExportJobTerminal(current.state)) return;
    if (operation === "acknowledge" && current.acknowledgedAt !== undefined) return;
    if (operation === "dismiss" && current.dismissedAt !== undefined) return;
    if (operation === "deliver" && current.deliveredAt !== undefined) return;
    try {
      await catalog[operation](jobId, current.revision, at);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

/** Productive Activity port over common snapshots plus the temporary legacy reader. */
export function createExtensionDurableJobsStore(
  deps: ExtensionDurableJobsDeps,
): DurableJobsPort {
  const now = deps.now ?? Date.now;
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());

  const replay = async (
    route: string,
    relation: ExportJobReplayRelationV1,
    actionKey: string,
  ): Promise<string | undefined> => {
    const { source, jobId } = splitActivityRoute(route);
    if (source === "legacy-pdf") {
      return relation === "retry"
        ? deps.legacy.retry(route, actionKey)
        : deps.legacy.rerun(route, actionKey);
    }
    assertActionKey(actionKey);
    const origin = await deps.catalog.get(jobId);
    if (!origin) return undefined;
    const originRequest = await deps.catalog.getRequest(origin.requestRef);
    if (!originRequest) {
      throw new Error(`Retained request for export ${jobId} is unavailable.`);
    }

    const candidates = (await deps.catalog.list({
      includeDismissed: true,
      limit: 500,
    })).filter(
      (candidate) =>
        candidate.derivedFrom?.jobId === origin.id &&
        candidate.derivedFrom.relation === relation,
    );
    const candidateRequests = (
      await Promise.all(
        candidates.map((candidate) =>
          deps.catalog.getRequest(candidate.requestRef),
        ),
      )
    ).filter((request): request is NonNullable<typeof request> => request !== undefined);
    const id = randomUUID();
    const derivation = deriveExportJobReplayV1({
      origin,
      originRequest,
      input: {
        relation,
        actionKey,
        newJobId: id,
        newIdempotencyKey: `extension:${relation}:${id}`,
        createdAt: now(),
      },
      existingDerived: candidates,
      existingDerivedRequests: candidateRequests,
    });
    if (derivation.kind === "not-allowed") {
      throw new Error(
        `${relation === "retry" ? "Retry" : "Run again"} is unavailable for a ${origin.state} export.`,
      );
    }
    const snapshot =
      derivation.kind === "existing"
        ? derivation.snapshot
        : await deps.catalog.create({
            request: derivation.request,
            derivedFrom: derivation.derivedFrom,
          });
    await deps.wake?.([snapshot.id]).catch(() => undefined);
    return `common:${snapshot.id}`;
  };

  return {
    async list(options = {}): Promise<ExportActivityJob[]> {
      return (
        await listExtensionExportActivity({
          listCommon: deps.catalog.list.bind(deps.catalog),
          listLegacyPdf: deps.listLegacyPdf ?? listPdfJobMeta,
          listLegacyBridges: deps.catalog.listLegacyBridges.bind(deps.catalog),
        })
      ).filter((job) => matchesListOptions(job, options));
    },

    async detail(route: string): Promise<ExportActivityDetail | undefined> {
      const { source, jobId } = splitActivityRoute(route);
      if (source === "legacy-pdf") return deps.legacy.detail(route);
      let snapshot = await deps.catalog.get(jobId);
      if (!snapshot) return undefined;
      const [request, events, reportValue] = await Promise.all([
        deps.catalog.getRequest(snapshot.requestRef),
        readAllEvents(deps.catalog, jobId),
        snapshot.reportRef && deps.readReport
          ? deps.readReport(snapshot.format, snapshot.reportRef)
          : Promise.resolve(undefined),
      ]);
      if (isExportJobTerminal(snapshot.state) && snapshot.acknowledgedAt === undefined) {
        await updateTerminalMetadata(deps.catalog, jobId, "acknowledge", now());
        snapshot = (await deps.catalog.get(jobId)) ?? snapshot;
      }
      const reportAvailability =
        snapshot.reportRef === undefined
          ? "not-produced"
          : reportValue === undefined
            ? "expired"
            : "retained";
      const normalized = normalizeReport(reportValue);
      return {
        job: commonExportActivityRow(snapshot),
        events,
        request: requestSummary(request),
        report: {
          availability: reportAvailability,
          issues: normalized.issues,
          facts: normalized.facts,
        },
      };
    },

    async cancel(route: string): Promise<void> {
      const { source, jobId } = splitActivityRoute(route);
      if (source === "legacy-pdf") return deps.legacy.cancel(route);
      const current = await deps.catalog.get(jobId);
      if (
        !current ||
        ["succeeded", "failed", "cancelled", "interrupted", "cancelling"].includes(
          current.state,
        )
      ) {
        return;
      }
      await deps.catalog.compareAndSet({
        id: jobId,
        kind: "transition",
        expectedRevision: current.revision,
        to: current.state === "running" ? "cancelling" : "cancelled",
        at: now(),
      });
    },

    retry: (route, actionKey) => replay(route, "retry", actionKey),
    rerun: (route, actionKey) => replay(route, "rerun", actionKey),

    async resume(route: string): Promise<boolean> {
      const { source, jobId } = splitActivityRoute(route);
      if (source === "legacy-pdf") return deps.legacy.resume(route);
      const current = await deps.catalog.get(jobId);
      if (
        current?.state !== "waiting" ||
        current.waiting?.reason !== "auth" ||
        !deps.wake
      ) {
        return false;
      }
      const result = await deps.wake([jobId], { resumeWaiting: true });
      return result.error === undefined;
    },

    async acknowledge(route: string): Promise<void> {
      const { source, jobId } = splitActivityRoute(route);
      if (source === "legacy-pdf") return deps.legacy.acknowledge(route);
      await updateTerminalMetadata(deps.catalog, jobId, "acknowledge", now());
    },

    async dismiss(route: string): Promise<void> {
      const { source, jobId } = splitActivityRoute(route);
      if (source === "legacy-pdf") return deps.legacy.dismiss(route);
      await updateTerminalMetadata(deps.catalog, jobId, "dismiss", now());
    },

    async download(route: string): Promise<boolean> {
      const { source, jobId } = splitActivityRoute(route);
      if (source === "legacy-pdf") return deps.legacy.download(route);
      const current = await deps.catalog.get(jobId);
      if (current?.state !== "succeeded" || !current.artifact) return false;
      const bytes = await collectBytes(deps.bytes.read(current.artifact.ref));
      await deps.emit(
        current.artifact.filename,
        bytes,
        current.artifact.mediaType,
      );
      await updateTerminalMetadata(deps.catalog, jobId, "deliver", now());
      return true;
    },
  };
}

/** Lazy Chrome binding. Artifact bytes remain in IndexedDB until Download. */
export function chromeDurableJobsStore(): DurableJobsPort {
  const legacy = createDurableJobsStore({
    list: listPdfJobMeta,
    read: getPdfJob,
    cancelJob: cancelPdfJob,
    deleteJob: deletePdfJob,
    consume: markPdfJobConsumed,
    requestCancel: async (jobId) => {
      await chrome.runtime.sendMessage({ kind: "pdf:cancel", jobId });
    },
    emit: async (filename, bytes) => {
      const { downloadBytes } = await import("../download.js");
      await downloadBytes({
        name: filename,
        bytes,
        mimeType: "application/pdf",
      });
    },
  });
  return createExtensionDurableJobsStore({
    catalog: new IndexedDbExportJobCatalog(),
    bytes: new IndexedDbExportByteStore(),
    legacy,
    readReport: async (format, reportRef) => {
      if (format === "docx") {
        const { readExtensionDocxExportReport } = await import(
          "../export-jobs/docx-executor-store.js"
        );
        return readExtensionDocxExportReport(reportRef);
      }
      const { readExtensionPdfExportReport } = await import(
        "../export-jobs/executor-store.js"
      );
      return readExtensionPdfExportReport(reportRef);
    },
    wake: async (jobIds, options) => {
      const response = (await chrome.runtime.sendMessage({
        kind: "jobs:wake",
        jobIds,
        ...(options?.resumeWaiting ? { resumeWaiting: true } : {}),
      })) as
        | {
            kind?: string;
            claimedJobId?: string;
            error?: string;
          }
        | undefined;
      if (response?.kind !== "jobs:wake-result") {
        return { error: "Background export queue returned no result." };
      }
      return response.error === undefined
        ? {
            ...(response.claimedJobId
              ? { claimedJobId: response.claimedJobId }
              : {}),
          }
        : { error: response.error };
    },
    emit: async (filename, bytes, mimeType) => {
      const { downloadBytes } = await import("../download.js");
      await downloadBytes({ name: filename, bytes, mimeType });
    },
  });
}
