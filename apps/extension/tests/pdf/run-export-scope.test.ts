/**
 * Scope + macro wiring for the extension's PDF host (spec 010 T5.1 / T5.4).
 *
 * NO HTTP MOCKING. The tree walk runs against an in-memory `TreeSource` — a
 * legitimate implementation of folder 002's PORT, not a fake transport — and
 * everything that really does speak HTTP (the macro `export_view` batch) goes
 * through the REAL `ConfluenceClient` over hand-constructed REAL `Response`
 * objects, the pattern `tests/macros/session-ports.test.ts` established.
 *
 * The security half of this file is not decoration. Wiring `macros` into an
 * engine env whose asset seam is not policy-routed turns
 * `<img src="http://169.254.169.254/…">` inside third-party macro HTML into a
 * request the panel makes from inside the user's authenticated session. The
 * shared probes from `@atlcli/export-wiring/fixtures` are asserted against BOTH
 * engines' composed seams, plus a structural check that no second `assets:`
 * construction site can appear in `run-export.ts` and quietly bypass the router.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExportBlock,
  ExportScope,
  TreeChild,
  TreeFetchContext,
  TreeFetchProgress,
  TreeSource,
} from "@atlcli/confluence/browser";
import type { MacroResolutionOptions } from "@atlcli/export-macros";
import type { PdfSourceBundle } from "@atlcli/pdf/browser";
import {
  assertPdfEnvMacroAssetRule,
  assertPolicyRoutedPdfAssets,
  EXTERNAL_ASSET_POLICY_FIXTURES,
  POLICY_FIXTURE_SITE_ORIGIN,
  TRUST_ROUTING_PROBE_REF,
} from "@atlcli/export-wiring/fixtures";
import type { LoadedPage } from "../../utils/read-path.js";
import {
  extensionPdfAssets,
  pdfSourceIdentity,
  runPdfExport,
  scopeLabelFor,
} from "../../utils/pdf/run-export.js";
import { sessionDocxAssets } from "../../utils/docx/env.js";
import { isExternalAssetBlockedError } from "../../utils/macros/external-asset-policy.js";
import { resolveExportComposition } from "../../utils/confluence/export-composition.js";

const SITE = "https://fixture.atlassian.net";
const PAGE_URL = `${SITE}/wiki/spaces/DOCSY/pages/1/Root`;

const validPdf = new TextEncoder().encode(
  "%PDF-1.7\n/Type/Page /StructTreeRoot /MarkInfo /Outlines /FontFile2\n%%EOF\n"
);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function installFetch(handler: (url: string) => Response): string[] {
  const urls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(handler(String(input)));
  }) as unknown as typeof fetch;
  return urls;
}

/** The panel's loaded root page. Its storage only matters for `page` scope. */
function loadedPage(storage = "<h2>Overview</h2><p>Root body.</p>"): LoadedPage {
  return {
    details: {
      id: "1",
      title: "Root",
      spaceKey: "DOCSY",
      version: 4,
      modifiedBy: { accountId: "a1", displayName: "Ada" },
      storage,
    },
    markdown: "",
    wordCount: 0,
    attachments: [],
  };
}

// ---------------------------------------------------------------------------
// In-memory TreeSource — a port implementation, not an API mock
// ---------------------------------------------------------------------------

interface FixturePage {
  id: string;
  title: string;
  parent: string | null;
  storage?: string;
  version?: number;
  /** Artificial latency so an abort can land mid-walk. */
  latencyMs?: number;
}

