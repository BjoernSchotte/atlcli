import { describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { PdfExportJobRequestV1 } from "@atlcli/export-jobs";
import type { PdfSourceBundle } from "@atlcli/pdf/browser";
import { IndexedDbExportJobCatalog } from "../../utils/export-jobs/catalog.js";
import { createOffscreenPrivatePdfCompilePort } from "../../utils/export-jobs/pdf-compiler.js";
import {
  cancelPdfJob,
  claimPdfJob,
  completePdfJob,
  deletePdfJob,
  getPdfJob,
  getPdfJobMeta,
  markPdfJobConsumed,
  putPdfJob,
} from "../../utils/pdf/job-store.js";

globalThis.IDBKeyRange = IDBKeyRange;

function request(id: string): PdfExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `idem:${id}`,
    format: "pdf",
    renderer: "pdf-typst",
    source: {
      kind: "confluence",
      siteOrigin: "https://site.atlassian.net",
      locator: { kind: "page-id", id: "42" },
      scope: { kind: "page" },
    },
    authRef: "session:https://site.atlassian.net",
    displayName: "Guide",
    requestedFilename: "Guide.pdf",
    createdAt: 10,
    priority: "interactive",
    output: { policy: "collect" },
    template: { kind: "builtin", id: "builtin", manifestVersion: "1" },
    settings: {},
    options: { resolveMacros: true },
  };
}

const bundle: PdfSourceBundle = {
  main: "#render([Guide])",
  template: "#let render(body) = body",
  assets: [],
  sourceMap: [],
  notes: [],
};

describe("offscreen private PDF compiler bridge", () => {
  it("uses a hidden legacy transport record and removes it after returning bytes", async () => {
    const factory = new IDBFactory();
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 10 });
    await catalog.create({ request: request("outer-job") });
    const claimed = await catalog.claimNext({
      ownerId: "offscreen:test",
      now: 10,
      leaseDurationMs: 1_000,
    });
    if (!claimed) throw new Error("Expected outer claim.");
    const pdf = new TextEncoder().encode("%PDF-1.7\n%%EOF");
    const port = createOffscreenPrivatePdfCompilePort({
      outerJobId: claimed.id,
      outerLeaseEpoch: claimed.leaseEpoch,
      sourceIdentity: "https://site.atlassian.net/wiki/spaces/DOCS/pages/42",
      siteOrigin: "https://site.atlassian.net",
      title: "Guide",
      filename: "Guide.pdf",
      deps: {
        catalog,
        makeJobId: () => "11111111-1111-4111-8111-111111111111",
        now: () => 10,
        createJob: (input) => putPdfJob(input, factory),
        getJob: (id) => getPdfJob(id, factory, { bundle: false, pdf: true }),
        consumeJob: (id) => markPdfJobConsumed(id, factory),
        deleteJob: (id) => deletePdfJob(id, factory),
        host: {
          async compile(jobId) {
            expect(await getPdfJobMeta(jobId, factory)).toMatchObject({
              activityVisibility: "private",
              parentJobId: claimed.id,
              parentLeaseEpoch: claimed.leaseEpoch,
            });
            expect(await catalog.listLegacyBridges()).toEqual([{
              legacyJobId: jobId,
              outerJobId: claimed.id,
              outerLeaseEpoch: claimed.leaseEpoch,
              hidden: true,
              createdAt: 10,
            }]);
            expect(await claimPdfJob(jobId, factory)).toBeDefined();
            await completePdfJob(jobId, {
              pdf,
              diagnostics: [],
              compilerVersion: "test",
              fontEvidence: {
                schema: "atlcli.pdf-font-load-evidence/1",
                requirementKey: "font-key",
                registeredAssetIds: ["canonical/SourceSans3-Regular.ttf"],
                loadedFontNames: ["Source Sans 3"],
                fullBundleFallback: false,
              },
            }, factory);
            return { kind: "pdf-worker:complete", jobId, ok: true };
          },
          cancel: async () => false,
        },
      },
    });

    expect(await port.compile(bundle)).toEqual({
      pdf,
      diagnostics: [],
      compilerVersion: "test",
      fontEvidence: {
        schema: "atlcli.pdf-font-load-evidence/1",
        requirementKey: "font-key",
        registeredAssetIds: ["canonical/SourceSans3-Regular.ttf"],
        loadedFontNames: ["Source Sans 3"],
        fullBundleFallback: false,
      },
    });
    expect(await getPdfJob("11111111-1111-4111-8111-111111111111", factory)).toBeUndefined();
    expect(await catalog.listLegacyBridges()).toEqual([]);
  });

  it("routes outer cancellation to the active compiler and cleans private state", async () => {
    const factory = new IDBFactory();
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 10 });
    await catalog.create({ request: request("outer-cancel") });
    const claimed = await catalog.claimNext({
      ownerId: "offscreen:test",
      now: 10,
      leaseDurationMs: 1_000,
    });
    if (!claimed) throw new Error("Expected outer claim.");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: (value: {
      kind: "pdf-worker:complete";
      jobId: string;
      ok: false;
      error: string;
      fatal: boolean;
    }) => void;
    const compiling = new Promise<Parameters<typeof finish>[0]>((resolve) => { finish = resolve; });
    let cancelled = 0;
    const port = createOffscreenPrivatePdfCompilePort({
      outerJobId: claimed.id,
      outerLeaseEpoch: claimed.leaseEpoch,
      sourceIdentity: "https://site.atlassian.net/wiki/spaces/DOCS/pages/42",
      siteOrigin: "https://site.atlassian.net",
      title: "Guide",
      filename: "Guide.pdf",
      deps: {
        catalog,
        makeJobId: () => "22222222-2222-4222-8222-222222222222",
        now: () => 10,
        createJob: (input) => putPdfJob(input, factory),
        getJob: (id) => getPdfJob(id, factory, { bundle: false, pdf: true }),
        consumeJob: (id) => markPdfJobConsumed(id, factory),
        deleteJob: (id) => deletePdfJob(id, factory),
        host: {
          compile: async () => {
            entered();
            return compiling;
          },
          cancel: async (jobId) => {
            cancelled += 1;
            void cancelPdfJob(jobId, factory).then(() => finish({
              kind: "pdf-worker:complete",
              jobId,
              ok: false,
              error: "cancelled",
              fatal: false,
            }));
            return true;
          },
        },
      },
    });
    const controller = new AbortController();
    const pending = port.compile(bundle, { signal: controller.signal });
    await started;
    controller.abort(new DOMException("Cancelled by test.", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(1);
    expect(await getPdfJob("22222222-2222-4222-8222-222222222222", factory)).toBeUndefined();
    expect(await catalog.listLegacyBridges()).toEqual([]);
  });
});
