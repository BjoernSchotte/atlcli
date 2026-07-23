import { describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { sha256Hex } from "@atlcli/core";
import { IndexedDbExportJobCatalog } from "../../utils/export-jobs/catalog.js";
import { createExtensionDocxJobRequest } from "../../utils/export-jobs/docx-request.js";
import { submitExtensionDocxExport } from "../../utils/export-jobs/docx-submit.js";
import type { DocxExportRequest } from "../../utils/ports/export.js";

globalThis.IDBKeyRange = IDBKeyRange;

async function input(
  overrides: Partial<DocxExportRequest> = {},
): Promise<DocxExportRequest> {
  const bytes = new TextEncoder().encode("pinned docx template");
  return {
    pageUrl: "https://site.atlassian.net/wiki/spaces/DOCS/pages/42/Guide",
    page: {
      details: {
        id: "42",
        title: "Guide",
        version: 7,
        spaceKey: "DOCS",
        storage: "<p>must not be persisted</p>",
      },
      markdown: "must not be persisted",
      wordCount: 4,
      attachments: [],
    },
    template: {
      name: "mayflower.docx",
      uploadedAt: 10,
      bytes: bytes.buffer,
      recordKey: "https://site.atlassian.net|docx|mayflower|global|",
      sha256: await sha256Hex(bytes),
    },
    scope: { kind: "tree", rootPageId: "42", includeRoot: true, maxDepth: 3 },
    labels: { include: ["public"] },
    resolveMacros: false,
    ...overrides,
  };
}

describe("extension DOCX job submission", () => {
  it("pins only replay-safe source and template identity in the durable request", async () => {
    const durable = await createExtensionDocxJobRequest(await input(), {
      now: () => 20,
      randomUUID: () => "docx-job-1",
    });

    expect(durable).toMatchObject({
      id: "docx-job-1",
      source: {
        siteOrigin: "https://site.atlassian.net",
        locator: { kind: "page-id", id: "42", version: 7 },
        scope: { kind: "tree", includeRoot: true, maxDepth: 3 },
        labels: { include: ["public"] },
      },
      authRef: "session:https://site.atlassian.net",
      requestedFilename: "Guide.docx",
      template: {
        recordKey: "https://site.atlassian.net|docx|mayflower|global|",
        name: "mayflower.docx",
      },
      options: { embedImages: true, resolveMacros: false },
    });
    expect(JSON.stringify(durable)).not.toContain("must not be persisted");
    expect(JSON.stringify(durable)).not.toContain("pinned docx template");
  });

  it("rejects missing or modified template pins before catalog persistence", async () => {
    const missing = await input();
    delete missing.template.recordKey;
    await expect(createExtensionDocxJobRequest(missing)).rejects.toThrow("pinned template");

    const modified = await input();
    modified.template.bytes = new TextEncoder().encode("modified").buffer;
    await expect(createExtensionDocxJobRequest(modified)).rejects.toThrow("pinned SHA-256");
  });

  it("commits the durable request before waking the offscreen queue", async () => {
    const factory = new IDBFactory();
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 20 });
    const order: string[] = [];
    const submitted = await submitExtensionDocxExport(await input(), {
      catalog: {
        create: async (value) => {
          order.push("create");
          return catalog.create(value);
        },
        get: catalog.get.bind(catalog),
        compareAndSet: catalog.compareAndSet.bind(catalog),
      },
      wake: async ([jobId]) => {
        order.push("wake");
        expect(await catalog.getRequest(`request:${jobId}`)).toBeDefined();
        return { claimedJobId: jobId };
      },
      now: () => 20,
      randomUUID: () => "docx-job-1",
    });

    expect(order).toEqual(["create", "wake"]);
    expect(submitted.snapshot).toMatchObject({
      id: "docx-job-1",
      format: "docx",
      state: "queued",
      checkpointRef: "request:docx-job-1",
    });
  });

  it("keeps an accepted job queued when the offscreen doorbell fails", async () => {
    const factory = new IDBFactory();
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 20 });
    const submitted = await submitExtensionDocxExport(await input(), {
      catalog,
      wake: async () => ({ error: "worker unavailable" }),
      now: () => 20,
      randomUUID: () => "docx-job-1",
    });

    expect(submitted.wakeWarning).toBe("worker unavailable");
    expect(await catalog.get("docx-job-1")).toMatchObject({ state: "queued" });
  });
});
