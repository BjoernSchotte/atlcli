import { describe, expect, it } from "bun:test";
import type { ExportBlock, ExportNode, ExportScope } from "@atlcli/confluence/browser";
import { pdfBytesFromUint8Array, type PdfExportReport } from "@atlcli/pdf/browser";
import { PREVIEW_SUPERSEDED_ERROR } from "../../utils/pdf/compiler-host.js";
import {
  ASSUMED_IMAGE_BYTES,
  DEFAULT_PREVIEW_BUDGET,
  PREVIEW_DEBOUNCE_MS,
  capturePdfOutput,
  countImageRefs,
  createPreviewScheduler,
  planPreviewTruncation,
  previewCacheParts,
  previewNodeVersions,
  runPagePdfPreview,
} from "../../utils/pdf/preview.js";
import type { LoadedPage } from "../../utils/read-path.js";

function pageNode(id: string, blocks: ExportBlock[] = [], version = 1): ExportNode {
  return {
    kind: "page",
    pageId: id,
    title: `Page ${id}`,
    depth: 1,
    effectiveDepth: 1,
    parentId: null,
    position: null,
    blocks,
    notes: [],
    meta: { version, labels: [] },
  };
}

function paragraphs(count: number): ExportBlock[] {
  return Array.from({ length: count }, () => ({
    type: "paragraph" as const,
    content: [{ type: "text" as const, text: "x" }],
  }));
}

function images(count: number): ExportBlock[] {
  return Array.from({ length: count }, () => ({
    type: "image" as const,
    source: { kind: "attachment" as const, filename: "a.png" },
  }));
}

const PAGE_SCOPE: ExportScope = { kind: "page", pageId: "1" };
const TREE_SCOPE: ExportScope = { kind: "tree", rootPageId: "1", maxDepth: 5 };

describe("planPreviewTruncation", () => {
  it("compiles the WHOLE document for scope: page — the CONFCLOUD-84742 case", () => {
    const nodes = Array.from({ length: 40 }, (_, i) => pageNode(String(i), paragraphs(50)));
    const plan = planPreviewTruncation(nodes, PAGE_SCOPE);
    expect(plan.truncated).toBe(false);
    expect(plan.nodes).toHaveLength(40);
    expect(plan.reason).toBe("none");
  });

  it("truncates a tree to the first N chapters", () => {
    const nodes = Array.from({ length: 12 }, (_, i) => pageNode(String(i)));
    const plan = planPreviewTruncation(nodes, TREE_SCOPE);
    expect(plan.includedChapters).toBe(DEFAULT_PREVIEW_BUDGET.maxChapters);
    expect(plan.totalChapters).toBe(12);
    expect(plan.truncated).toBe(true);
    expect(plan.reason).toBe("chapters");
  });

  it("does not report truncation when the tree fits inside the budget", () => {
    const nodes = [pageNode("a"), pageNode("b")];
    const plan = planPreviewTruncation(nodes, TREE_SCOPE);
    expect(plan.truncated).toBe(false);
    expect(plan.reason).toBe("none");
    expect(plan.includedChapters).toBe(2);
  });

  // The backstop that matters: one dense chapter counts as "1" against the
  // chapter budget but can dominate compile time on its own.
  it("stops on the block backstop before the chapter budget is reached", () => {
    const nodes = [pageNode("a", paragraphs(400)), pageNode("b", paragraphs(400)), pageNode("c")];
    const plan = planPreviewTruncation(nodes, TREE_SCOPE, { budget: { maxBlocks: 500 } });
    expect(plan.includedChapters).toBe(1);
    expect(plan.truncated).toBe(true);
    expect(plan.reason).toBe("blocks");
  });

  it("stops on the asset-byte backstop", () => {
    const nodes = [pageNode("a", images(20)), pageNode("b", images(20))];
    const plan = planPreviewTruncation(nodes, TREE_SCOPE, {
      budget: { maxAssetBytes: 25 * ASSUMED_IMAGE_BYTES },
    });
    expect(plan.includedChapters).toBe(1);
    expect(plan.reason).toBe("assetBytes");
  });

  it("uses a caller-supplied byte estimator when real attachment sizes are known", () => {
    const nodes = [pageNode("a", images(1)), pageNode("b", images(1)), pageNode("c", images(1))];
    const plan = planPreviewTruncation(nodes, TREE_SCOPE, {
      budget: { maxAssetBytes: 10 },
      estimateNodeAssetBytes: () => 6,
    });
    expect(plan.includedChapters).toBe(1);
    expect(plan.reason).toBe("assetBytes");
  });

  it("always keeps the first chapter, even when it alone busts every backstop", () => {
    const nodes = [pageNode("huge", [...paragraphs(5_000), ...images(500)]), pageNode("b")];
    const plan = planPreviewTruncation(nodes, TREE_SCOPE, {
      budget: { maxBlocks: 1, maxAssetBytes: 1 },
    });
    expect(plan.includedChapters).toBe(1);
    expect(plan.nodes[0]).toBe(nodes[0]!);
  });

  it("counts nested image references for the default estimate", () => {
    const nested: ExportBlock[] = [
      {
        type: "table",
        rows: [{ cells: [{ header: false, colspan: 1, rowspan: 1, content: images(3) }] }],
      },
      { type: "callout", kind: "info", content: images(2) },
      { type: "list", ordered: false, items: [{ content: images(1) }] },
    ];
    expect(countImageRefs(nested)).toBe(6);
  });
});

