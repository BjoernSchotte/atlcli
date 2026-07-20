/**
 * Cross-engine table-width divergence (spec 006 G3).
 *
 * The DOCX and PDF engines agree on EXPLICIT, non-near-equal source column
 * widths, but deliberately diverge for near-equal/absent widths: PDF applies a
 * content-length heuristic (`inferredTableTracks`) that can widen a dominant
 * narrative column, while DOCX always even-splits below the 1.05 spread
 * threshold (predictability over content-sniffing). This test locks that
 * decision in as tested behavior rather than an unverified claim.
 */
import { describe, expect, it } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence";
import { serializeBlocks, columnWidthsDxa } from "@atlcli/docx/internal";
import { preparePdfDocument } from "./prepare.js";
import { serializePdfDocument } from "./serialize.js";

const metadata = {
  title: "Cross-engine",
  language: "en",
  region: "US",
  exportedAt: new Date("2026-07-14T09:00:00.000Z"),
};

const cell = (text: string): { header: false; colspan: 1; rowspan: 1; content: ExportBlock[] } => ({
  header: false,
  colspan: 1,
  rowspan: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

// Near-equal source widths (spread 1.0 → below the 1.05 threshold in both
// engines), 3 columns, with one column carrying dominant narrative text.
const NEAR_EQUAL_WIDTHS = [226, 226, 226];
const narrativeTable: ExportBlock = {
  type: "table",
  columnWidths: NEAR_EQUAL_WIDTHS,
  rows: [
    {
      cells: [
        cell("a"),
        cell("b"),
        cell("This is a long narrative description that dominates the column here"),
      ],
    },
    {
      cells: [
        cell("c"),
        cell("d"),
        cell("Another substantially long narrative sentence continuing the dominance"),
      ],
    },
  ],
};

describe("cross-engine table-width divergence (spec 006 G3)", () => {
  it("DOCX even-splits near-equal widths (no fixed layout, no per-cell tcW)", async () => {
    // The pure width mapper returns undefined (even split) below the threshold.
    expect(columnWidthsDxa(NEAR_EQUAL_WIDTHS, 3)).toBeUndefined();
    const { xml } = await serializeBlocks([narrativeTable], { styleNames: new Map() });
    expect(xml).not.toContain("<w:tcW");
    expect(xml).not.toContain('w:type="fixed"');
  });

  it("PDF may widen the dominant column via its content-length inference", async () => {
    const prepared = await preparePdfDocument([narrativeTable], {
      resolve: async () => {
        throw new Error("unused");
      },
    });
    const bundle = serializePdfDocument(prepared, { metadata });
    // PDF's inferredTableTracks widens the narrative column → NOT an even split.
    expect(bundle.main).not.toContain("columns: (1fr, 1fr, 1fr,)");
    expect(bundle.main).toMatch(/columns: \([^)]*0\.5fr[^)]*\)/);
  });
});
