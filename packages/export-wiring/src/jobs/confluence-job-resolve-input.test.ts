import { describe, expect, it } from "bun:test";
import type { ExportPageSource, TreeSource } from "@atlcli/confluence";
import type {
  DocxExportJobRequestV1,
  ExportJobExecutionContext,
  PdfExportJobRequestV1,
} from "@atlcli/export-jobs";
import {
  createConfluenceDocxResolveInputV1,
  createConfluencePdfResolveInputV1,
} from "./confluence-job-resolve-input.js";
import type {
  ConfluenceSourcePlanCheckpointV1,
  ConfluenceSourcePlanStoreV1,
} from "./confluence-source-plan-checkpoint.js";

const body: ExportPageSource = {
  primary: {
    representation: "atlas_doc_format",
    value: JSON.stringify({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Shared", marks: [{ type: "code" }] }],
        },
        {
          type: "extension",
          attrs: { extensionType: "example", extensionKey: "widget" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Visible" }] }],
        },
      ],
    }),
  },
  storageSidecar: "<p>RAW-STORAGE-MUST-NOT-REACH-ENGINE-INPUT</p>",
  sourceVersion: 4,
};

function source(reads: { pages: number }): TreeSource {
  return {
    async getPage(id, context) {
      expect(context.signal).toBeDefined();
      reads.pages += 1;
      return {
        id,
        title: "Root",
        version: 4,
        spaceKey: "SPACE",
        exportSource: body,
      };
    },
    async getPageVersion() {
      return { title: "Root", version: 4 };
    },
    async getChildren() {
      return [];
    },
    async getSpaceHomepageId() {
      return null;
    },
  };
}

function context(
  signal = new AbortController().signal,
  options: {
    jobId?: string;
    leaseEpoch?: number;
    checkpoint?: (ref: string) => void | Promise<void>;
  } = {},
): ExportJobExecutionContext {
  return {
    jobId: options.jobId ?? "job",
    leaseEpoch: options.leaseEpoch ?? 1,
    signal,
    spool: {
      async put() { throw new Error("unused"); },
      async *read() { throw new Error("unused"); },
      async stat() { return undefined; },
    },
    artifacts: {
      async stage() { throw new Error("unused"); },
      async getStaged() { return undefined; },
    },
    async updateProgress() {},
    async appendEvent() {},
    async checkpoint(ref) { await options.checkpoint?.(ref); },
  };
}

function sourceRequest() {
  return {
    kind: "confluence" as const,
    siteOrigin: "https://tenant.invalid",
    locator: { kind: "page-id" as const, id: "root", version: 4 },
    scope: { kind: "page" as const },
    completenessMode: "strict" as const,
  };
}

function pdfRequest(): PdfExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id: "pdf-request",
    idempotencyKey: "pdf-action",
    format: "pdf",
    renderer: "pdf-typst",
    source: sourceRequest(),
    authRef: "session:test",
    displayName: "Export",
    createdAt: 1,
    priority: "interactive",
    output: { policy: "collect" },
    template: { id: "default", manifestVersion: "1" },
    settings: {},
    options: { resolveMacros: true, profile: "tagged" },
  };
}

function docxRequest(): DocxExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id: "docx-request",
    idempotencyKey: "docx-action",
    format: "docx",
    renderer: "docx-typescript",
    source: sourceRequest(),
    authRef: "session:test",
    displayName: "Export",
    createdAt: 1,
    priority: "interactive",
    output: { policy: "collect" },
    template: {
      recordKey: "template",
      sha256: "a".repeat(64),
      name: "template.docx",
    },
    options: { embedImages: true, resolveMacros: true },
  };
}

