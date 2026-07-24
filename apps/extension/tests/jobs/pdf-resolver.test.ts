import { describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type {
  ExportJobExecutionContext,
  ExportJobProgressV1,
  PdfExportJobRequestV1,
} from "@atlcli/export-jobs";
import {
  bindExportJobSpool,
  type SpoolWriteLimitsV1,
} from "@atlcli/export-jobs";
import type {
  ConfluenceSourceResolverPortV1,
} from "@atlcli/export-wiring/jobs";
import type { ExportComposition } from "../../utils/confluence/export-composition.js";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import { createExtensionPdfJobInputResolver } from "../../utils/export-jobs/pdf-resolver.js";
import { extensionPdfLogoSpoolRef } from "../../utils/export-jobs/pdf-submit.js";

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
      locator: { kind: "page-id", id: "42", version: 7 },
      scope: { kind: "tree", includeRoot: true, maxDepth: 2 },
      labels: { include: ["public"] },
    },
    authRef: "session:https://site.atlassian.net",
    displayName: "Guide",
    requestedFilename: "Guide.pdf",
    createdAt: 10,
    priority: "interactive",
    output: { policy: "collect" },
    template: { id: "builtin.editorial-indigo", manifestVersion: "1.0.0" },
    settings: { outline: true },
    options: { resolveMacros: false, exportedAt: 1_700_000_000_000 },
  };
}

function context(progress: ExportJobProgressV1[] = []): ExportJobExecutionContext {
  return {
    jobId: "job",
    leaseEpoch: 1,
    signal: new AbortController().signal,
    spool: {} as ExportJobExecutionContext["spool"],
    readSpool: async function* () {
      throw new Error("No recovered source object was expected.");
    },
    artifacts: {} as ExportJobExecutionContext["artifacts"],
    updateProgress: async (value) => {
      progress.push(value);
    },
    updateStats: async () => {},
    appendEvent: async () => {},
    checkpoint: async () => {},
  };
}

const spoolLimits: SpoolWriteLimitsV1 = {
  maxObjectBytes: 16 * 1024 * 1024,
  maxJobBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
};

function durableContext(
  bytes: IndexedDbExportByteStore,
  jobId: string,
): ExportJobExecutionContext {
  const value: ExportJobExecutionContext = {
    jobId,
    leaseEpoch: 1,
    signal: new AbortController().signal,
    spool: bindExportJobSpool(bytes, jobId, 1, spoolLimits),
    readSpool: (ref, options) => bytes.read(ref, options),
    artifacts: {} as ExportJobExecutionContext["artifacts"],
    updateProgress: async () => {},
    updateStats: async () => {},
    appendEvent: async () => {},
    checkpoint: async (ref) => { value.checkpointRef = ref; },
  };
  return value;
}

function adfSourcePort(): ConfluenceSourceResolverPortV1 {
  return {
    createTreeSource() {
      return {
        async getPage() {
          return {
            id: "42",
            title: "Guide",
            version: 7,
            spaceKey: "TEST",
            exportSource: {
              primary: {
                representation: "atlas_doc_format" as const,
                value: JSON.stringify({
                  version: 1,
                  type: "doc",
                  content: [{
                    type: "paragraph",
                    content: [{ type: "text", text: "ADF production path" }],
                  }],
                }),
              },
              storageSidecar: "<p>POISONED STORAGE</p>",
              sourceVersion: 7,
            },
          };
        },
        async getPageVersion() {
          return { title: "Guide", version: 7 };
        },
        async getChildren() { return []; },
        async getSpaceHomepageId() { return null; },
      };
    },
  };
}

const composition: ExportComposition = {
  kind: "tree",
  blocks: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
  notes: [],
  complete: true,
  root: { id: "42", title: "Guide", version: 7, spaceKey: "DOCS" },
  chapterAnchorById: new Map([["42", "guide"]]),
  pageCount: 1,
};

