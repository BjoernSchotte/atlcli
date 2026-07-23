import {
  isExportJobTerminal,
  type ExportJobSnapshotV1,
  type ExportJobStage,
  type ExportJobState,
} from "@atlcli/export-jobs";
import type { StoredPdfJobMeta } from "../pdf/job-store.js";
import { siteOriginFromSourceIdentity } from "../jobs/model.js";
import type { IndexedDbExportJobCatalog, LegacyPdfBridgeV1 } from "./catalog.js";

export interface ExtensionExportActivityActionsV1 {
  cancel: boolean;
  retry: boolean;
  rerun: boolean;
  resume: boolean;
  download: boolean;
  acknowledge: boolean;
  dismiss: boolean;
  detail: boolean;
}

export interface ExtensionExportActivityRowV1 {
  key: `common:${string}` | `legacy-pdf:${string}`;
  source: "common" | "legacy-pdf";
  id: string;
  format: "pdf" | "docx";
  state: ExportJobState;
  stage?: ExportJobStage;
  displayName: string;
  sourceLabel: string;
  siteOrigin: string | null;
  profileLabel?: string;
  scopeKind: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
  waiting?: ExportJobSnapshotV1["waiting"];
  progress?: ExportJobSnapshotV1["progress"];
  queue?: ExportJobSnapshotV1["queue"];
  attempt: number;
  recoveryCount: number;
  stats: ExportJobSnapshotV1["stats"] | null;
  reportSummary?: ExportJobSnapshotV1["reportSummary"];
  reportRef?: string;
  artifact?: ExportJobSnapshotV1["artifact"];
  derivedFrom?: ExportJobSnapshotV1["derivedFrom"];
  bytes: number;
  error?: ExportJobSnapshotV1["error"];
  unread: boolean;
  actions: ExtensionExportActivityActionsV1;
}

export interface ExtensionExportActivityDeps {
  listCommon: IndexedDbExportJobCatalog["list"];
  listLegacyPdf: () => Promise<StoredPdfJobMeta[]>;
  listLegacyBridges: () => Promise<LegacyPdfBridgeV1[]>;
}

export function commonExportActivityRow(
  snapshot: ExportJobSnapshotV1,
): ExtensionExportActivityRowV1 {
  const terminal = isExportJobTerminal(snapshot.state);
  return {
    key: `common:${snapshot.id}`,
    source: "common",
    id: snapshot.id,
    format: snapshot.format,
    state: snapshot.state,
    ...(snapshot.stage ? { stage: snapshot.stage } : {}),
    displayName: snapshot.summary.displayName,
    sourceLabel: snapshot.summary.sourceLabel,
    siteOrigin: snapshot.summary.siteOrigin,
    ...(snapshot.summary.profileLabel ? { profileLabel: snapshot.summary.profileLabel } : {}),
    scopeKind: snapshot.summary.scopeKind,
    createdAt: snapshot.createdAt,
    ...(snapshot.startedAt === undefined ? {} : { startedAt: snapshot.startedAt }),
    ...(snapshot.finishedAt === undefined ? {} : { finishedAt: snapshot.finishedAt }),
    ...(snapshot.deliveredAt === undefined ? {} : { deliveredAt: snapshot.deliveredAt }),
    ...(snapshot.acknowledgedAt === undefined ? {} : { acknowledgedAt: snapshot.acknowledgedAt }),
    ...(snapshot.waiting ? { waiting: snapshot.waiting } : {}),
    ...(snapshot.progress ? { progress: snapshot.progress } : {}),
    queue: snapshot.queue,
    attempt: snapshot.attempt,
    recoveryCount: snapshot.recoveryCount,
    stats: snapshot.stats,
    ...(snapshot.reportSummary ? { reportSummary: snapshot.reportSummary } : {}),
    ...(snapshot.reportRef ? { reportRef: snapshot.reportRef } : {}),
    ...(snapshot.artifact ? { artifact: snapshot.artifact } : {}),
    ...(snapshot.derivedFrom ? { derivedFrom: snapshot.derivedFrom } : {}),
    bytes: snapshot.artifact?.byteLength ?? snapshot.stats.storage.outputBytes,
    ...(snapshot.error ? { error: snapshot.error } : {}),
    unread: terminal && snapshot.acknowledgedAt === undefined,
    actions: {
      cancel: ["queued", "running", "waiting", "cancelling"].includes(snapshot.state),
      retry: ["failed", "interrupted", "cancelled"].includes(snapshot.state),
      rerun: snapshot.state === "succeeded",
      resume: snapshot.state === "waiting" && snapshot.waiting?.reason === "auth",
      download: snapshot.state === "succeeded" && snapshot.artifact !== undefined,
      acknowledge: terminal && snapshot.acknowledgedAt === undefined,
      dismiss: terminal,
      detail: terminal,
    },
  };
}

