import { describe, expect, it } from "bun:test";
import type {
  ExportPageSource,
  TreeChild,
  TreeSource,
  TreeSourcePage,
} from "@atlcli/confluence";
import type { ExportSourceV1 } from "@atlcli/export-jobs";
import {
  ConfluenceSourceVersionMismatchError,
  ConfluenceSourceResolutionError,
  resolveConfluenceSourceV1,
  type ConfluenceSourceResolverPortV1,
  type ResolvedConfluenceSourceV1,
} from "./confluence-source-resolver.js";
import type {
  ConfluenceSourcePlanCheckpointV1,
  ConfluenceSourcePlanIdentityV1,
  ConfluenceSourcePlanStoreV1,
  PersistedConfluenceSourcePlanV1,
} from "./confluence-source-plan-checkpoint.js";

class MemorySourcePlanStore implements ConfluenceSourcePlanStoreV1 {
  persisted?: PersistedConfluenceSourcePlanV1;
  readonly order: string[] = [];

  async load(identity: ConfluenceSourcePlanIdentityV1): Promise<PersistedConfluenceSourcePlanV1 | undefined> {
    this.order.push(`load:${identity.jobId}`);
    return this.persisted ? structuredClone(this.persisted) : undefined;
  }

  async commit(
    checkpoint: ConfluenceSourcePlanCheckpointV1,
    context: { leaseEpoch: number },
  ): Promise<string> {
    this.order.push(`commit:${context.leaseEpoch}`);
    expect(checkpoint.committedLeaseEpoch).toBe(context.leaseEpoch);
    this.persisted = {
      checkpoint: structuredClone(checkpoint),
      ref: "source-plan:checkpoint",
    };
    return this.persisted.ref;
  }
}

function adfSource(
  text: string,
  version = 1,
  content?: unknown[],
  storageSidecar = "<p>POISONED-STORAGE-SIDECAR</p>",
): ExportPageSource {
  return {
    primary: {
      representation: "atlas_doc_format",
      value: JSON.stringify({
        type: "doc",
        version: 1,
        content: content ?? [{ type: "paragraph", content: [{ type: "text", text }] }],
      }),
    },
    storageSidecar,
    sourceVersion: version,
  };
}

interface FixturePage {
  id: string;
  title: string;
  version: number;
  parent: string | null;
  position: number;
  source: ExportPageSource;
}

function fixturePort(
  pages: readonly FixturePage[],
  options: {
    contentKey?: string;
    spaceHomepage?: string;
    onCall?: (method: string, id: string, signal: AbortSignal | undefined) => void;
    getPage?: TreeSource["getPage"];
  } = {},
): ConfluenceSourceResolverPortV1 {
  const byId = new Map(pages.map((page) => [page.id, page]));
  return {
    async resolveContentKey(value, context) {
      options.onCall?.("resolveContentKey", value, context.signal);
      if (value !== options.contentKey) throw new Error("content key not found");
      return { id: pages[0]!.id };
    },
    createTreeSource(context) {
      const source: TreeSource = {
        async getPage(id, callContext): Promise<TreeSourcePage> {
          options.onCall?.("getPage", id, callContext.signal);
          if (options.getPage) return options.getPage(id, callContext);
          const page = byId.get(id);
          if (!page) throw new Error("page not found");
          return {
            id,
            title: page.title,
            version: page.version,
            spaceKey: "SPACE",
            labels: [],
            exportSource: page.source,
          };
        },
        async getPageVersion(id, callContext) {
          options.onCall?.("getPageVersion", id, callContext.signal);
          const page = byId.get(id);
          if (!page) throw new Error("page not found");
          return { title: page.title, version: page.version };
        },
        async getChildren(node, callContext) {
          options.onCall?.("getChildren", node.id, callContext.signal);
          return pages
            .filter((page) => page.parent === node.id)
            .map((page): TreeChild => ({
              id: page.id,
              title: page.title,
              kind: "page",
              position: page.position,
              observedVersion: page.version,
            }));
        },
        async getSpaceHomepageId(spaceKey, callContext) {
          options.onCall?.("getSpaceHomepageId", spaceKey, callContext.signal);
          return options.spaceHomepage ?? null;
        },
      };
      // The factory receives the same cancellation authority before any source
      // method becomes reachable.
      options.onCall?.("createTreeSource", context.siteOrigin, context.signal);
      return source;
    },
  };
}