describe("Confluence job resolveInput adapters", () => {
  it("feeds the canonical source state into PDF and keeps engine env host-owned", async () => {
    const reads = { pages: 0 };
    const progress: unknown[] = [];
    const env = {
      assets: {
        async resolve(): Promise<never> {
          throw new Error("unused");
        },
      },
    };
    const resolveInput = createConfluencePdfResolveInputV1({
      port: { createTreeSource: () => source(reads) },
      onProgress: (_request, _context, event) => progress.push(event),
      build(resolved) {
        return {
          input: {
            metadata: { title: resolved.root.title, exportedAt: new Date(0) },
            filename: "output.pdf",
          },
          env,
        };
      },
    });

    const result = await resolveInput(pdfRequest(), context());
    expect(reads.pages).toBe(1);
    expect(result.env).toBe(env);
    expect(result.input.page).toEqual({ id: "root", version: 4, spaceKey: "SPACE" });
    expect(result.input.blocks[0]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "Shared", marks: ["code"] }],
    });
    expect(result.input.sourceNotes?.some((note) => note.code === "adf-node-degraded")).toBe(true);
    expect(progress).toEqual([{ fetched: 1, total: 1 }]);
    expect(JSON.stringify(result.input)).not.toContain("RAW-STORAGE");
  });

  it("feeds the same canonical source state into DOCX with body-free root details", async () => {
    const reads = { pages: 0 };
    const resolveInput = createConfluenceDocxResolveInputV1({
      port: { createTreeSource: () => source(reads) },
      build() {
        return {
          input: {
            template: { name: "template.docx", modificationDate: new Date(0) },
          },
          rootDetails: {
            createdBy: { displayName: "Author" },
            url: "https://tenant.invalid/wiki/pages/root",
          },
        };
      },
    });

    const result = await resolveInput(docxRequest(), context());
    expect(reads.pages).toBe(1);
    expect(result.details).toMatchObject({
      id: "root",
      title: "Root",
      version: 4,
      spaceKey: "SPACE",
      storage: "",
      createdBy: { displayName: "Author" },
    });
    expect(result.blocks?.[0]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "Shared", marks: ["code"] }],
    });
    expect(result.sourceNotes?.some((note) => note.code === "adf-node-degraded")).toBe(true);
    expect(result.complete).toBe(true);
    expect(JSON.stringify(result)).not.toContain("RAW-STORAGE");
  });

  it("binds the claimed job identity and publishes the source plan before PDF body IO", async () => {
    const order: string[] = [];
    let committed: ConfluenceSourcePlanCheckpointV1 | undefined;
    const store: ConfluenceSourcePlanStoreV1 = {
      async load(identity) {
        order.push(`load:${identity.jobId}:${identity.requestKey}`);
        return undefined;
      },
      async commit(checkpoint, commitContext) {
        order.push(`commit:${commitContext.leaseEpoch}`);
        committed = structuredClone(checkpoint);
        return "source-plan:pdf";
      },
    };
    const port = {
      createTreeSource(): TreeSource {
        return {
          async getPage(id) {
            order.push("body");
            return {
              id,
              title: "Root",
              version: 4,
              exportSource: body,
            };
          },
          async getPageVersion() {
            order.push("version");
            return { title: "Root", version: 4 };
          },
          async getChildren() { return []; },
          async getSpaceHomepageId() { return null; },
        };
      },
    };
    const resolveInput = createConfluencePdfResolveInputV1({
      port,
      sourcePlan: { store, sourcePolicyKey: "adf-primary:v1" },
      build() {
        order.push("build");
        return {
          input: {
            metadata: { title: "Root", exportedAt: new Date(0) },
            filename: "output.pdf",
          },
          env: {
            assets: {
              async resolve(): Promise<never> { throw new Error("unused"); },
            },
          },
        };
      },
    });

    await resolveInput(
      pdfRequest(),
      context(new AbortController().signal, {
        jobId: "claimed-job",
        leaseEpoch: 7,
        checkpoint(ref) {
          expect(ref).toBe("source-plan:pdf");
          order.push("publish");
        },
      }),
    );

    expect(order).toEqual([
      "load:claimed-job:pdf-action",
      "version",
      "commit:7",
      "publish",
      "body",
      "build",
    ]);
    expect(committed).toMatchObject({
      jobId: "claimed-job",
      requestKey: "pdf-action",
      sourcePolicyKey: "adf-primary:v1",
      committedLeaseEpoch: 7,
    });
    expect(JSON.stringify(committed)).not.toContain("RAW-STORAGE");
  });

  it("does not run host builders after cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    let builds = 0;
    const resolveInput = createConfluencePdfResolveInputV1({
      port: { createTreeSource: () => source({ pages: 0 }) },
      build() {
        builds += 1;
        throw new Error("unreachable");
      },
    });
    await expect(resolveInput(pdfRequest(), context(controller.signal))).rejects.toThrow();
    expect(builds).toBe(0);
  });
});
