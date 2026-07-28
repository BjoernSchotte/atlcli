import { describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { PdfExportRequest } from "../../utils/ports/export.js";
import { IndexedDbExportJobCatalog } from "../../utils/export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import { createExtensionPdfJobRequest } from "../../utils/export-jobs/pdf-request.js";
import { extensionPdfLogoSpoolRef, submitExtensionPdfExport } from "../../utils/export-jobs/pdf-submit.js";

globalThis.IDBKeyRange = IDBKeyRange;

function input(overrides: Partial<PdfExportRequest> = {}): PdfExportRequest {
  return {
    pageUrl: "https://site.atlassian.net/wiki/spaces/DOCS/pages/42/Guide",
    page: {
      details: {
        id: "42",
        title: "Guide",
        version: 7,
        spaceKey: "DOCS",
        storage: "<p>Body that must not enter the request</p>",
      },
      markdown: "Body that must not enter the request",
      wordCount: 7,
      attachments: [],
    },
    scope: { kind: "tree", rootPageId: "42", includeRoot: true, maxDepth: 3 },
    labels: { include: ["public"], excludeMode: "prune-subtree" },
    settings: { page: "letter", cover: false, watermark: { text: "Draft", opacity: 0.1 } },
    resolveMacros: false,
    ...overrides,
  };
}

describe("extension PDF job submission", () => {
  it("maps only replay-safe unresolved source/settings into the durable request", () => {
    const request = createExtensionPdfJobRequest(input(), {
      now: () => 10,
      randomUUID: () => "pdf-job-1",
    });
    expect(request).toMatchObject({
      id: "pdf-job-1",
      source: {
        siteOrigin: "https://site.atlassian.net",
        locator: { kind: "page-id", id: "42", version: 7 },
        scope: { kind: "tree", includeRoot: true, maxDepth: 3 },
        labels: { include: ["public"] },
      },
      authRef: "session:https://site.atlassian.net",
      requestedFilename: "Guide.pdf",
      settings: { page: "letter", cover: false, watermark: { text: "Draft", opacity: 0.1 } },
      options: { resolveMacros: false, exportedAt: 10 },
    });
    expect(JSON.stringify(request)).not.toContain("Body that must not enter the request");
  });

  it("commits the request before waking the offscreen queue", async () => {
    const factory = new IDBFactory();
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 10 });
    const order: string[] = [];
    const result = await submitExtensionPdfExport(input(), {
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
      now: () => 10,
      randomUUID: () => "pdf-job-1",
    });
    expect(order).toEqual(["create", "wake"]);
    expect(result.snapshot).toMatchObject({
      id: "pdf-job-1",
      state: "queued",
      format: "pdf",
      checkpointRef: "request:pdf-job-1",
    });
  });

  it("pins logo bytes before persisting only their durable identity", async () => {
    const factory = new IDBFactory();
    const catalog = new IndexedDbExportJobCatalog({ factory });
    const bytes = new IndexedDbExportByteStore({ factory, randomUUID: () => "logo-object" });
    const logo = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

    const result = await submitExtensionPdfExport(input({
      settings: { logo: { bytes: logo, mediaType: "image/png", alt: "Mayflower" } },
    }), {
      catalog,
      bytes,
      requestId: "pdf-job-logo",
      now: () => 10,
      wake: async () => ({}),
    });

    expect(result.request.settings.logo).toMatchObject({
      assetRef: "extension-spool:pdf-job-logo:0:request-assets:pdf-logo",
      byteLength: logo.byteLength,
      mediaType: "image/png",
      alt: "Mayflower",
    });
    expect((result.request.settings.logo as unknown as { bytes?: unknown }).bytes).toBeUndefined();
    expect((await bytes.stat(extensionPdfLogoSpoolRef("pdf-job-logo")))?.byteLength).toBe(logo.byteLength);
    const stored: number[] = [];
    for await (const chunk of bytes.read(extensionPdfLogoSpoolRef("pdf-job-logo"))) stored.push(...chunk);
    expect(stored).toEqual([...logo]);
  });

  it("keeps an accepted job queued when the offscreen doorbell fails", async () => {
    const factory = new IDBFactory();
    const catalog = new IndexedDbExportJobCatalog({ factory });
    const result = await submitExtensionPdfExport(input(), {
      catalog,
      requestId: "pdf-job-doorbell",
      now: () => 10,
      wake: async () => ({ error: "Offscreen host is restarting." }),
    });

    expect(result.wakeWarning).toBe("Offscreen host is restarting.");
    expect(await catalog.get("pdf-job-doorbell")).toMatchObject({
      state: "queued",
      checkpointRef: "request:pdf-job-doorbell",
    });
  });

  it("persists image quality only when it re-encodes, dropping stray ppi on original", () => {
    const standard = createExtensionPdfJobRequest(input({ imageProfile: "standard", imagePpi: 240 }), {
      requestId: "pdf-job-quality",
      now: () => 10,
    });
    expect(standard.options.imageProfile).toBe("standard");
    expect(standard.options.imagePpi).toBe(240);

    const original = createExtensionPdfJobRequest(input({ imageProfile: "original", imagePpi: 240 }), {
      requestId: "pdf-job-original",
      now: () => 10,
    });
    expect(original.options.imageProfile).toBeUndefined();
    expect(original.options.imagePpi).toBeUndefined();

    const absent = createExtensionPdfJobRequest(input(), { requestId: "pdf-job-absent", now: () => 10 });
    expect(absent.options.imageProfile).toBeUndefined();
    expect(absent.options.imagePpi).toBeUndefined();
  });

  it("does not bind the loaded page version to a different selected tree root", () => {
    const request = createExtensionPdfJobRequest(input({
      scope: { kind: "tree", rootPageId: "99", includeRoot: true },
    }), { requestId: "pdf-job-other-root", now: () => 10 });
    expect(request.source.locator).toEqual({ kind: "page-id", id: "99" });
  });

  it("fails before persistence for an unapproved origin or inline logo bytes", () => {
    expect(() => createExtensionPdfJobRequest(input({ pageUrl: "https://example.com/wiki/pages/42" }))).toThrow("approved Atlassian");
    expect(() => createExtensionPdfJobRequest(input({
      settings: { logo: { bytes: Uint8Array.from([1]), mediaType: "image/png", alt: "Logo" } },
    }))).toThrow("pinned asset reference");
  });
});
