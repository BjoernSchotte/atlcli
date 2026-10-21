import { describe, expect, test } from "bun:test";
import {
  EXPORT_NOTE_CODES,
  canonicalExportNoteCode,
  formatAdfDateTimestamp,
  materializeTable,
  mentionDisplayText,
  resolveCalloutIcon,
  smartCardDisplayText,
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

  test("smart links to a Jira issue show the issue key instead of the URL", () => {
    const url = "https://x.atlassian.net/browse/ATLCLI-53";
    expect(smartCardDisplayText({ appearance: "inline", source: "url", url, title: url })).toBe("ATLCLI-53");
    expect(smartCardDisplayText({ appearance: "inline", source: "url", url })).toBe("ATLCLI-53");
    expect(smartCardDisplayText({ appearance: "inline", source: "url", url: "https://jira.example.com/jira/browse/AB_2-7?focusedId=1" })).toBe("AB_2-7");
    // A real title wins; other URLs are untouched.
    expect(smartCardDisplayText({ appearance: "inline", source: "url", url, title: "Fix login" })).toBe("Fix login");
    expect(smartCardDisplayText({ appearance: "inline", source: "url", url: "https://x.atlassian.net/wiki/x" })).toBe("https://x.atlassian.net/wiki/x");
    expect(smartCardDisplayText({ appearance: "inline", source: "url", url: "https://x.atlassian.net/browse/lower-1" })).toBe("https://x.atlassian.net/browse/lower-1");
  });
});