describe("previewNodeVersions", () => {
  it("captures every node's version, not only the root's", () => {
    const versions = previewNodeVersions([pageNode("root", [], 7), pageNode("child", [], 3)]);
    expect(versions).toEqual([
      { id: "root", version: 7 },
      { id: "child", version: 3 },
    ]);
  });

  it("keeps folders (which have no version) distinguishable", () => {
    const folder: ExportNode = {
      kind: "folder",
      folderId: "f1",
      title: "Folder",
      depth: 1,
      effectiveDepth: 1,
      parentId: null,
      position: null,
    };
    expect(previewNodeVersions([folder])).toEqual([{ id: "f1", version: null }]);
  });
});

describe("previewCacheParts", () => {
  const base = {
    pageUrl: "https://x.atlassian.net/wiki/p/1",
    page: { id: "1", version: 3 },
    scope: PAGE_SCOPE,
  };

  it("folds the scope discriminator into the source identity", async () => {
    const page = await previewCacheParts(base);
    const tree = await previewCacheParts({ ...base, scope: TREE_SCOPE });
    expect(page.sourceIdentity).toContain("https://x.atlassian.net/wiki/p/1|1|3|");
    // A tree export of the same root page produces different bytes; it must
    // never reuse a single-page cache entry.
    expect(page.sourceIdentity).not.toBe(tree.sourceIdentity);
  });

  it("distinguishes label filters", async () => {
    const unfiltered = await previewCacheParts({ ...base, scope: TREE_SCOPE });
    const filtered = await previewCacheParts({
      ...base,
      scope: TREE_SCOPE,
      labels: { include: ["public"] },
    });
    expect(unfiltered.sourceIdentity).not.toBe(filtered.sourceIdentity);
  });

  it("changes when a CHILD page's version changes — not only the root's", async () => {
    const before = await previewCacheParts({
      ...base,
      scope: TREE_SCOPE,
      nodes: [pageNode("1", [], 3), pageNode("2", [], 1)],
    });
    const after = await previewCacheParts({
      ...base,
      scope: TREE_SCOPE,
      nodes: [pageNode("1", [], 3), pageNode("2", [], 2)],
    });
    expect(before.sourceIdentity).toBe(after.sourceIdentity);
    expect(before.treeVersionHash).not.toBe(after.treeVersionHash);
  });

  it("changes when the resolved settings change", async () => {
    const a = await previewCacheParts({ ...base, settings: { pageSize: "A4" } });
    const b = await previewCacheParts({ ...base, settings: { pageSize: "Letter" } });
    expect(a.settingsHash).not.toBe(b.settingsHash);
  });
});

