import { describe, expect, test } from "bun:test";
import {
  adfToBlocks,
  extractMacroBody,
  htmlToExportBlocks,
  parsePageProperties,
  storageToBlocks,
} from "@atlcli/confluence/browser";
import {
  defaultRegistry,
  resolveMacroBlocks,
} from "@atlcli/export-macros";
import {
  hasMacroAdfExport,
  hasWhiteboardLinkedCard,
  MACRO_ADF_EXTENSION,
  MACRO_ADF_BLOCK_EXPORT_TEXT,
  MACRO_ADF_BODIED_EXPORT_TEXT,
  MACRO_ADF_INLINE_EXPORT_TEXT,
  resolveMacroFixtureBlocks,
} from "./macro-fixtures.js";

describe("macro conformance fixture", () => {
  for (const target of ["docx", "pdf"] as const) {
    test(`${target} resolves a Forge ADF extension through its local ID`, async () => {
      const result = await resolveMacroFixtureBlocks(target);
      const serialized = JSON.stringify(result.blocks);

      expect(hasMacroAdfExport(result.blocks)).toBe(true);
      expect(serialized).toContain(MACRO_ADF_BLOCK_EXPORT_TEXT);
      expect(serialized).toContain(MACRO_ADF_BODIED_EXPORT_TEXT);
      expect(serialized).toContain(MACRO_ADF_INLINE_EXPORT_TEXT);
      expect(serialized).not.toContain("Forge body fallback");
      expect(serialized).not.toContain("Forge inline fallback");
      expect(result.notes.some((note) =>
        note.code === "macro-rendered-via" &&
        note.macroName === "forge-block-export-widget"
      )).toBe(true);
      expect(result.notes.some((note) =>
        note.code === "macro-rendered-via" &&
        note.macroName === "forge-bodied-export-widget"
      )).toBe(true);
      expect(result.notes.some((note) =>
        note.code === "macro-rendered-via" &&
        note.macroName === "forge-inline-export-widget"
      )).toBe(true);
      expect(result.notes.some((note) =>
        note.code === "macro-not-rendered" &&
        (
          note.macroName === "forge-block-export-widget" ||
          note.macroName === "forge-bodied-export-widget"
        )
      )).toBe(false);
      expect(result.notes.some((note) =>
        note.code === "inline-extension-not-rendered" &&
        note.macroName === "forge-inline-export-widget"
      )).toBe(false);
      expect(hasWhiteboardLinkedCard(result.blocks)).toBe(true);
      expect(result.notes.filter((note) =>
        note.code === "macro-rendered-via" &&
        note.macroName === "native-embed:whiteboard"
      )).toHaveLength(1);
      expect(result.notes.some((note) =>
        note.code === "macro-not-rendered" &&
        note.macroName === "native-embed:whiteboard"
      )).toBe(false);
    });
  }
});

test("a Forge-shaped consumer injects requestConfluence only for page acquisition", async () => {
  const paths: string[] = [];
  const requestConfluence = async (path: string): Promise<{
    body: { atlas_doc_format: { value: unknown } };
  }> => {
    paths.push(path);
    return {
      body: {
        atlas_doc_format: {
          value: {
            type: "doc",
            version: 1,
            content: [MACRO_ADF_EXTENSION.content[3]],
          },
        },
      },
    };
  };

  const pageId = "fixture-page";
  const response = await requestConfluence(
    `/wiki/api/v2/pages/${pageId}?body-format=atlas_doc_format`,
  );
  const decoded = adfToBlocks(
    response.body.atlas_doc_format.value as Parameters<typeof adfToBlocks>[0],
    { pageContext: { id: pageId, version: 1, spaceKey: "TEST" } },
  );
  const registry = defaultRegistry({
    storageToBlocks,
    htmlToExportBlocks,
    parsePageProperties,
    extractMacroBody,
  });
  const result = await resolveMacroBlocks(decoded, registry, {
    page: { id: pageId, version: 1, spaceKey: "TEST" },
    depth: 0,
    visited: new Set(),
    siteOrigin: "https://tenant.invalid",
  }, {
    live: false,
    targetEngine: "pdf",
  });

  expect(paths).toEqual([
    `/wiki/api/v2/pages/${pageId}?body-format=atlas_doc_format`,
  ]);
  expect(paths.some((path) => /whiteboard/iu.test(path))).toBe(false);
  expect(hasWhiteboardLinkedCard(result.blocks)).toBe(true);
  expect(result.notes.map((note) => note.code)).toEqual([
    "macro-rendered-via",
  ]);
});