function legacyState(status: StoredPdfJobMeta["status"]): ExportJobState {
  switch (status) {
    case "prepared":
      return "queued";
    case "compiling":
      return "running";
    case "complete":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

export function legacyPdfActivityRow(meta: StoredPdfJobMeta): ExtensionExportActivityRowV1 {
  const state = legacyState(meta.status);
  const terminal = isExportJobTerminal(state);
  const collectable = meta.status === "complete" && meta.outputBytes > 0 && meta.consumed !== true;
  return {
    key: `legacy-pdf:${meta.id}`,
    source: "legacy-pdf",
    id: meta.id,
    format: "pdf",
    state,
    ...(state === "running" ? { stage: "render" as const } : {}),
    displayName: meta.title ?? meta.filename ?? "PDF export",
    sourceLabel: meta.scopeLabel ?? "Legacy PDF export",
    siteOrigin: meta.siteOrigin ?? siteOriginFromSourceIdentity(meta.sourceIdentity),
    scopeKind: meta.scopeLabel ?? "legacy",
    createdAt: meta.createdAt,
    ...(["succeeded", "failed", "cancelled"].includes(state) ? { finishedAt: meta.updatedAt ?? meta.createdAt } : {}),
    ...(meta.progress
      ? {
          progress: {
            stage: "render" as const,
            done: meta.progress.done,
            total: meta.progress.total,
            updatedAt: meta.updatedAt ?? meta.createdAt,
          },
        }
      : {}),
    attempt: state === "queued" ? 0 : 1,
    recoveryCount: 0,
    stats: null,
    bytes: meta.inputBytes + meta.outputBytes,
    ...(meta.error
      ? {
          error: {
            code: "legacy-pdf-error",
            message: meta.error,
            category: "render",
            retryable: false,
            stage: "render",
            occurredAt: meta.updatedAt ?? meta.createdAt,
          },
        }
      : {}),
    unread: terminal,
    actions: {
      cancel: state === "queued" || state === "running",
      retry: false,
      rerun: false,
      resume: false,
      download: collectable,
      acknowledge: false,
      dismiss: terminal,
      detail: terminal,
    },
  };
}

function activityRank(row: ExtensionExportActivityRowV1): number {
  if (row.state === "running" || row.state === "cancelling") return 0;
  if (row.state === "waiting") return 1;
  if (row.state === "queued") return 2;
  if (row.state === "succeeded" && row.unread) return 3;
  if (row.state === "failed" || row.state === "interrupted" || row.state === "cancelled") return 4;
  return 5;
}

/**
 * Transitional Activity reader. Common and legacy failures are isolated so a
 * blocked old database never makes new-format history disappear (or vice versa).
 */
export async function listExtensionExportActivity(
  deps: ExtensionExportActivityDeps,
): Promise<ExtensionExportActivityRowV1[]> {
  const [commonResult, legacyResult, bridgeResult] = await Promise.allSettled([
    deps.listCommon({ includeDismissed: false, limit: 500 }),
    deps.listLegacyPdf(),
    deps.listLegacyBridges(),
  ]);
  const common = commonResult.status === "fulfilled" ? commonResult.value : [];
  const legacy = legacyResult.status === "fulfilled" ? legacyResult.value : [];
  const bridges = bridgeResult.status === "fulfilled" ? bridgeResult.value : [];
  const bridgedLegacyIds = new Set(bridges.map((bridge) => bridge.legacyJobId));
  const commonIds = new Set(common.map((snapshot) => snapshot.id));

  return [
    ...common.map(commonExportActivityRow),
    ...legacy
      .filter((meta) => (meta.kind ?? "export") === "export")
      .filter((meta) => meta.activityVisibility !== "private")
      .filter((meta) => !bridgedLegacyIds.has(meta.id))
      .filter((meta) => meta.parentJobId === undefined || !commonIds.has(meta.parentJobId))
      .map(legacyPdfActivityRow),
  ].sort(
    (left, right) =>
      activityRank(left) - activityRank(right) ||
      right.createdAt - left.createdAt ||
      right.key.localeCompare(left.key),
  );
}