describe("extension PDF durable input resolver", () => {
  it("uses the shared ADF resolver and durable source checkpoints by default", async () => {
    const factory = new IDBFactory();
    const bytes = new IndexedDbExportByteStore({ factory });
    const sourceRequest: PdfExportJobRequestV1 = {
      ...request("default-adf"),
      source: {
        kind: "confluence",
        siteOrigin: "https://site.atlassian.net",
        locator: { kind: "page-id", id: "42", version: 7 },
        scope: { kind: "page" },
      },
    };
    const execution = durableContext(bytes, sourceRequest.id);
    const resolved = await createExtensionPdfJobInputResolver({
      bytes,
      sourcePort: adfSourcePort(),
    })(sourceRequest, execution);

    expect(resolved.input.blocks).toEqual([{
      type: "paragraph",
      content: [{ type: "text", text: "ADF production path" }],
    }]);
    expect(JSON.stringify(resolved)).not.toContain("POISONED STORAGE");
    expect(resolved.telemetry).toEqual({ sourcePageCount: 1 });
    expect(execution.checkpointRef).toStartWith("atlcli.export-tree-spool/1:");
  });

  it("resolves scope and engine input without any panel-owned page object", async () => {
    const factory = new IDBFactory();
    const bytes = new IndexedDbExportByteStore({ factory });
    const progress: ExportJobProgressV1[] = [];
    let seenScope: unknown;
    let sawBodyStore = false;
    let live: boolean | undefined;
    const resolver = createExtensionPdfJobInputResolver({
      bytes,
      deps: {
        now: () => 20,
        locale: () => "de-DE",
        loadRoot: async () => ({
          id: "42",
          title: "Guide",
          version: 7,
          spaceKey: "DOCS",
          storage: "<p>Hello</p>",
          modifiedBy: { displayName: "Ada" },
        }),
        resolveComposition: async (input) => {
          seenScope = input.scope;
          sawBodyStore = input.bodyStore !== undefined;
          input.onProgress?.({ fetched: 1, total: 1, currentTitle: "Guide" });
          return composition;
        },
        resolveMentions: async (blocks) => ({ blocks, resolved: 0, unresolved: 0 }),
        createAssets: () => ({
          resolve: async () => {
            throw new Error("no assets expected");
          },
        }),
        createMacros: (input) => {
          live = input.live;
          return {
            registry: { get: () => undefined } as never,
            contextFor: () => ({}) as never,
            live: input.live,
          };
        },
      },
    });

    const resolved = await resolver(request("job"), context(progress));
    expect(seenScope).toEqual({
      kind: "tree",
      rootPageId: "42",
      includeRoot: true,
      maxDepth: 2,
    });
    expect(live).toBe(false);
    expect(sawBodyStore).toBe(true);
    expect(resolved.telemetry).toEqual({ sourcePageCount: 1 });
    expect(resolved.input).toMatchObject({
      blocks: composition.blocks,
      complete: true,
      filename: "Guide.pdf",
      settings: { outline: true },
      metadata: {
        title: "Guide",
        space: "DOCS",
        version: 7,
        author: "Ada",
        exporter: "Ada",
        language: "de",
        region: "DE",
      },
      page: { id: "42", version: 7, spaceKey: "DOCS" },
    });
    expect(resolved.input.metadata.exportedAt.toISOString()).toBe(
      "2023-11-14T22:13:20.000Z",
    );
    expect(progress).toEqual([{
      stage: "fetch",
      done: 1,
      total: 1,
      detail: "Guide",
      updatedAt: 20,
    }]);
  });

  it("integrity-checks and hydrates pinned logo bytes from request-owned storage", async () => {
    const factory = new IDBFactory();
    const bytes = new IndexedDbExportByteStore({ factory });
    const durable = request("logo-job");
    const logoBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const stored = await bytes.put(
      extensionPdfLogoSpoolRef(durable.id),
      (async function* () { yield logoBytes; })(),
      {
        maxObjectBytes: 1024,
        maxJobBytes: 2048,
        maxTotalBytes: 4096,
      },
    );
    durable.settings.logo = {
      assetRef: `extension-spool:${encodeURIComponent(durable.id)}:0:request-assets:pdf-logo`,
      sha256: stored.sha256,
      byteLength: stored.byteLength,
      mediaType: "image/png",
      alt: "Company",
    };
    const resolver = createExtensionPdfJobInputResolver({
      bytes,
      deps: {
        loadRoot: async () => ({ id: "42", title: "Guide", version: 7 }),
        resolveComposition: async () => composition,
        resolveMentions: async (blocks) => ({ blocks, resolved: 0, unresolved: 0 }),
        createAssets: () => ({ resolve: async () => ({ bytes: logoBytes, mediaType: "image/png" }) }),
        createMacros: () => ({
          registry: { get: () => undefined } as never,
          contextFor: () => ({}) as never,
        }),
      },
    });

    const resolved = await resolver(durable, context());
    expect(resolved.input.settings?.logo).toEqual({
      bytes: logoBytes,
      mediaType: "image/png",
      alt: "Company",
    });

    durable.settings.logo.sha256 = "0".repeat(64);
    await expect(resolver(durable, context())).rejects.toThrow(/integrity binding/);
  });

  it("fails closed when source/auth or pinned template identity diverges", async () => {
    const factory = new IDBFactory();
    const resolver = createExtensionPdfJobInputResolver({
      bytes: new IndexedDbExportByteStore({ factory }),
      deps: {
        loadRoot: async () => ({ id: "42", title: "Guide" }),
      },
    });
    const wrongAuth = request("wrong-auth");
    wrongAuth.authRef = "session:https://other.atlassian.net";
    await expect(resolver(wrongAuth, context())).rejects.toThrow(/session reference/);

    const wrongTemplate = request("wrong-template");
    wrongTemplate.template.manifestVersion = "999";
    await expect(resolver(wrongTemplate, context())).rejects.toThrow(/template manifest/);
  });
});