describe("capturePdfOutput", () => {
  it("keeps the handle instead of downloading it", async () => {
    const captured = capturePdfOutput();
    expect(captured.bytes).toBeUndefined();
    const handle = pdfBytesFromUint8Array(new Uint8Array([1, 2, 3]));
    await captured.sink.emit("doc.pdf", handle);
    expect(captured.bytes).toBe(handle);
    expect(captured.filename).toBe("doc.pdf");
  });
});

const loadedPage = {
  details: { id: "1", title: "T", storage: "<p/>", version: 2 },
  markdown: "",
  wordCount: 0,
  attachments: [],
} as unknown as LoadedPage;

const report = { filename: "T.pdf" } as unknown as PdfExportReport;

describe("runPagePdfPreview", () => {
  it("runs the REAL export pipeline with a capture sink and a preview-tagged port", async () => {
    let sawPreviewPort = false;
    let emitted: string | undefined;
    const result = await runPagePdfPreview(
      { page: loadedPage, pageUrl: "https://x.atlassian.net/wiki/p/1" },
      {
        createCompilePort: () => {
          sawPreviewPort = true;
          return { compile: async () => ({ diagnostics: [], compilerVersion: "v" }) };
        },
        runExport: async (_input, overrides) => {
          emitted = "ran";
          await overrides?.output?.emit("T.pdf", pdfBytesFromUint8Array(new Uint8Array([1])));
          return report;
        },
      }
    );
    expect(emitted).toBe("ran");
    expect(sawPreviewPort).toBe(false); // the port is passed through, not called here
    expect(result.status).toBe("ready");
    expect(result.truncated).toBe(false);
    expect(result.bytes?.size).toBe(1);
    expect(result.filename).toBe("T.pdf");
  });

  it("reports a superseded preview as a status, not an error", async () => {
    const result = await runPagePdfPreview(
      { page: loadedPage, pageUrl: "https://x.atlassian.net/wiki/p/1" },
      {
        runExport: async () => {
          throw new Error(PREVIEW_SUPERSEDED_ERROR);
        },
      }
    );
    expect(result.status).toBe("superseded");
    expect(result.bytes).toBeUndefined();
  });

  it("still propagates a real compile failure", async () => {
    await expect(
      runPagePdfPreview(
        { page: loadedPage, pageUrl: "https://x.atlassian.net/wiki/p/1" },
        {
          runExport: async () => {
            throw new Error("Typst exploded");
          },
        }
      )
    ).rejects.toThrow("Typst exploded");
  });
});

describe("createPreviewScheduler", () => {
  it("coalesces a burst into one run after the quiet period", () => {
    let fire: (() => void) | null = null;
    let delay = 0;
    const runs: string[] = [];
    const scheduler = createPreviewScheduler({
      schedule: (fn, ms) => {
        fire = fn;
        delay = ms;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clear: () => undefined,
    });
    scheduler.request(() => runs.push("a"));
    scheduler.request(() => runs.push("b"));
    scheduler.request(() => runs.push("c"));
    expect(delay).toBe(PREVIEW_DEBOUNCE_MS);
    expect(runs).toEqual([]);
    fire!();
    expect(runs).toEqual(["c"]);
    expect(scheduler.pending).toBe(false);
  });

  it("cancel() drops the pending run entirely", () => {
    let fire: (() => void) | null = null;
    const runs: string[] = [];
    const scheduler = createPreviewScheduler({
      schedule: (fn) => {
        fire = fn;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clear: () => undefined,
    });
    scheduler.request(() => runs.push("a"));
    scheduler.cancel();
    fire!();
    expect(runs).toEqual([]);
  });

  it("flush() runs the pending request immediately", () => {
    const runs: string[] = [];
    const scheduler = createPreviewScheduler({
      schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clear: () => undefined,
    });
    scheduler.request(() => runs.push("a"));
    scheduler.flush();
    expect(runs).toEqual(["a"]);
    scheduler.flush();
    expect(runs).toEqual(["a"]);
  });
});
