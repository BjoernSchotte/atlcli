import { describe, expect, test } from "bun:test";
import {
  hasMacroAdfExport,
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
    });
  }
});
