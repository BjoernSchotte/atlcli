import { describe, expect, it } from "bun:test";
import type { ExportNote } from "@atlcli/confluence/browser";
import {
  classifyExportNote,
  groupExportNotes,
} from "../components/export/ExportNoteGroups.js";

describe("export report note grouping", () => {
  it("routes the full-space protocol's notable codes to user-facing categories", () => {
    expect(classifyExportNote("image-embed-failed")).toBe("content");
    expect(classifyExportNote("pdf-link-unresolved")).toBe("links");
    expect(classifyExportNote("image-missing-alt")).toBe("accessibility");
    expect(classifyExportNote("macro-degraded")).toBe("dynamic");
    expect(classifyExportNote("space-fetch-failed")).toBe("dynamic");
    expect(classifyExportNote("pdf-diagram-failed")).toBe("layout");
    expect(classifyExportNote("folder-position-unknown")).toBe("information");
  });

  it("aggregates repeated stable codes while preserving every original message", () => {
    const notes: ExportNote[] = [
      { level: "info", code: "pdf-link-unresolved", message: "first link" },
      { level: "info", code: "pdf-link-unresolved", message: "second link" },
      { level: "warning", code: "image-embed-failed", message: "missing image" },
    ];

    const groups = groupExportNotes(notes);
    expect(groups.map((group) => group.category)).toEqual(["content", "links"]);
    expect(groups[0]?.warningCount).toBe(1);
    expect(groups[1]?.codes[0]?.code).toBe("pdf-link-unresolved");
    expect(groups[1]?.codes[0]?.notes.map((note) => note.message)).toEqual([
      "first link",
      "second link",
    ]);
  });

  it("keeps future unknown codes visible instead of dropping them", () => {
    expect(classifyExportNote("future-export-note")).toBe("information");
  });
});
