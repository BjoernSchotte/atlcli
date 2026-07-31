import { describe, expect, test } from "bun:test";
import type { ExportBlock, ExportPageNode } from "@atlcli/confluence";
import { createRegistry, type MacroResolutionOptions, type MacroRenderer } from "@atlcli/export-macros";
import { resolveWebPageMacrosV1, type ResolvedWebMacroPageV1 } from "./web-macro-resolution.js";

function page(
  pageId: string,
  blocks: ExportBlock[],
  version = 1,
): ExportPageNode {
  return {
    kind: "page",
    pageId,
    title: pageId,
    depth: 0,
    effectiveDepth: 0,
    parentId: null,
    position: 0,
    blocks,
    notes: [{ level: "warning", code: "unknown-macro", message: "pending", macroName: "widget" }],
    meta: { version, labels: [], spaceKey: "DOCSY" },
  };
}

function macroOptions(calls: string[]): MacroResolutionOptions {
  const renderer: MacroRenderer = {
    id: "page-identity",
    macros: ["widget"],
    requiresLivePort: true,
    async render(_macro, context) {
      const headings = context.documentBlocks
        ?.filter((block) => block.type === "heading")
        .map((block) => block.content.map((node) => node.type === "text" ? node.text : "").join(""))
        .join(",") ?? "";
      calls.push(`${context.page.id}:${headings}`);
      return {
        kind: "blocks",
        blocks: [{ type: "paragraph", content: [{ type: "text", text: `resolved:${context.page.id}` }] }],
      };
    },
  };
  return {
    registry: createRegistry([renderer]),
    contextFor(pageContext) {
      return { page: pageContext, depth: 0, visited: new Set() };
    },
  };
}

describe("resolveWebPageMacrosV1", () => {
  test("resolves each page against its own context and page-local TOC tree", async () => {
    const calls: string[] = [];
    const pages = [
      page("root", [
        { type: "unknown", macroName: "widget" },
        { type: "heading", level: 1, content: [{ type: "text", text: "Root only" }] },
      ]),
      page("child", [
        { type: "unknown", macroName: "widget", sourcePage: { id: "child", version: 1, spaceKey: "DOCSY" } },
        { type: "heading", level: 1, content: [{ type: "text", text: "Child only" }] },
      ]),
    ];
    const resolved = await resolveWebPageMacrosV1(pages, {
      macros: macroOptions(calls),
      policy: { mode: "allow-frozen-live", liveFreshnessSeconds: 60 },
      now: () => 1_000,
    });

    expect(calls).toEqual(["root:Root only", "child:Child only"]);
    expect(resolved.map((entry) => entry.blocks[0])).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "resolved:root" }] },
      { type: "paragraph", content: [{ type: "text", text: "resolved:child" }] },
    ]);
    expect(resolved.every((entry) => entry.usedLive)).toBe(true);
  });

  test("static-only permits pure output but never invokes a live renderer", async () => {
    const calls: string[] = [];
    const resolved = await resolveWebPageMacrosV1([
      page("guide", [{ type: "unknown", macroName: "widget" }]),
    ], {
      macros: macroOptions(calls),
      policy: { mode: "static-only" },
      now: () => 2_000,
    });

    expect(calls).toEqual([]);
    expect(resolved[0]?.usedLive).toBe(false);
    expect(resolved[0]?.blocks).toEqual([{ type: "unknown", macroName: "widget" }]);
  });

  test("reuses only a version-matching, explicitly fresh frozen live result", async () => {
    const calls: string[] = [];
    const previous: ResolvedWebMacroPageV1 = {
      sourceId: "guide",
      sourceVersion: 1,
      blocks: [{ type: "paragraph", content: [{ type: "text", text: "frozen" }] }],
      notes: [],
      resolvedAtEpochMs: 1_000,
      usedLive: true,
    };
    const fresh = await resolveWebPageMacrosV1([
      page("guide", [{ type: "unknown", macroName: "widget" }]),
    ], {
      macros: macroOptions(calls),
      policy: { mode: "allow-frozen-live", liveFreshnessSeconds: 60 },
      previousBySourceId: new Map([["guide", previous]]),
      now: () => 61_000,
    });
    expect(fresh).toEqual([previous]);
    expect(calls).toEqual([]);

    await resolveWebPageMacrosV1([
      page("guide", [{ type: "unknown", macroName: "widget" }], 2),
    ], {
      macros: macroOptions(calls),
      policy: { mode: "allow-frozen-live", liveFreshnessSeconds: 60 },
      previousBySourceId: new Map([["guide", previous]]),
      now: () => 61_001,
    });
    expect(calls).toEqual(["guide:"]);
  });

  test("rejects ambiguous duplicate pages and invalid freshness combinations", async () => {
    const options = { macros: macroOptions([]), policy: { mode: "static-only", liveFreshnessSeconds: 1 } as const };
    await expect(resolveWebPageMacrosV1([], options)).rejects.toThrow("static-only");
    await expect(resolveWebPageMacrosV1([
      page("duplicate", []), page("duplicate", []),
    ], { macros: macroOptions([]), policy: { mode: "static-only" } })).rejects.toThrow("duplicate page");
  });
});
