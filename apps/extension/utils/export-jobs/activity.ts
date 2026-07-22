import type { ExportJobSnapshotV1, ExportJobStage, ExportJobState } from "@atlcli/export-jobs";
import type { StoredPdfJobMeta } from "../pdf/job-store.js";
import { siteOriginFromSourceIdentity } from "../jobs/model.js";
import type { IndexedDbExportJobCatalog, LegacyPdfBridgeV1 } from "./catalog.js";

export interface ExtensionExportActivityRowV1 {
  key: `common:${string}` | `legacy-pdf:${string}`;
  source: "common" | "legacy-pdf";
  id: string;
  format: "pdf" | "docx";
  state: ExportJobState;
  stage?: ExportJobStage;
  displayName: string;
  siteOrigin: string | null;
  createdAt: number;
  finishedAt?: number;
  progress?: { done: number; total: number | null };
  bytes: number;
  error?: string;
  collectable: boolean;
}

export interface ExtensionExportActivityDeps {
  listCommon: IndexedDbExportJobCatalog["list"];
  listLegacyPdf: () => Promise<StoredPdfJobMeta[]>;
  listLegacyBridges: () => Promise<LegacyPdfBridgeV1[]>;
}

function commonRow(snapshot: ExportJobSnapshotV1): ExtensionExportActivityRowV1 {
  return {
    key: `common:${snapshot.id}`,
    source: "common",
    id: snapshot.id,
    format: snapshot.format,
    state: snapshot.state,
    ...(snapshot.stage ? { stage: snapshot.stage } : {}),
    displayName: snapshot.summary.displayName,
    siteOrigin: snapshot.summary.siteOrigin,
    createdAt: snapshot.createdAt,
    ...(snapshot.finishedAt === undefined ? {} : { finishedAt: snapshot.finishedAt }),
    ...(snapshot.progress ? { progress: { done: snapshot.progress.done, total: snapshot.progress.total } } : {}),
    bytes: snapshot.artifact?.byteLength ?? snapshot.stats.storage.outputBytes,
    ...(snapshot.error ? { error: snapshot.error.message } : {}),
    collectable: snapshot.state === "succeeded" && snapshot.artifact !== undefined && snapshot.deliveredAt === undefined,
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

function legacyRow(meta: StoredPdfJobMeta): ExtensionExportActivityRowV1 {
  const state = legacyState(meta.status);
  return {
    key: `legacy-pdf:${meta.id}`,
    source: "legacy-pdf",
    id: meta.id,
    format: "pdf",
    state,
    ...(state === "running" ? { stage: "render" as const } : {}),
    displayName: meta.title ?? meta.filename ?? "PDF export",
    siteOrigin: meta.siteOrigin ?? siteOriginFromSourceIdentity(meta.sourceIdentity),
    createdAt: meta.createdAt,
    ...(["succeeded", "failed", "cancelled"].includes(state) ? { finishedAt: meta.updatedAt ?? meta.createdAt } : {}),
    ...(meta.progress ? { progress: { done: meta.progress.done, total: meta.progress.total } } : {}),
    bytes: meta.inputBytes + meta.outputBytes,
    ...(meta.error ? { error: meta.error } : {}),
    collectable: meta.status === "complete" && meta.outputBytes > 0 && meta.consumed !== true,
  };
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
    ...common.map(commonRow),
    ...legacy
      .filter((meta) => (meta.kind ?? "export") === "export")
      .filter((meta) => meta.activityVisibility !== "private")
      .filter((meta) => !bridgedLegacyIds.has(meta.id))
      .filter((meta) => meta.parentJobId === undefined || !commonIds.has(meta.parentJobId))
      .map(legacyRow),
  ].sort((left, right) => right.createdAt - left.createdAt || right.key.localeCompare(left.key));
}
