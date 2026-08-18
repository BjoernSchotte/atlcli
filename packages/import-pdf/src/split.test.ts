import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { IMPORT_DOCUMENT_SCHEMA_V2, type ImportDocumentV2 } from "@atlcli/import-core";
import { createNodePdfiumFactsAdapter } from "./node.js";
import { PDF_TABLE_POLICY_REVISION } from "./contracts.js";
import { normalizeUntaggedPdfFacts } from "./untagged.js";
import { parsePdfSplitPolicy, planPdfSplit, type PdfPlannedPageV1 } from "./split.js";

const fixtureRoot = resolve(import.meta.dir, "../../../specs/import-pdf-mvp/fixtures");

async function semantics(name: string) {
  const bytes = new Uint8Array(await readFile(resolve(fixtureRoot, name)));
  const adapter = await createNodePdfiumFactsAdapter();
  const analyzed = await adapter.analyze(bytes);
  const normalized = await normalizeUntaggedPdfFacts(analyzed.facts, analyzed.factsDigest);
  return { ...analyzed, normalized };
}

function flatten(page: PdfPlannedPageV1): PdfPlannedPageV1[] {
  return [page, ...page.children.flatMap(flatten)];
}

describe("PDF split planning", () => {
  it("keeps a short editable PDF on one page and binds repeated plans", async () => {
    const value = await semantics("simple-untagged.pdf");
    const options = { rootTitle: "Notes", policy: parsePdfSplitPolicy() };
    const first = await planPdfSplit(value.facts, value.normalized.document, value.normalized.evidence, options);
    const second = await planPdfSplit(value.facts, value.normalized.document, value.normalized.evidence, options);
    expect(first.resolved).toEqual({ kind: "single-page", reason: "short-and-editable" });
    expect(first.totalWikiPages).toBe(1);
    expect(first.sourceAssignments).toEqual([{ pageIndex: 0, plannedPageId: "pdf-page-root" }]);
    expect(first.digest).toBe(second.digest);
  });

  it("turns a heading-rich 100-page PDF into a bounded index tree with exact assignment", async () => {
    const value = await semantics("heading-rich-100.pdf");
    const plan = await planPdfSplit(value.facts, value.normalized.document, value.normalized.evidence, {
      rootTitle: "Guide",
      policy: parsePdfSplitPolicy(),
    });
    const pages = flatten(plan.root);
    expect(plan.resolved.kind).toBe("page-tree");
    expect(plan.root.splitBasis).toBe("root-index");
    expect(plan.root.sourcePageIndexes).toEqual([]);
    expect(plan.totalWikiPages).toBe(9);
    expect(plan.sourceAssignments.map((item) => item.pageIndex)).toEqual(Array.from({ length: 100 }, (_, index) => index));
    expect(pages.slice(1).every((page) => page.sourcePageIndexes.length <= 20)).toBe(true);
    expect(pages.some((page) => page.title === "Part One")).toBe(true);
    expect(pages.some((page) => page.splitBasis === "page-range" && page.title.includes("Pages"))).toBe(true);
    expect(plan.blockers).toEqual([]);
  });

  it("uses five flat 20-page ranges for a heading-poor 100-page PDF", async () => {
    const value = await semantics("heading-poor-100.pdf");
    const plan = await planPdfSplit(value.facts, value.normalized.document, value.normalized.evidence, {
      rootTitle: "Archive",
      policy: parsePdfSplitPolicy(),
    });
    expect(plan.totalWikiPages).toBe(6);
    expect(plan.root.children.map((page) => page.sourcePageIndexes.length)).toEqual([20, 20, 20, 20, 20]);
    expect(plan.root.children.map((page) => page.title)).toEqual([
      "Archive - Pages 1-20",
      "Archive - Pages 21-40",
      "Archive - Pages 41-60",
      "Archive - Pages 61-80",
      "Archive - Pages 81-100",
    ]);
  });

  it("validates modes and refuses unsafe one-page or over-cap plans", async () => {
    expect(() => parsePdfSplitPolicy("pages:4")).toThrow("pages:<5..40>");
    expect(() => parsePdfSplitPolicy("auto", "201")).toThrow("1 through 200");
    const value = await semantics("heading-poor-100.pdf");
    await expect(planPdfSplit(value.facts, value.normalized.document, value.normalized.evidence, {
      rootTitle: "Archive",
      policy: parsePdfSplitPolicy("off"),
    })).rejects.toThrow("more than 40");
    const capped = await planPdfSplit(value.facts, value.normalized.document, value.normalized.evidence, {
      rootTitle: "Archive",
      policy: parsePdfSplitPolicy("pages:20", "5"),
    });
    expect(capped.totalWikiPages).toBe(6);
    expect(capped.blockers).toEqual(["Resolved PDF tree has 6 wiki pages, above --max-wiki-pages 5."]);
  });

  it("shifts a page-range boundary rather than splitting an atomic multi-page table", async () => {
    const value = await semantics("simple-untagged.pdf");
    const facts = {
      ...value.facts,
      pageCount: 12,
      pages: Array.from({ length: 12 }, (_, index) => ({ ...value.facts.pages[0]!, index, label: String(index + 1) })),
    };
    const document: ImportDocumentV2 = {
      schema: IMPORT_DOCUMENT_SCHEMA_V2,
      sourceKind: "pdf",
      blocks: [{
        id: "pdf:table",
        type: "table",
        rows: [{ cells: [{ id: "pdf:cell", header: true, blocks: [{ id: "pdf:cell:p", type: "paragraph", runs: [{ kind: "text", text: "Atomic" }] }] }] }],
        sourceRefs: ["pdf:table-source"],
      }],
      assets: [],
      issues: [],
    };
    const evidence = [4, 6].map((pageIndex) => ({
      sourceId: "pdf:table-source",
      targetNodeId: "pdf:table",
      locator: { pageIndex },
      basis: ["text-geometry" as const],
      confidence: 1,
      decisionCode: "pdf/table-native",
      outcome: "native" as const,
      analyzerRevision: PDF_TABLE_POLICY_REVISION,
    }));
    const plan = await planPdfSplit(facts, document, evidence, {
      rootTitle: "Tables",
      policy: parsePdfSplitPolicy("pages:5"),
    });
    expect(plan.root.children.map((page) => page.sourcePageIndexes.length)).toEqual([7, 5]);
    expect(plan.issues).toEqual([{
      code: "pdf-import/split-boundary-shifted",
      message: "A page-range boundary moved to keep an atomic table, figure, list, or fallback group intact.",
      context: { occurrences: 1 },
    }]);
  });
});