function pageRequest(locator: ExportSourceV1["locator"] = {
  kind: "page-id",
  id: "root",
  version: 1,
}): ExportSourceV1 {
  return {
    kind: "confluence",
    siteOrigin: "https://tenant.invalid",
    locator,
    scope: { kind: "page" },
    completenessMode: "strict",
  };
}

describe("resolveConfluenceSourceV1", () => {
  it("decodes a pinned ADF page once and returns body-free source diagnostics", async () => {
    const calls: Array<{ method: string; signal: AbortSignal | undefined }> = [];
    const controller = new AbortController();
    const result = await resolveConfluenceSourceV1(pageRequest(), {
      exporter: "word",
      port: fixturePort([
        {
          id: "root",
          title: "Root",
          version: 1,
          parent: null,
          position: 0,
          source: adfSource("ADF wins"),
        },
      ], {
        onCall: (method, _id, signal) => calls.push({ method, signal }),
      }),
      signal: controller.signal,
    });

    expect(result.blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "ADF wins" }] },
    ]);
    expect(result.complete).toBe(true);
    expect(result.root).toEqual({ id: "root", title: "Root", version: 1, spaceKey: "SPACE" });
    expect(result.sourceSummary).toEqual({
      pagesRead: 1,
      representations: { atlas_doc_format: 1, storage: 0 },
      degradedPages: 0,
    });
    expect(JSON.stringify(result.sourceSummary)).not.toContain("POISONED-STORAGE-SIDECAR");
    expect(JSON.stringify(result.pages)).not.toContain("POISONED-STORAGE-SIDECAR");
    expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
    expect(calls.filter((call) => call.method === "getPageVersion")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "getPage")).toHaveLength(1);
  });

  it("commits and publishes a body-free plan before body IO, then resumes it on a new lease", async () => {
    const store = new MemorySourcePlanStore();
    const firstOrder = store.order;
    const page: FixturePage = {
      id: "root",
      title: "Root",
      version: 1,
      parent: null,
      position: 0,
      source: adfSource("Recovered body"),
    };
    const first = await resolveConfluenceSourceV1(pageRequest(), {
      exporter: "pdf",
      port: fixturePort([page], {
        onCall(method) { firstOrder.push(method); },
        async getPage() {
          firstOrder.push("body:lost");
          throw new Error("worker lost");
        },
      }),
      signal: new AbortController().signal,
      sourcePlanCheckpoint: {
        jobId: "job",
        requestKey: "request",
        sourcePolicyKey: "adf-primary:v1",
        leaseEpoch: 1,
        store,
        async publishCheckpointRef(ref) {
          expect(ref).toBe("source-plan:checkpoint");
          firstOrder.push("publish:1");
        },
      },
    }).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(ConfluenceSourceResolutionError);
    expect(firstOrder.indexOf("commit:1")).toBeLessThan(firstOrder.indexOf("publish:1"));
    expect(firstOrder.indexOf("publish:1")).toBeLessThan(firstOrder.indexOf("body:lost"));
    expect(JSON.stringify(store.persisted)).not.toContain("Recovered body");
    expect(JSON.stringify(store.persisted)).not.toContain("POISONED-STORAGE");

    const recoveryCalls: string[] = [];
    const recovered = await resolveConfluenceSourceV1(pageRequest(), {
      exporter: "pdf",
      port: fixturePort([page], {
        onCall(method) {
          recoveryCalls.push(method);
          if (method === "getPageVersion" || method === "getChildren") {
            throw new Error("recovery rediscovered source metadata");
          }
        },
      }),
      signal: new AbortController().signal,
      sourcePlanCheckpoint: {
        jobId: "job",
        requestKey: "request",
        sourcePolicyKey: "adf-primary:v1",
        leaseEpoch: 2,
        store,
        async publishCheckpointRef(ref) {
          expect(ref).toBe("source-plan:checkpoint");
          recoveryCalls.push("publish:2");
        },
      },
    });

    expect(recovered.blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Recovered body" }] },
    ]);
    expect(recoveryCalls).toEqual([
      "createTreeSource",
      "publish:2",
      "getPage",
    ]);
    expect(store.persisted?.checkpoint.committedLeaseEpoch).toBe(1);
  });

  it("rejects a foreign source-plan policy before constructing a source port", async () => {
    const store = new MemorySourcePlanStore();
    const page: FixturePage = {
      id: "root",
      title: "Root",
      version: 1,
      parent: null,
      position: 0,
      source: adfSource("unused"),
    };
    await resolveConfluenceSourceV1(pageRequest(), {
      exporter: "word",
      port: fixturePort([page]),
      signal: new AbortController().signal,
      sourcePlanCheckpoint: {
        jobId: "job",
        requestKey: "request",
        sourcePolicyKey: "adf-primary:v1",
        leaseEpoch: 1,
        store,
        async publishCheckpointRef() {},
      },
    });
    let created = 0;
    const failure = await resolveConfluenceSourceV1(pageRequest(), {
      exporter: "word",
      port: fixturePort([page], {
        onCall(method) {
          if (method === "createTreeSource") created += 1;
        },
      }),
      signal: new AbortController().signal,
      sourcePlanCheckpoint: {
        jobId: "job",
        requestKey: "request",
        sourcePolicyKey: "storage-primary:v1",
        leaseEpoch: 2,
        store,
        async publishCheckpointRef() {},
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConfluenceSourceResolutionError);
    expect(created).toBe(0);
  });

  it("stops after cancellation during source-plan commit without publishing or reading a body", async () => {
    const controller = new AbortController();
    let published = 0;
    let bodyReads = 0;
    const page: FixturePage = {
      id: "root",
      title: "Root",
      version: 1,
      parent: null,
      position: 0,
      source: adfSource("must-not-be-read"),
    };
    const store: ConfluenceSourcePlanStoreV1 = {
      async load() { return undefined; },
      async commit() {
        controller.abort(new DOMException("cancelled during source-plan commit", "AbortError"));
        return "source-plan:cancelled";
      },
    };

    const failure = await resolveConfluenceSourceV1(pageRequest(), {
      exporter: "pdf",
      port: fixturePort([page], {
        async getPage() {
          bodyReads += 1;
          throw new Error("body should not be read");
        },
      }),
      signal: controller.signal,
      sourcePlanCheckpoint: {
        jobId: "job",
        requestKey: "request",
        sourcePolicyKey: "adf-primary:v1",
        leaseEpoch: 1,
        store,
        async publishCheckpointRef() { published += 1; },
      },
    }).catch((error: unknown) => error);

    expect(failure).toBe(controller.signal.reason);
    expect({ published, bodyReads }).toEqual({ published: 0, bodyReads: 0 });
  });

  it("emits aggregate progress and sanitizes source failures before the job boundary", async () => {
    const progress: unknown[] = [];
    const successful = await resolveConfluenceSourceV1(pageRequest(), {
      exporter: "pdf",
      port: fixturePort([
        {
          id: "root",
          title: "CONFIDENTIAL-TITLE",
          version: 1,
          parent: null,
          position: 0,
          source: adfSource("CONFIDENTIAL-BODY"),
        },
      ]),
      signal: new AbortController().signal,
      onProgress: (event) => progress.push(event),
    });
    expect(successful.blocks).toHaveLength(1);
    expect(progress).toEqual([{ fetched: 1, total: 1 }]);
    expect(JSON.stringify(progress)).not.toContain("CONFIDENTIAL");

    const failure = await resolveConfluenceSourceV1(pageRequest(), {
      exporter: "pdf",
      port: fixturePort([
        {
          id: "root",
          title: "Root",
          version: 1,
          parent: null,
          position: 0,
          source: adfSource("unused"),
        },
      ], {
        getPage: async () => {
          throw new Error("CONFIDENTIAL-BODY-FRAGMENT");
        },
      }),
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ConfluenceSourceResolutionError);
    expect(JSON.stringify(failure)).not.toContain("CONFIDENTIAL");
    expect(String(failure)).not.toContain("CONFIDENTIAL");
  });

  it("resolves content keys without a body read and composes one shared tree for both engines", async () => {
    const extensionContent = [{
      type: "extension",
      attrs: { extensionType: "example", extensionKey: "widget", localId: "local" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "Visible fallback" }] }],
    }];
    const port = fixturePort([
      {
        id: "root",
        title: "Root",
        version: 3,
        parent: null,
        position: 0,
        source: adfSource("root", 3, extensionContent),
      },
      {
        id: "child",
        title: "Child",
        version: 2,
        parent: "root",
        position: 0,
        source: adfSource("child", 2),
      },
    ], { contentKey: "human-readable-key" });
    const request: ExportSourceV1 = {
      ...pageRequest({ kind: "content-key", value: "human-readable-key" }),
      scope: { kind: "tree" },
    };
    const result = await resolveConfluenceSourceV1(request, {
      exporter: "pdf",
      port,
      signal: new AbortController().signal,
    });

    const pdfInput = {
      blocks: result.blocks,
      sourceNotes: result.sourceNotes,
      complete: result.complete,
    };
    const docxInput = {
      blocks: result.blocks,
      sourceNotes: result.sourceNotes,
      complete: result.complete,
    };
    expect(docxInput).toEqual(pdfInput);
    expect(result.pageCount).toBe(2);
    expect(result.pages.map((page) => page.id)).toEqual(["root", "child"]);
    expect(result.chapterAnchorById?.has("child")).toBe(true);
    expect(result.sourceNotes.some((note) =>
      note.code === "macro-not-rendered" && note.macroName === "widget"
    )).toBe(true);
    expect(result.sourceSummary.representations).toEqual({ atlas_doc_format: 2, storage: 0 });
  });

  it("fails before the first body read when a durable version pin changed", async () => {
    let pageReads = 0;
    const error = await resolveConfluenceSourceV1(
      pageRequest({ kind: "page-id", id: "root", version: 7 }),
      {
        exporter: "pdf",
        port: fixturePort([
          {
            id: "root",
            title: "Root",
            version: 8,
            parent: null,
            position: 0,
            source: adfSource("must not be read", 8),
          },
        ], {
          onCall: (method) => {
            if (method === "getPage") pageReads += 1;
          },
        }),
        signal: new AbortController().signal,
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfluenceSourceVersionMismatchError);
    expect(pageReads).toBe(0);
    expect(String((error as Error).message)).not.toContain("root");
    expect(String((error as Error).message)).not.toContain("must not be read");
  });

  for (const completenessMode of ["strict", "partial"] as const) {
    it(`${completenessMode} never hides malformed ADF behind its Storage sidecar`, async () => {
      const malformed: ExportPageSource = {
        primary: { representation: "atlas_doc_format", value: "not-json" },
        storageSidecar: "<p>HIDDEN-SUCCESS</p>",
        sourceVersion: 1,
      };
      const outcome = await resolveConfluenceSourceV1(
        { ...pageRequest(), completenessMode },
        {
          exporter: "word",
          port: fixturePort([
            {
              id: "root",
              title: "Root",
              version: 1,
              parent: null,
              position: 0,
              source: malformed,
            },
          ]),
          signal: new AbortController().signal,
        },
      ).catch((caught: unknown) => caught);

      if (completenessMode === "strict") {
        expect(outcome).toBeInstanceOf(Error);
        expect(String(outcome)).not.toContain("HIDDEN-SUCCESS");
      } else {
        const partial = outcome as ResolvedConfluenceSourceV1;
        expect(partial.complete).toBe(false);
        expect(JSON.stringify(partial.blocks)).toContain("Content unavailable");
        expect(JSON.stringify(partial)).not.toContain("HIDDEN-SUCCESS");
      }
    });
  }

  it("forwards cancellation to every in-flight page read", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const stopped: string[] = [];
    const waitForAbort: TreeSource["getPage"] = async (id, context) => {
      started.push(id);
      await new Promise<void>((_resolve, reject) => {
        context.signal?.addEventListener("abort", () => {
          stopped.push(id);
          reject(context.signal?.reason);
        }, { once: true });
      });
      throw new Error("unreachable");
    };
    const pages = ["root", "a", "b", "c"].map((id, index): FixturePage => ({
      id,
      title: id,
      version: 1,
      parent: id === "root" ? null : "root",
      position: index,
      source: adfSource(id),
    }));
    const pending = resolveConfluenceSourceV1(
      {
        ...pageRequest(),
        scope: { kind: "tree" },
      },
      {
        exporter: "pdf",
        port: fixturePort(pages, { getPage: waitForAbort }),
        signal: controller.signal,
      },
    );

    while (started.length < 4) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toThrow();
    expect(stopped.sort()).toEqual(started.sort());
  });
});
