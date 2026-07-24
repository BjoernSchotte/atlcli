import { describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { sha256Hex } from "@atlcli/core";
import type {
  DocxExportJobRequestV1,
  ExportJobExecutionContext,
  ExportJobProgressV1,
} from "@atlcli/export-jobs";
import {
  bindExportJobSpool,
  type SpoolWriteLimitsV1,
} from "@atlcli/export-jobs";
import type {
  ConfluenceSourceResolverPortV1,
} from "@atlcli/export-wiring/jobs";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import { createExtensionDocxJobInputResolver } from "../../utils/export-jobs/docx-resolver.js";
import {
  EXTENSION_DOCX_TEMPLATE_LIMITS_V1,
  createExtensionDocxPinnedTemplatePort,
  extensionDocxTemplateSpoolRef,
} from "../../utils/export-jobs/docx-template.js";

globalThis.IDBKeyRange = IDBKeyRange;

function request(
  templateSha256 = "0".repeat(64),
): DocxExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id: "docx-job",
    idempotencyKey: "idem:docx-job",
    format: "docx",
    renderer: "docx-typescript",
    source: {
      kind: "confluence",
      siteOrigin: "https://site.atlassian.net",
      locator: { kind: "page-id", id: "42", version: 7 },
      scope: { kind: "tree", includeRoot: true, maxDepth: 2 },
      labels: { include: ["public"] },
    },
    authRef: "session:https://site.atlassian.net",
    displayName: "Guide",
    requestedFilename: "Guide.docx",
    createdAt: 1_700_000_000_000,
    priority: "interactive",
    output: { policy: "collect" },
    template: {
      recordKey: "https://site.atlassian.net|docx|synthetic|global",
      sha256: templateSha256,
      name: "synthetic.docx",
      uploadedAt: 1_600_000_000_000,
    },
    options: {
      embedImages: true,
      resolveMacros: false,
      updateFields: "always",
      captionLang: "de-DE",
    },
  };
}

function context(progress: ExportJobProgressV1[] = []): ExportJobExecutionContext {
  return {
    jobId: "docx-job",
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
): ExportJobExecutionContext {
  const value: ExportJobExecutionContext = {
    jobId: "docx-job",
    leaseEpoch: 1,
    signal: new AbortController().signal,
    spool: bindExportJobSpool(bytes, "docx-job", 1, spoolLimits),
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

describe("extension DOCX durable input resolver", () => {
  it("uses the shared ADF resolver and durable source checkpoints by default", async () => {
    const bytes = new IndexedDbExportByteStore({ factory: new IDBFactory() });
    const sourceRequest: DocxExportJobRequestV1 = {
      ...request(),
      source: {
        kind: "confluence",
        siteOrigin: "https://site.atlassian.net",
        locator: { kind: "page-id", id: "42", version: 7 },
        scope: { kind: "page" },
      },
    };
    const execution = durableContext(bytes);
    const resolved = await createExtensionDocxJobInputResolver({
      sourcePort: adfSourcePort(),
    })(sourceRequest, execution);

    expect(resolved.blocks).toEqual([{
      type: "paragraph",
      content: [{ type: "text", text: "ADF production path" }],
    }]);
    expect(resolved.details.storage).toBe("");
    expect(JSON.stringify(resolved)).not.toContain("POISONED STORAGE");
    expect(resolved.jobTelemetry).toEqual({ sourcePageCount: 1 });
    expect(execution.checkpointRef).toStartWith("atlcli.export-tree-spool/1:");
  });

  it("reconstructs source, macro, asset, and raster seams without panel state", async () => {
    const progress: ExportJobProgressV1[] = [];
    let seenScope: unknown;
    let sawBodyStore = false;
    let live: boolean | undefined;
    const assets = { fetch: async () => new Uint8Array() };
    const rasterizer = { rasterize: async () => new Uint8Array() };
    const engineDeps = {} as never;
    const macros = {
      registry: { get: () => undefined },
      contextFor: () => ({}),
      live: false,
    } as never;
    const blocks = [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] as never;
    const resolver = createExtensionDocxJobInputResolver({
      now: () => 30,
      loadRoot: async () => ({
        id: "42",
        title: "Guide",
        version: 7,
        spaceKey: "DOCS",
        storage: "<p>Hello</p>",
      }),
      resolveScope: async (input) => {
        seenScope = input.scope;
        sawBodyStore = input.bodyStore !== undefined;
        input.onProgress?.({ fetched: 1, total: 2, currentTitle: "Guide" });
        return {
          blocks,
          sourceNotes: [],
          complete: true,
          chapterAnchorById: new Map([["42", "guide"]]),
          pageCount: 1,
        };
      },
      createDeps: () => engineDeps,
      createAssets: () => assets,
      createRasterizer: () => rasterizer,
      createMacros: (input) => {
        live = input.live;
        return macros;
      },
    });

    const resolved = await resolver(request(), context(progress));

    expect(seenScope).toEqual({
      kind: "tree",
      rootPageId: "42",
      includeRoot: true,
      maxDepth: 2,
    });
    expect(live).toBe(false);
    expect(sawBodyStore).toBe(true);
    expect(resolved).toMatchObject({
      jobTelemetry: { sourcePageCount: 1 },
      details: { id: "42", title: "Guide", storage: "<p>Hello</p>" },
      blocks,
      complete: true,
      template: {
        name: "synthetic.docx",
        modificationDate: new Date(1_600_000_000_000),
      },
      exportDate: new Date(1_700_000_000_000),
      deps: engineDeps,
      assets,
      rasterizer,
      macros,
      updateFields: "always",
      captionLang: "de-DE",
    });
    expect(progress).toEqual([{
      stage: "fetch",
      done: 1,
      total: 2,
      detail: "Guide",
      updatedAt: 30,
    }]);
  });

  it("loads only the immutable job-owned template copy and verifies its bytes", async () => {
    const factory = new IDBFactory();
    const templateBytes = new TextEncoder().encode("docx template bytes");
    const sha256 = await sha256Hex(templateBytes);
    const recordKey = "https://site.atlassian.net|docx|mayflower|global";
    const byteStore = new IndexedDbExportByteStore({ factory });
    await byteStore.put(
      extensionDocxTemplateSpoolRef("docx-job"),
      (async function* () { yield templateBytes; })(),
      EXTENSION_DOCX_TEMPLATE_LIMITS_V1,
    );

    const templates = createExtensionDocxPinnedTemplatePort(byteStore);
    const resolved = await templates.resolve({
      jobId: "docx-job",
      recordKey,
      expectedSha256: sha256,
      signal: new AbortController().signal,
    });
    expect([...resolved.bytes]).toEqual([...templateBytes]);

    await expect(templates.resolve({
      jobId: "docx-job",
      recordKey,
      expectedSha256: "f".repeat(64),
      signal: new AbortController().signal,
    })).rejects.toThrow("unavailable or changed");
  });

  it("fails closed when source auth no longer matches the durable origin", async () => {
    const mismatched = request();
    mismatched.authRef = "session:https://other.atlassian.net";
    const resolver = createExtensionDocxJobInputResolver({
      loadRoot: async () => {
        throw new Error("must fail before source IO");
      },
    });
    await expect(resolver(mismatched, context())).rejects.toThrow("session reference");
  });
});
