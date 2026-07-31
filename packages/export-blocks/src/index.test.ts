import { describe, expect, test } from "bun:test";
import {
  EXPORT_NOTE_CODES,
  canonicalExportNoteCode,
  formatAdfDateTimestamp,
  materializeTable,
  mentionDisplayText,
  resolveCalloutIcon,
  type ExportBlock,
} from "./index.js";

describe("@atlcli/export-blocks", () => {
  test("exposes the stable note vocabulary without source-adapter dependencies", () => {
    expect(EXPORT_NOTE_CODES).toContain("unknown-macro");
    expect(canonicalExportNoteCode("pdf-image-skipped")).toBe("image-embed-failed");
    expect(canonicalExportNoteCode("not-an-export-note")).toBeUndefined();
  });

  test("keeps pure renderer-neutral display helpers deterministic", () => {
    expect(formatAdfDateTimestamp("1704067200000", "en")).toBe("Jan 1, 2024");
    expect(mentionDisplayText({ userType: "APP" })).toBe("Unknown app");
    expect(resolveCalloutIcon({ kind: "warning" })).toEqual({
      source: "semantic-default",
      icon: { kind: "warning", symbol: "⚠", label: "Warning" },
    });
  });

  test("materializes numbered table columns without parser or renderer state", () => {
    const table: Extract<ExportBlock, { type: "table" }> = {
      type: "table",
      presentation: { numberedColumn: true, width: 200 },
      rows: [{
        cells: [{
          header: false,
          colspan: 1,
          rowspan: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }],
        }],
      }],
    };
    expect(materializeTable(table).rows).toEqual([{
      cells: [
        {
          header: true,
          colspan: 1,
          rowspan: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }],
        },
        table.rows[0]!.cells[0],
      ],
    }]);
  });
});
