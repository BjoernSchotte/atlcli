import { describe, expect, it } from "bun:test";
import { AdfValidationError } from "./adf-types.js";
import { storageToBlocks, StorageParseError } from "./export-blocks.js";
import type { ExportPageSource } from "./page-body.js";
import { exportSourcePolicyFromFlag } from "./page-body.js";
import { pageBodyToBlocks } from "./page-body-to-blocks.js";

async function pairedFixture(): Promise<{ adf: string; storage: string }> {
  const root = new URL("../test-fixtures/adf-pairs/", import.meta.url);
  const [adf, storage] = await Promise.all([
    Bun.file(new URL("basic.adf.json", root)).text(),
    Bun.file(new URL("basic.storage.xml", root)).text(),
  ]);
  return { adf, storage };
}

describe("pageBodyToBlocks", () => {
  it("dispatches paired ADF and Storage fixtures to structurally identical blocks", async () => {
    const fixture = await pairedFixture();
    const pageContext = { id: "page-7", title: "Synthetic pair", url: "https://example.invalid/page" };
    const adf = pageBodyToBlocks({
      primary: { representation: "atlas_doc_format", value: fixture.adf },
      storageSidecar: fixture.storage,
      sourceVersion: 7,
    }, { pageContext });
    const storage = pageBodyToBlocks({
      primary: { representation: "storage", value: fixture.storage },
      sourceVersion: 7,
    }, { pageContext });

    expect(adf.representation).toBe("atlas_doc_format");
    expect(storage.representation).toBe("storage");
    expect(adf.blocks).toEqual(storage.blocks);

    const intentionalDifferences = [{
      gap: "orderedList.order",
      gapAnalysisRow: "Complete ADF node matrix / Lists, tasks, and decisions / orderedList",
      adfCode: "adf-node-degraded" as const,
      reason: "Both adapters render from 1; only direct ADF observes and reports the authored non-1 start.",
    }];
    expect(adf.notes.map((note) => note.code)).toEqual(intentionalDifferences.map((entry) => entry.adfCode));
    expect(adf.notes[0]?.source).toMatchObject({
      pageId: "page-7",
      pageTitle: "Synthetic pair",
      pageUrl: "https://example.invalid/page",
      blockPath: "blocks[4]",
    });
    expect(storage.notes).toEqual([]);
  });

  it("preserves direct Storage output and adds no fallback note without an explicit reason", async () => {
    const { storage } = await pairedFixture();
    const direct = storageToBlocks(storage, { exporter: "word" });
    const dispatched = pageBodyToBlocks({ primary: { representation: "storage", value: storage } }, { exporter: "word" });
    expect(dispatched).toEqual({ ...direct, representation: "storage" });
  });

  it("adds a source-fallback note only for explicitly selected deployment/capability fallbacks", () => {
    const storage = "<p>visible</p>";
    const dataCenter = pageBodyToBlocks({
      primary: { representation: "storage", value: storage },
      fallbackReason: "data-center",
    }, { pageContext: { id: "page-1", title: "Synthetic" } });
    const unavailable = pageBodyToBlocks({
      primary: { representation: "storage", value: storage },
      fallbackReason: "adf-representation-unavailable",
    });
    const ordinary = pageBodyToBlocks({ primary: { representation: "storage", value: storage } });
    const rollout = pageBodyToBlocks({
      primary: { representation: "storage", value: storage },
      fallbackReason: "rollout-storage-primary",
    });

    expect(dataCenter.notes).toMatchObject([{
      level: "info",
      code: "adf-storage-fallback",
      source: { pageId: "page-1", pageTitle: "Synthetic", blockPath: "blocks" },
    }]);
    expect(unavailable.notes.map((note) => note.code)).toEqual(["adf-storage-fallback"]);
    expect(rollout.notes).toMatchObject([{
      code: "adf-storage-fallback",
      message: "Storage was selected by the export-source rollout policy.",
    }]);
    expect(ordinary.notes).toEqual([]);
  });

  it("parses the single host-owned source flag fail-closed", () => {
    expect(exportSourcePolicyFromFlag(undefined)).toBe("adf-primary");
    expect(exportSourcePolicyFromFlag("")).toBe("adf-primary");
    expect(exportSourcePolicyFromFlag("adf")).toBe("adf-primary");
    expect(exportSourcePolicyFromFlag("storage")).toBe("storage-primary");
    expect(() => exportSourcePolicyFromFlag("auto")).toThrow(/ATLCLI_EXPORT_SOURCE/);
  });

  it("never retries malformed or over-budget ADF through a valid Storage sidecar", () => {
    const invalid: ExportPageSource = {
      primary: { representation: "atlas_doc_format", value: "not-json" },
      storageSidecar: "<p>This must not be decoded.</p>",
    };
    expect(() => pageBodyToBlocks(invalid)).toThrow(AdfValidationError);

    const overBudget: ExportPageSource = {
      primary: { representation: "atlas_doc_format", value: JSON.stringify({
        version: 1,
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }],
      }) },
      storageSidecar: "<p>This must not be decoded.</p>",
    };
    expect(() => pageBodyToBlocks(overBudget, { adfParseBudget: { maxNodes: 1 } })).toThrow(AdfValidationError);
  });

  it("rejects an impossible ADF-primary source carrying a Storage fallback reason", () => {
    const source: ExportPageSource = {
      primary: { representation: "atlas_doc_format", value: JSON.stringify({ version: 1, type: "doc", content: [] }) },
      fallbackReason: "data-center",
    };
    expect(() => pageBodyToBlocks(source)).toThrow("cannot carry a Storage fallback reason");
  });

  it("routes ADF and Storage budgets independently", () => {
    const adf = JSON.stringify({ version: 1, type: "doc", content: [{ type: "paragraph", content: [] }] });
    expect(() => pageBodyToBlocks(
      { primary: { representation: "atlas_doc_format", value: adf } },
      { adfParseBudget: { maxNodes: 1 }, storageParseBudget: { maxNodes: 100, maxDepth: 10, maxTextLength: 100 } },
    )).toThrow(AdfValidationError);
    expect(() => pageBodyToBlocks(
      { primary: { representation: "storage", value: "<p>text</p>" } },
      { adfParseBudget: { maxNodes: 100 }, storageParseBudget: { maxNodes: 1, maxDepth: 10, maxTextLength: 100 } },
    )).toThrow(StorageParseError);
  });

  it("forwards common walker options and the explicit media-correlation seam", () => {
    const source: ExportPageSource = {
      primary: { representation: "atlas_doc_format", value: JSON.stringify({
        version: 1,
        type: "doc",
        content: [{ type: "media", attrs: { type: "file", id: "media-1", alt: "Synthetic" } }],
      }) },
    };
    const seen: unknown[] = [];
    const result = pageBodyToBlocks(source, {
      exporter: "pdf",
      pageContext: { id: "page-2" },
      resolveMediaAttachment(reference) {
        seen.push(reference);
        return { filename: "synthetic.png" };
      },
    });
    expect(seen).toEqual([{ id: "media-1" }]);
    expect(result.blocks).toEqual([{
      type: "image",
      source: { kind: "attachment", filename: "synthetic.png", pageId: "page-2" },
      alt: "Synthetic",
    }]);
  });
});
