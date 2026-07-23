import { describe, expect, it } from "bun:test";
import { AdfValidationError } from "./adf-types.js";
import { storageToBlocks, StorageParseError } from "./export-blocks.js";
import type { ExportPageSource } from "./page-body.js";
import { exportSourcePolicyFromFlag } from "./page-body.js";
import { pageBodyToBlocks } from "./page-body-to-blocks.js";

async function pairedFeatureZooFixture(): Promise<{ adf: string; storage: string }> {
  const root = new URL("../test-fixtures/adf-pairs/", import.meta.url);
  const [adf, storage] = await Promise.all([
    Bun.file(new URL("basic.adf.json", root)).text(),
    Bun.file(new URL("basic.storage.xml", root)).text(),
  ]);
  return { adf, storage };
}

describe("pageBodyToBlocks", () => {
  it("dispatches the paired semantic feature zoo to structurally identical blocks", async () => {
    const fixture = await pairedFeatureZooFixture();
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
    expect(adf.blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "blockquote",
      "list",
      "list",
      "list",
      "layout",
      "table",
      "callout",
      "paragraph",
      "divider",
    ]);
    expect(JSON.stringify(adf.blocks)).toContain('"checked":true');
    expect(JSON.stringify(adf.blocks)).toContain('"checked":false');
    expect(JSON.stringify(adf.blocks)).toContain('"backgroundColor":"#AABBCC"');
    expect(JSON.stringify(adf.blocks)).toContain('"type":"status"');
    expect(adf.blocks.find((block) => block.type === "list" && block.ordered)).toMatchObject({
      type: "list",
      ordered: true,
      start: 3,
      items: [{
        content: [
          { type: "paragraph" },
          { type: "list", ordered: true, start: 8 },
        ],
      }],
    });
    expect(adf.blocks.find((block) => block.type === "list" && !block.ordered && !block.listKind)).toMatchObject({
      type: "list",
      ordered: false,
      items: [{
        content: [
          { type: "paragraph" },
          { type: "list", ordered: false },
        ],
      }],
    });
    expect(adf.blocks.find((block) => block.type === "list" && block.listKind === "task")).toMatchObject({
      type: "list",
      listKind: "task",
      items: [
        { localId: "task-done" },
        {
          localId: "task-open",
          content: [
            { type: "paragraph" },
            { type: "list", listKind: "task", localId: "tasks-nested" },
          ],
        },
      ],
    });
    expect(adf.blocks.find((block) => block.type === "layout")).toMatchObject({
      type: "layout",
      columns: [
        { width: 30, content: [{ type: "paragraph" }] },
        { width: 70, content: [{ type: "paragraph" }] },
      ],
    });
    expect(adf.notes).toEqual([]);
    expect(storage.notes).toEqual([]);
  });

  it("preserves direct Storage output and adds no fallback note without an explicit reason", async () => {
    const { storage } = await pairedFeatureZooFixture();
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
