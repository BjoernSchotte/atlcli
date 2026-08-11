import { describe, expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { ACTION_IDS, parseActionResultV1, type ActionExecutionRequestV1 } from "@atlcli/action-registry";
import { sha256Hex } from "@atlcli/core";
import { createActionPaletteExportRunnersV1 } from "../utils/action-palette/export-actions.js";
import { EXTENSION_ACTION_CAPABILITIES_V1 } from "../utils/action-palette/catalog.js";
import { IndexedDbExportJobCatalog } from "../utils/export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../utils/export-jobs/chunk-store.js";
import { createExtensionPdfJobRequest } from "../utils/export-jobs/pdf-request.js";
import { createExtensionDocxJobRequest } from "../utils/export-jobs/docx-request.js";
import { submitExtensionPdfExport } from "../utils/export-jobs/pdf-submit.js";
import { submitExtensionDocxExport } from "../utils/export-jobs/docx-submit.js";
import type { DocxTemplateRecord } from "../utils/ports/export.js";
import type { LoadedPage } from "../utils/read-path.js";
import type { ActionPaletteContextBindingV1 } from "../utils/action-palette/context.js";

globalThis.IDBKeyRange = IDBKeyRange;

const pageUrl = "https://fixture.atlassian.net/wiki/spaces/DOC/pages/42/Guide";
const currentBinding: ActionPaletteContextBindingV1 = {
  tabId: 4,
  documentId: "doc-1",
  frameId: 0,
  origin: "https://fixture.atlassian.net",
  url: pageUrl,
};
const assertCurrent = async (): Promise<ActionPaletteContextBindingV1> => currentBinding;
const page: LoadedPage = {
  details: {
    id: "42",
    title: "Guide",
    version: 7,
    spaceKey: "DOC",
    storage: "<p>Private body</p>",
  },
  markdown: "Private body",
  wordCount: 2,
  attachments: [],
};

function actionRequest(format: "pdf" | "docx", requestId = `palette-${format}`): ActionExecutionRequestV1 {
  return {
    schemaVersion: 1,
    requestId,
    actionId: format === "pdf" ? ACTION_IDS.exportPdfCurrentPage : ACTION_IDS.exportDocxCurrentPage,
    intent: { kind: "export.current-page", format },
    context: {
      siteOrigin: "https://fixture.atlassian.net",
      product: "confluence",
      entity: { kind: "atlcli.entity.confluence-page", id: "42", key: "DOC", url: pageUrl },
      locale: "en-US",
      capabilities: [
        EXTENSION_ACTION_CAPABILITIES_V1.pdf,
        EXTENSION_ACTION_CAPABILITIES_V1.docx,
        EXTENSION_ACTION_CAPABILITIES_V1.surface,
      ],
    },
  };
}

async function template(): Promise<DocxTemplateRecord> {
  const bytes = new TextEncoder().encode("pinned palette template");
  return {
    name: "template.docx",
    uploadedAt: 10,
    bytes: bytes.buffer,
    recordKey: "https://fixture.atlassian.net|docx|active|global|",
    sha256: await sha256Hex(bytes),
  };
}

function harness(options: {
  readonly resolveTemplate?: () => Promise<DocxTemplateRecord | null>;
  readonly wake?: (ids: string[]) => Promise<{ claimedJobId?: string; error?: string }>;
} = {}) {
  const factory = new IDBFactory();
  const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 10 });
  const bytes = new IndexedDbExportByteStore({ factory });
  let loads = 0;
  let submits = 0;
  const wake = options.wake ?? (async ([claimedJobId]) => ({ claimedJobId }));
  const runners = createActionPaletteExportRunnersV1({
    async loadPage(_request, signal) {
      loads += 1;
      signal.throwIfAborted();
      return page;
    },
    async resolveDocxTemplate(_request, signal) {
      signal.throwIfAborted();
      return options.resolveTemplate ? options.resolveTemplate() : template();
    },
    async getExistingJob(id) {
      return (await catalog.get(id)) ?? undefined;
    },
    async submitPdf(input, requestId) {
      submits += 1;
      return submitExtensionPdfExport(input, {
        requestId,
        now: () => 10,
        catalog,
        bytes,
        postPersistAbortPolicy: "detach",
        wake,
      });
    },
    async submitDocx(input, requestId) {
      submits += 1;
      return submitExtensionDocxExport(input, {
        requestId,
        now: () => 10,
        catalog,
        bytes,
        postPersistAbortPolicy: "detach",
        wake,
      });
    },
  });
  return { runners, catalog, bytes, counts: () => ({ loads, submits }) };
}