interface FakeTreeSource extends TreeSource {
  getPageIds: string[];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function fakeTreeSource(fixture: FixturePage[], homepage?: string | null): FakeTreeSource {
  const byId = new Map(fixture.map((page) => [page.id, page]));
  const getPageIds: string[] = [];
  return {
    getPageIds,
    async getPage(id, context: TreeFetchContext) {
      getPageIds.push(id);
      const page = byId.get(id);
      if (!page) throw new Error("Confluence API error (404): simulated");
      if (page.latencyMs) await sleep(page.latencyMs, context.signal);
      context.signal?.throwIfAborted();
      return {
        id: page.id,
        title: page.title,
        storage: page.storage ?? `<p>${page.title} body.</p>`,
        version: page.version ?? 1,
        labels: [],
        spaceKey: "DOCSY",
      };
    },
    async getPageVersion(id, context: TreeFetchContext) {
      context.signal?.throwIfAborted();
      const page = byId.get(id);
      if (!page) throw new Error("Confluence API error (404): simulated");
      return { version: page.version ?? 1, title: page.title };
    },
    async getChildren(nodeRef, context: TreeFetchContext) {
      context.signal?.throwIfAborted();
      return fixture
        .filter((page) => page.parent === nodeRef.id)
        .map((page, index): TreeChild => ({
          id: page.id,
          title: page.title,
          kind: "page",
          position: index,
          observedVersion: page.version ?? 1,
        }));
    },
    async getSpaceHomepageId(_spaceKey, context: TreeFetchContext) {
      context.signal?.throwIfAborted();
      return homepage ?? null;
    },
  };
}

const TREE_FIXTURE: FixturePage[] = [
  { id: "1", title: "Root", parent: null, version: 4 },
  { id: "2", title: "Alpha", parent: "1", version: 5 },
  { id: "3", title: "Beta", parent: "1", version: 7 },
];

const treeScope: ExportScope = {
  kind: "tree",
  rootPageId: "1",
  includeRoot: true,
  maxDepth: 5,
};

interface RunCapture {
  bundle?: PdfSourceBundle;
  sourceIdentity?: string;
  compiles: number;
  blocks?: ExportBlock[];
  progress: TreeFetchProgress[];
}

interface RunOptions {
  source?: TreeSource;
  /** Select a bounded chapter prefix through the same seam used by PDF preview. */
  selectFirstNodes?: number;
  /**
   * Use the PRODUCTION macro factory (`buildSessionMacroResolutionOptions` via
   * `run-export.ts`'s own default) instead of disabling macros. Off by default
   * so a scope assertion is not entangled with the macro chain; ON is how the
   * per-source-page cases test the real wiring rather than the test's own.
   */
  realMacros?: boolean;
}

/** Drive the real `runPdfExport` with the tree source injected. */
async function run(
  input: Parameters<typeof runPdfExport>[0],
  options: RunOptions = {}
): Promise<RunCapture> {
  const source = options.source ?? fakeTreeSource(TREE_FIXTURE);
  const capture: RunCapture = { compiles: 0, progress: [] };
  await runPdfExport(
    {
      ...input,
      onProgress: (progress) => capture.progress.push({ ...progress }),
    },
    {
      now: () => 1_000,
      locale: () => "en",
      createTreeSource: () => source,
      ...(options.selectFirstNodes === undefined
        ? {}
        : {
            resolveComposition: (input, overrides) =>
              resolveExportComposition(
                {
                  ...input,
                  selectNodes: (nodes) => nodes.slice(0, options.selectFirstNodes),
                },
                overrides
              ),
          }),
      // Omitted entirely when `realMacros` is set, so `defaultDeps` supplies
      // the production factory.
      ...(options.realMacros ? {} : { createMacros: () => undefined }),
      resolveMentions: async (blocks) => {
        capture.blocks = blocks;
        return { blocks, unresolved: 0 };
      },
      resolver: { resolve: async () => { throw new Error("no assets in this fixture"); } },
      createCompilePort: ({ sourceIdentity, onQueued, onCompiling }) => {
        capture.sourceIdentity = sourceIdentity;
        return {
          async compile(bundle) {
            capture.compiles += 1;
            capture.bundle = bundle;
            onQueued();
            onCompiling();
            return { pdf: validPdf, diagnostics: [], compilerVersion: "test" };
          },
        };
      },
      output: { emit: async () => undefined },
    }
  );
  return capture;
}

// ---------------------------------------------------------------------------

describe("scope wiring (T5.1)", () => {
  it("hands the COMPOSED chapters to the neutral engine, in document order", async () => {
    const capture = await run({ page: loadedPage(), pageUrl: PAGE_URL, scope: treeScope });

    // Composition's own shape: one chapter heading per page, in tree order,
    // separated by page breaks. This is `composeChapters`' output, not a
    // per-page concatenation the host invented.
    const headings = (capture.blocks ?? [])
      .filter((block): block is Extract<ExportBlock, { type: "heading" }> => block.type === "heading")
      .map((block) => block.content.map((node) => ("text" in node ? node.text : "")).join(""));
    expect(headings).toEqual(["Root", "Alpha", "Beta"]);
    expect((capture.blocks ?? []).some((block) => block.type === "pageBreak")).toBe(true);

    // …and they really reached the compiler, not just the mention seam.
    expect(capture.bundle?.main).toContain("Alpha");
    expect(capture.bundle?.main).toContain("Beta");
    expect(capture.compiles).toBe(1);
  });

  it("lets preview select a chapter prefix only after the shared tree walk", async () => {
    const source = fakeTreeSource(TREE_FIXTURE);
    const capture = await run(
      { page: loadedPage(), pageUrl: PAGE_URL, scope: treeScope },
      { source, selectFirstNodes: 2 }
    );
    const headings = (capture.blocks ?? [])
      .filter((block): block is Extract<ExportBlock, { type: "heading" }> => block.type === "heading")
      .map((block) => block.content.map((node) => ("text" in node ? node.text : "")).join(""));

    expect(source.getPageIds).toEqual(["1", "2", "3"]);
    expect(headings).toEqual(["Root", "Alpha"]);
  });

  it("a single-page scope issues no walk and keeps today's single-page body", async () => {
    const source = fakeTreeSource(TREE_FIXTURE);
    const capture = await run(
      { page: loadedPage(), pageUrl: PAGE_URL, scope: { kind: "page", pageId: "1" } },
      { source }
    );
    expect(source.getPageIds).toEqual([]);
    expect(capture.progress).toEqual([]);
    expect(capture.bundle?.main).toContain("Overview");
    expect(capture.bundle?.main).not.toContain("Alpha");
  });

  it("resolves a space scope through the source's homepage id", async () => {
    const source = fakeTreeSource(TREE_FIXTURE, "1");
    const capture = await run(
      { page: loadedPage(), pageUrl: PAGE_URL, scope: { kind: "space", spaceKey: "DOCSY" } },
      { source }
    );
    expect(source.getPageIds).toEqual(["1", "2", "3"]);
    expect(capture.bundle?.main).toContain("Beta");
  });

  it("forwards onProgress in document order, one tick per fetched body", async () => {
    const capture = await run({ page: loadedPage(), pageUrl: PAGE_URL, scope: treeScope });
    expect(capture.progress.map((p) => p.fetched)).toEqual([1, 2, 3]);
    expect(capture.progress.map((p) => p.currentTitle)).toEqual(["Root", "Alpha", "Beta"]);
    expect(capture.progress.at(-1)?.total).toBe(3);
  });
});

describe("sourceIdentity discriminates the scope", () => {
  it("differs between a page export and a tree export of the SAME root", async () => {
    const page = await run(
      { page: loadedPage(), pageUrl: PAGE_URL, scope: { kind: "page", pageId: "1" } }
    );
    const tree = await run({ page: loadedPage(), pageUrl: PAGE_URL, scope: treeScope });

    expect(page.sourceIdentity).toBeDefined();
    expect(tree.sourceIdentity).toBeDefined();
    // The regression this guards: `pageUrl|id|version` alone is identical for
    // both, so a compile cache would have served the single page's bytes for a
    // whole-handbook export.
    expect(tree.sourceIdentity).not.toBe(page.sourceIdentity);
    expect(page.sourceIdentity).toStartWith(`${PAGE_URL}|1|4|`);
  });

  it("a label filter changes the identity; label ORDER does not", () => {
    const base = { pageUrl: PAGE_URL, scope: treeScope } as const;
    const root = { id: "1", version: 4 };
    const unfiltered = pdfSourceIdentity(base, root);
    const filtered = pdfSourceIdentity(
      { ...base, labels: { include: ["handbook", "public"] } },
      root
    );
    const reordered = pdfSourceIdentity(
      { ...base, labels: { include: ["public", "handbook"] } },
      root
    );
    expect(filtered).not.toBe(unfiltered);
    expect(reordered).toBe(filtered);
  });

  it("no scope is identical to an explicit page scope over the same root", () => {
    const root = { id: "1", version: 4 };
    expect(pdfSourceIdentity({ pageUrl: PAGE_URL }, root)).toBe(
      pdfSourceIdentity({ pageUrl: PAGE_URL, scope: { kind: "page", pageId: "1" } }, root)
    );
  });
});

describe("cancel reaches the WALK, not only the compile", () => {
  it("aborting mid-walk stops fetching and never reaches the compile port", async () => {
    const controller = new AbortController();
    const slowTree: FixturePage[] = [
      { id: "1", title: "Root", parent: null, version: 4 },
      { id: "2", title: "Alpha", parent: "1", version: 5, latencyMs: 5_000 },
      { id: "3", title: "Beta", parent: "1", version: 7, latencyMs: 5_000 },
    ];
    const source = fakeTreeSource(slowTree);
    let compilePortsCreated = 0;

    const promise = runPdfExport(
      { page: loadedPage(), pageUrl: PAGE_URL, scope: treeScope, signal: controller.signal },
      {
        now: () => 1_000,
        locale: () => "en",
        createTreeSource: () => source,
        createMacros: () => undefined,
        resolveMentions: async (blocks) => ({ blocks, unresolved: 0 }),
        resolver: { resolve: async () => { throw new Error("unused"); } },
        createCompilePort: () => {
          compilePortsCreated += 1;
          return { compile: async () => ({ pdf: validPdf, diagnostics: [], compilerVersion: "test" }) };
        },
        output: { emit: async () => undefined },
      }
    );
    // Let the walk start, then cancel while two page bodies are in flight.
    await Promise.resolve();
    controller.abort();

    const error = await promise.then(() => undefined, (e: unknown) => e);
    expect(error).toBeDefined();
    // No job is ever handed to the compiler — the abort landed in the walk.
    expect(compilePortsCreated).toBe(0);
    // And the walk stopped: the two slow children never completed.
    expect(source.getPageIds.length).toBeLessThanOrEqual(3);
  });
});

describe("macro resolution is per SOURCE page (Architecture point 6)", () => {
  /**
   * The regression: a macro sitting on a CHILD page of a tree export must
   * resolve against THAT page. Substituting the export root's id here renders
   * the wrong page's macro body while the report reads "rendered".
   */
  const MACRO_STORAGE = `<ac:structured-macro ac:name="fancy-app" ac:macro-id="m1"/>`;

  function exportViewResponse(url: string): Response {
    const id = url.includes("/content/3") ? "3" : url.includes("/content/2") ? "2" : "1";
    return new Response(
      JSON.stringify({
        id,
        body: { export_view: { value: `<div data-macro-id="m1"><p>Rendered on ${id}</p></div>` } },
        version: { number: Number(id) },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  it("uses the macro's OWN page id, never the export root's", async () => {
    const urls = installFetch(exportViewResponse);
    const fixture: FixturePage[] = [
      { id: "1", title: "Root", parent: null, version: 4, storage: "<p>No macro here.</p>" },
      { id: "3", title: "Beta", parent: "1", version: 7, storage: MACRO_STORAGE },
    ];
    await run(
      { page: loadedPage(), pageUrl: PAGE_URL, scope: treeScope },
      // The REAL session macro builder — this is the wiring under test.
      { source: fakeTreeSource(fixture), realMacros: true }
    );

    const exportViewCalls = urls.filter((url) => url.includes("/rest/api/content/"));
    expect(exportViewCalls.length).toBeGreaterThan(0);
    expect(exportViewCalls.some((url) => url.includes("/rest/api/content/3?"))).toBe(true);
    expect(exportViewCalls.some((url) => url.includes("/rest/api/content/1?"))).toBe(false);
  });

  it("the rendered body is the CHILD page's, and it reaches the compiler", async () => {
    installFetch(exportViewResponse);
    const fixture: FixturePage[] = [
      { id: "1", title: "Root", parent: null, version: 4, storage: "<p>No macro here.</p>" },
      { id: "3", title: "Beta", parent: "1", version: 7, storage: MACRO_STORAGE },
    ];
    const capture = await run(
      { page: loadedPage(), pageUrl: PAGE_URL, scope: treeScope },
      { source: fakeTreeSource(fixture), realMacros: true }
    );
    expect(capture.bundle?.main).toContain("Rendered on 3");
    expect(capture.bundle?.main).not.toContain("Rendered on 1");
  });

  it("`resolveMacros: false` makes no port call at all", async () => {
    const urls = installFetch(exportViewResponse);
    const fixture: FixturePage[] = [
      { id: "1", title: "Root", parent: null, version: 4, storage: MACRO_STORAGE },
    ];
    await run(
      {
        page: loadedPage(),
        pageUrl: PAGE_URL,
        scope: treeScope,
        macros: { live: false },
      },
      { source: fakeTreeSource(fixture), realMacros: true }
    );
    expect(urls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The hard security gate
// ---------------------------------------------------------------------------

/**
 * Record every outbound request and fail it immediately. The link-local
 * metadata address is unroutable, so an UNWRAPPED seam would otherwise sit in a
 * connect timeout — and "slow" is not the property under test. What is: whether
 * the request is attempted at all.
 */
function recordingFetch(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    throw new Error("connect ECONNREFUSED (stubbed transport)");
  }) as unknown as typeof fetch;
  return urls;
}

const pdfAssets = (): ReturnType<typeof extensionPdfAssets> =>
  extensionPdfAssets({ rootPageId: "1", pageUrl: PAGE_URL });

describe("PDF env — sink-side trust routing", () => {
  it("the resolver the export env receives refuses an export_view-trust metadata ref", async () => {
    const urls = recordingFetch();
    await assertPolicyRoutedPdfAssets(pdfAssets());
    // Blocked BEFORE the transport: the metadata service sees nothing at all.
    expect(urls).toEqual([]);
  });

  it("guard-the-guard: an unwrapped inner resolver FAILS the assertion and hits the network", async () => {
    const urls = recordingFetch();
    const bare = {
      async resolve(ref: { url?: string }) {
        await fetch(ref.url ?? "");
        return { bytes: new Uint8Array(), mediaType: "image/png" };
      },
    };
    await expect(assertPolicyRoutedPdfAssets(bare)).rejects.toThrow(
      /not wrapped in trustRoutingPdfAssetResolver|NOT with an ExternalAssetBlockedError/
    );
    expect(urls.some((url) => url.includes("169.254.169.254"))).toBe(true);
  });

  it("an env that resolves macros satisfies the shared wiring rule — non-vacuously", async () => {
    recordingFetch();
    expect(
      await assertPdfEnvMacroAssetRule({
        assets: pdfAssets(),
        macros: {} as MacroResolutionOptions,
      })
    ).toBe("routed");
    // And the rule is not satisfiable by an unrouted seam.
    await expect(
      assertPdfEnvMacroAssetRule({
        assets: { resolve: async () => ({ bytes: new Uint8Array(), mediaType: "image/png" }) },
        macros: {} as MacroResolutionOptions,
      })
    ).rejects.toThrow();
  });

  it("the probe ref is the shape only third-party macro HTML can produce", () => {
    expect(TRUST_ROUTING_PROBE_REF).toMatchObject({ kind: "external", trust: "export-view" });
  });

  it("attachment refs are untouched by the router and reach the session path", async () => {
    const urls = recordingFetch();
    await pdfAssets()
      .resolve({ kind: "attachment", filename: "a.png", pageId: "42" })
      .catch(() => undefined);
    // Proof it reached the INNER resolver rather than the external fetcher:
    // the session download URL is keyed on the ref's OWN page id.
    expect(urls.some((url) => url.includes("/download/attachments/42/a.png"))).toBe(true);
  });

  it("an attachment without a page id falls back to the export root", async () => {
    const urls = recordingFetch();
    await pdfAssets().resolve({ kind: "attachment", filename: "a.png" }).catch(() => undefined);
    expect(urls.some((url) => url.includes("/download/attachments/1/a.png"))).toBe(true);
  });
});

describe("DOCX env — sink-side trust routing", () => {
  const docxAssets = (): ReturnType<typeof sessionDocxAssets> =>
    sessionDocxAssets({ pageUrl: PAGE_URL, baseUrl: `${SITE}/wiki` });

  it("refuses an export_view-trust metadata ref before the transport", async () => {
    const urls = recordingFetch();
    const error = await docxAssets()
      .fetch({ url: TRUST_ROUTING_PROBE_REF.url!, trust: "export-view" })
      .then(() => undefined, (e: unknown) => e);
    expect(isExternalAssetBlockedError(error)).toBe(true);
    expect(urls).toEqual([]);
  });

  it("guard-the-guard: the bare session fetcher DOES attempt the same request", async () => {
    const urls = recordingFetch();
    const { sessionAssetFetcher } = await import("../../utils/docx/env.js");
    await sessionAssetFetcher(`${SITE}/wiki`)
      .fetch({ url: TRUST_ROUTING_PROBE_REF.url!, trust: "export-view" })
      .catch(() => undefined);
    expect(urls.some((url) => url.includes("169.254.169.254"))).toBe(true);
  });

  it("page-trust attachment refs stay on the session path", async () => {
    const urls = recordingFetch();
    await docxAssets().fetch({ url: "/download/attachments/7/x.png" }).catch(() => undefined);
    expect(urls.some((url) => url.includes(`${SITE}/wiki/download/attachments/7/x.png`))).toBe(true);
  });
});

describe("cross-engine policy parity over the shared fixtures", () => {
  /**
   * The claim the PLAN makes (Architecture point 6): an `export_view`-sourced
   * image either renders in BOTH formats or degrades in BOTH — never a silent
   * PDF omission next to a DOCX fetch of an unauthenticated third-party URL.
   *
   * Both engines are evaluated against the fixture SITE origin, which is what
   * makes `allowed: true` fixtures meaningful here rather than "everything is
   * blocked, so of course the two agree".
   */
  const FIXTURE_PAGE_URL = `${POLICY_FIXTURE_SITE_ORIGIN}/wiki/spaces/DOCSY/pages/1/Root`;

  for (const fixture of EXTERNAL_ASSET_POLICY_FIXTURES) {
    it(`${fixture.name}: both engines agree (${fixture.reason})`, async () => {
      installFetch(() => new Response("PNGBYTES", {
        status: 200,
        headers: { "content-type": "image/png" },
      }));

      const pdfError = await extensionPdfAssets({ rootPageId: "1", pageUrl: FIXTURE_PAGE_URL })
        .resolve({ kind: "external", url: fixture.url, trust: "export-view" })
        .then(() => undefined, (e: unknown) => e);
      const docxError = await sessionDocxAssets({
        pageUrl: FIXTURE_PAGE_URL,
        baseUrl: `${POLICY_FIXTURE_SITE_ORIGIN}/wiki`,
      })
        .fetch({ url: fixture.url, trust: "export-view" })
        .then(() => undefined, (e: unknown) => e);

      expect(isExternalAssetBlockedError(pdfError)).toBe(!fixture.allowed);
      expect(isExternalAssetBlockedError(docxError)).toBe(!fixture.allowed);
      // Same verdict, stated as one assertion so a future divergence names
      // itself rather than showing up as two unrelated failures.
      expect(isExternalAssetBlockedError(pdfError)).toBe(isExternalAssetBlockedError(docxError));
    });
  }
});

describe("no PDF env construction site bypasses the router", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "..", "utils", "pdf", "run-export.ts"),
    "utf8"
  );

  it("runPdfExport is only ever handed extensionPdfAssets", () => {
    const assetsFields = [...source.matchAll(/\n\s*assets:\s*([A-Za-z0-9_]+)\(/g)].map((m) => m[1]);
    expect(assetsFields.length).toBeGreaterThan(0);
    expect([...new Set(assetsFields)]).toEqual(["extensionPdfAssets"]);
  });

  it("extensionPdfAssets composes the shared router, not a hand-rolled check", () => {
    expect(source).toContain("trustRoutingPdfAssetResolver(");
    expect(source).toContain("@atlcli/export-wiring");
  });

  it("the PDF env resolves macros, through the session builder", () => {
    expect(source).toMatch(/macros:\s*macros\.options/);
    expect(source).toContain("buildSessionMacroResolutionOptions(");
  });

  it("the DOCX host does the same, with its own router", () => {
    const envSource = readFileSync(
      join(import.meta.dir, "..", "..", "utils", "docx", "env.ts"),
      "utf8"
    );
    const resolverSource = readFileSync(
      join(import.meta.dir, "..", "..", "utils", "export-jobs", "docx-resolver.ts"),
      "utf8"
    );
    expect(envSource).toContain("trustRoutingAssetFetcher(");
    expect(resolverSource).toContain("sessionDocxAssets({");
    expect(resolverSource).toContain("buildSessionMacroResolutionOptions(");
  });
});

/**
 * Durable-job metadata (spec 010 T5.6).
 *
 * W3-C's Jobs list renders `title` / `filename` / `scopeLabel` off the job
 * record and `progress` as "Page X of Y". Without this wiring every record read
 * "Untitled export" with no scope, so three queued jobs were indistinguishable
 * — technically working, useless to read.
 */
describe("job metadata reaches the compile port", () => {
  interface PortCall {
    sourceIdentity: string;
    title?: string;
    filename?: string;
    scopeLabel?: string;
    onJobCreated?: (jobId: string) => void;
  }

  async function capturePortCall(
    input: Parameters<typeof runPdfExport>[0],
    source: TreeSource = fakeTreeSource(TREE_FIXTURE),
    progressUpdates: Array<{ jobId: string; done: number; total: number }> = []
  ): Promise<PortCall> {
    let call: PortCall | undefined;
    await runPdfExport(input, {
      now: () => 1_000,
      locale: () => "en",
      createTreeSource: () => source,
      createMacros: () => undefined,
      resolveMentions: async (blocks) => ({ blocks, unresolved: 0 }),
      resolver: { resolve: async () => { throw new Error("no assets"); } },
      updateJobProgress: async (jobId, progress) => {
        progressUpdates.push({ jobId, ...progress });
      },
      createCompilePort: (options) => {
        call = options;
        return {
          async compile() {
            options.onQueued();
            options.onCompiling();
            return { pdf: validPdf, diagnostics: [], compilerVersion: "test" };
          },
        };
      },
      output: { emit: async () => undefined },
    });
    return call!;
  }

  it("names the export: page title, download filename, scope label", async () => {
    const call = await capturePortCall({
      page: loadedPage(),
      pageUrl: PAGE_URL,
      scope: treeScope,
    });
    expect(call.title).toBe("Root");
    expect(call.filename).toBe("Root.pdf");
    expect(call.scopeLabel).toBe("Page + children (depth 5)");
  });

  it("takes the title from the WALK's root, not the tab, for a space export", async () => {
    const call = await capturePortCall(
      {
        page: loadedPage(),
        pageUrl: PAGE_URL,
        scope: { kind: "space", spaceKey: "DOCSY" },
      },
      fakeTreeSource(
        [
          { id: "10", title: "Space Home", parent: null, version: 2 },
          { id: "11", title: "Child", parent: "10", version: 3 },
        ],
        "10"
      )
    );
    expect(call.title).toBe("Space Home");
    expect(call.scopeLabel).toBe("Space DOCSY");
  });

  it("mirrors the walk's page count onto the record once it exists", async () => {
    const updates: Array<{ jobId: string; done: number; total: number }> = [];
    const call = await capturePortCall(
      { page: loadedPage(), pageUrl: PAGE_URL, scope: treeScope },
      fakeTreeSource(TREE_FIXTURE),
      updates
    );
    // Nothing is written before the record exists — the walk finishes first.
    expect(updates).toEqual([]);
    call.onJobCreated?.("job-1");
    expect(updates).toEqual([{ jobId: "job-1", done: 3, total: 3 }]);
  });

  it("writes no progress for a single-page export (there is nothing to count)", async () => {
    const updates: Array<{ jobId: string; done: number; total: number }> = [];
    const call = await capturePortCall(
      { page: loadedPage(), pageUrl: PAGE_URL, scope: { kind: "page", pageId: "1" } },
      fakeTreeSource(TREE_FIXTURE),
      updates
    );
    call.onJobCreated?.("job-2");
    expect(updates).toEqual([]);
  });
});

describe("scopeLabelFor", () => {
  it("names each scope the way the Jobs column reads it", () => {
    expect(scopeLabelFor(undefined)).toBe("Current page");
    expect(scopeLabelFor({ kind: "page", pageId: "1" })).toBe("Current page");
    expect(scopeLabelFor({ kind: "space", spaceKey: "DOCSY" })).toBe("Space DOCSY");
    expect(scopeLabelFor({ kind: "tree", rootPageId: "1", maxDepth: 3 })).toBe(
      "Page + children (depth 3)"
    );
    expect(scopeLabelFor({ kind: "tree", rootPageId: "1" })).toBe("Page + children");
  });

  it("marks a label filter, because it changes what the file contains", () => {
    expect(scopeLabelFor({ kind: "space", spaceKey: "DOCSY" }, { include: ["handbook"] })).toBe(
      "Space DOCSY (filtered)"
    );
    // An empty filter is not a filter.
    expect(scopeLabelFor({ kind: "space", spaceKey: "DOCSY" }, { include: [] })).toBe("Space DOCSY");
  });
});
