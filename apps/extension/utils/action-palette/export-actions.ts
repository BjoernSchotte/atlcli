import {
  ACTION_IDS,
  type ActionAffordanceV1,
  type ActionExecutionRequestV1,
  type ActionReceiptStatusV1,
  type ActionResultV1,
} from "@atlcli/action-registry";
import type { ExportJobSnapshotV1 } from "@atlcli/export-jobs";
import type {
  DocxExportRequest,
  DocxTemplateRecord,
  PdfExportRequest,
} from "../ports/export.js";
import type { LoadedPage } from "../read-path.js";
import type { SubmittedExtensionDocxExportV1 } from "../export-jobs/docx-submit.js";
import type { SubmittedExtensionPdfExportV1 } from "../export-jobs/pdf-submit.js";
import { EXTENSION_ACTION_CAPABILITIES_V1 } from "./catalog.js";
import type { ActionPaletteContextBindingV1 } from "./context.js";

export type AssertActionPaletteContextCurrentV1 = () => Promise<ActionPaletteContextBindingV1>;

export type ActionPaletteExportRunnerV1 = (
  request: ActionExecutionRequestV1,
  signal: AbortSignal,
  assertContextCurrent: AssertActionPaletteContextCurrentV1,
) => Promise<ActionResultV1>;

export interface ActionPaletteExportDepsV1 {
  loadPage(request: ActionExecutionRequestV1, signal: AbortSignal): Promise<LoadedPage>;
  resolveDocxTemplate(
    request: ActionExecutionRequestV1,
    signal: AbortSignal,
  ): Promise<DocxTemplateRecord | null>;
  getExistingJob(id: string): Promise<ExportJobSnapshotV1 | undefined>;
  submitPdf(input: PdfExportRequest, requestId: string): Promise<SubmittedExtensionPdfExportV1>;
  submitDocx(input: DocxExportRequest, requestId: string): Promise<SubmittedExtensionDocxExportV1>;
}

const openActivity: ActionAffordanceV1 = Object.freeze({
  schemaVersion: 1,
  id: ACTION_IDS.openActivity,
  title: { key: "atlcli.action.open-activity.title", fallback: "Open Activity" },
  intent: { kind: "surface.open", target: { kind: "sidebar", screen: "activity" } },
  requirements: [{ kind: "capability", capability: EXTENSION_ACTION_CAPABILITIES_V1.surface }],
  effect: "external-navigation",
} satisfies ActionAffordanceV1);

const openSidebar: ActionAffordanceV1 = Object.freeze({
  schemaVersion: 1,
  id: ACTION_IDS.openSidebar,
  title: { key: "atlcli.action.open-sidebar.title", fallback: "Open Kiteweave sidebar" },
  intent: { kind: "surface.open", target: { kind: "sidebar", screen: "export" } },
  requirements: [{ kind: "capability", capability: EXTENSION_ACTION_CAPABILITIES_V1.surface }],
  effect: "external-navigation",
} satisfies ActionAffordanceV1);

const openPublishing: ActionAffordanceV1 = Object.freeze({
  schemaVersion: 1,
  id: ACTION_IDS.openPublishing,
  title: { key: "atlcli.action.open-publishing.title", fallback: "Open Publishing" },
  intent: { kind: "surface.open", target: { kind: "sidebar", screen: "export" } },
  requirements: [{ kind: "capability", capability: EXTENSION_ACTION_CAPABILITIES_V1.surface }],
  effect: "external-navigation",
} satisfies ActionAffordanceV1);

function receiptStatus(snapshot: ExportJobSnapshotV1): ActionReceiptStatusV1 {
  if (snapshot.state === "succeeded") return "completed";
  if (["failed", "cancelled", "interrupted"].includes(snapshot.state)) return "failed";
  if (snapshot.state === "running" || snapshot.state === "cancelling") return "running";
  return "queued";
}

function queuedResult(
  snapshot: ExportJobSnapshotV1,
  actionId: string,
  jobKind: "pdf" | "docx",
): ActionResultV1 {
  return {
    status: "queued",
    receipt: {
      schemaVersion: 1,
      id: snapshot.id,
      actionId,
      status: receiptStatus(snapshot),
      host: "extension",
      createdAt: new Date(snapshot.createdAt).toISOString(),
      ...(snapshot.finishedAt === undefined
        ? {}
        : { completedAt: new Date(snapshot.finishedAt).toISOString() }),
      jobKind,
    },
    actions: [openActivity, openSidebar],
  };
}

function publishingRequired(): ActionResultV1 {
  return {
    status: "open-surface",
    target: { kind: "sidebar", screen: "export" },
    actions: [openPublishing],
  };
}

function currentPageUrl(request: ActionExecutionRequestV1): string {
  const entity = request.context.entity;
  if (request.context.product !== "confluence" ||
      entity?.kind !== "atlcli.entity.confluence-page") {
    throw new Error("A current-page export requires an authoritative Confluence page context.");
  }
  return entity.url;
}

async function existingResult(
  deps: ActionPaletteExportDepsV1,
  request: ActionExecutionRequestV1,
  format: "pdf" | "docx",
): Promise<ActionResultV1 | null> {
  const existing = await deps.getExistingJob(request.requestId);
  if (!existing) return null;
  if (existing.format !== format) {
    throw new Error("The action request id is already bound to another export format.");
  }
  return queuedResult(existing, request.actionId, format);
}

export function createActionPaletteExportRunnersV1(
  deps: ActionPaletteExportDepsV1,
): { readonly pdf: ActionPaletteExportRunnerV1; readonly docx: ActionPaletteExportRunnerV1 } {
  return {
    async pdf(request, signal, assertContextCurrent) {
      signal.throwIfAborted();
      const existing = await existingResult(deps, request, "pdf");
      if (existing) return existing;
      const pageUrl = currentPageUrl(request);
      const page = await deps.loadPage(request, signal);
      signal.throwIfAborted();
      await assertContextCurrent();
      signal.throwIfAborted();
      const submitted = await deps.submitPdf({ page, pageUrl, signal }, request.requestId);
      return queuedResult(submitted.snapshot, request.actionId, "pdf");
    },

    async docx(request, signal, assertContextCurrent) {
      signal.throwIfAborted();
      const existing = await existingResult(deps, request, "docx");
      if (existing) return existing;
      const pageUrl = currentPageUrl(request);
      const page = await deps.loadPage(request, signal);
      signal.throwIfAborted();
      let template: DocxTemplateRecord | null;
      try {
        template = await deps.resolveDocxTemplate(request, signal);
      } catch {
        signal.throwIfAborted();
        return publishingRequired();
      }
      signal.throwIfAborted();
      if (!template) return publishingRequired();
      await assertContextCurrent();
      signal.throwIfAborted();
      const submitted = await deps.submitDocx(
        { page, pageUrl, template, signal },
        request.requestId,
      );
      return queuedResult(submitted.snapshot, request.actionId, "docx");
    },
  };
}