describe("action palette durable exports", () => {
  test("builds the same current-page PDF request as Publishing and returns a redacted receipt", async () => {
    const h = harness();
    const request = actionRequest("pdf");
    const result = await h.runners.pdf(request, new AbortController().signal, assertCurrent);
    expect(result).toMatchObject({
      status: "queued",
      receipt: { id: "palette-pdf", actionId: ACTION_IDS.exportPdfCurrentPage, jobKind: "pdf" },
      actions: [{ id: ACTION_IDS.openActivity }, { id: ACTION_IDS.openSidebar }],
    });
    expect(parseActionResultV1(result)).toEqual(result);
    const durable = await h.catalog.getRequest("request:palette-pdf");
    expect(durable).toEqual(createExtensionPdfJobRequest({ page, pageUrl }, {
      requestId: "palette-pdf",
      now: () => 10,
    }));
    expect(JSON.stringify(result)).not.toContain("Private body");
  });

  test("pins the exact active DOCX record, bytes, and digest through the shared builder", async () => {
    const active = await template();
    const h = harness({ resolveTemplate: async () => active });
    const request = actionRequest("docx");
    const result = await h.runners.docx(request, new AbortController().signal, assertCurrent);
    expect(result).toMatchObject({
      status: "queued",
      receipt: { id: "palette-docx", actionId: ACTION_IDS.exportDocxCurrentPage, jobKind: "docx" },
    });
    const durable = await h.catalog.getRequest("request:palette-docx");
    expect(durable).toEqual(await createExtensionDocxJobRequest({ page, pageUrl, template: active }, {
      requestId: "palette-docx",
      now: () => 10,
    }));
    expect(durable?.template).toMatchObject({ recordKey: active.recordKey, sha256: active.sha256 });
  });

  test("returns an explicit Publishing handoff for missing or unreadable templates", async () => {
    for (const [index, resolveTemplate] of [
      async () => null,
      async () => { throw new Error("template unreadable"); },
    ].entries()) {
      const h = harness({ resolveTemplate });
      const result = await h.runners.docx(
        actionRequest("docx", `missing-${index}`),
        new AbortController().signal,
        assertCurrent,
      );
      expect(result).toMatchObject({
        status: "open-surface",
        target: { kind: "sidebar", screen: "export" },
        actions: [{ id: ACTION_IDS.openPublishing }],
      });
      expect(h.counts().submits).toBe(0);
    }
  });

  test("rechecks page identity after selection and stops pre-submit cancellation", async () => {
    const stale = harness();
    await expect(stale.runners.docx(
      actionRequest("docx", "stale-docx"),
      new AbortController().signal,
      async () => { throw new Error("stale-context"); },
    )).rejects.toThrow("stale-context");
    expect(stale.counts().submits).toBe(0);

    const cancelled = harness();
    const controller = new AbortController();
    await expect(cancelled.runners.pdf(
      actionRequest("pdf", "cancelled-pdf"),
      controller.signal,
      async () => {
        controller.abort(new DOMException("closed", "AbortError"));
        return currentBinding;
      },
    )).rejects.toThrow();
    expect(cancelled.counts().submits).toBe(0);
    expect(await cancelled.catalog.get("cancelled-pdf")).toBeUndefined();
  });

  test("keeps a persisted job queued across view close and wake failure", async () => {
    for (const format of ["pdf", "docx"] as const) {
      const controller = new AbortController();
      const factory = new IDBFactory();
      const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 10 });
      const bytes = new IndexedDbExportByteStore({ factory });
      const abortingCatalog = {
        async create(value: Parameters<IndexedDbExportJobCatalog["create"]>[0]) {
          const snapshot = await catalog.create(value);
          controller.abort(new DOMException("palette closed", "AbortError"));
          return snapshot;
        },
        get: catalog.get.bind(catalog),
        compareAndSet: catalog.compareAndSet.bind(catalog),
      };
      const runners = createActionPaletteExportRunnersV1({
        loadPage: async () => page,
        resolveDocxTemplate: async () => template(),
        getExistingJob: async (id) => (await catalog.get(id)) ?? undefined,
        submitPdf: (input, requestId) => submitExtensionPdfExport(input, {
          requestId,
          now: () => 10,
          catalog: abortingCatalog,
          bytes,
          postPersistAbortPolicy: "detach",
          wake: async () => ({ error: "port unavailable" }),
        }),
        submitDocx: (input, requestId) => submitExtensionDocxExport(input, {
          requestId,
          now: () => 10,
          catalog: abortingCatalog,
          bytes,
          postPersistAbortPolicy: "detach",
          wake: async () => ({ error: "port unavailable" }),
        }),
      });
      const id = `detached-${format}`;
      const result = await runners[format](actionRequest(format, id), controller.signal, assertCurrent);
      expect(result).toMatchObject({ status: "queued", receipt: { id, status: "queued", jobKind: format } });
      expect(await catalog.get(id)).toMatchObject({ state: "queued" });
    }
  });

  test("deduplicates a retry after response loss or service-worker restart", async () => {
    const h = harness();
    const request = actionRequest("pdf", "restart-pdf");
    const first = await h.runners.pdf(request, new AbortController().signal, assertCurrent);
    const second = await h.runners.pdf(request, new AbortController().signal, assertCurrent);
    expect(second).toEqual(first);
    expect(h.counts()).toEqual({ loads: 1, submits: 1 });
    expect(await h.catalog.list({ limit: 10 })).toHaveLength(1);
  });
});
