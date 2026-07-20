/**
 * Spec 006 — Word-quality conformance fixtures (case 006 `docx-quality`).
 * DOCX-only. Exercises the four spec-006 quality outputs in one export:
 *   - native list numbering → `word/numbering.xml` (a NESTED ordered list forces
 *     multiple numIds with restart overrides),
 *   - table column widths → `w:tblGrid` (`columnWidths: [300, 100]`, spread 3.0
 *     > 1.05 so real per-column `w:gridCol` widths are emitted),
 *   - SVG embedding → `asvg:svgBlip` + PNG fallback media parts (an SVG page
 *     attachment fed through the injected rasterizer),
 *   - STYLEREF header field survival (a running-header STYLEREF whose referenced
 *     style the level-1 heading actually emits, so no unused-style warning).
 *
 * The rasterizer + asset fetcher are host-provided (canvas lives in the browser
 * harness), so this fixture ships the blocks, the SVG bytes, and the template.
 */
import type { ConfluencePageDetails, ExportBlock } from "@atlcli/confluence/browser";
import { buildDocx, fldSimpleResult, headingStyle, para, stylesXml } from "@atlcli/docx/fixtures";

function text(value: string): { type: "text"; text: string }[] {
  return [{ type: "text", text: value }];
}

/**
 * Blocks exercising numbering.xml (nested ordered list), tblGrid (unequal
 * column widths), and svgBlip (an SVG attachment image).
 */
export const DOCX_QUALITY_BLOCKS: ExportBlock[] = [
  { type: "heading", level: 1, content: text("Quality coverage") },
  {
    type: "list",
    ordered: true,
    items: [
      { content: [{ type: "paragraph", content: text("First step") }] },
      {
        content: [
          { type: "paragraph", content: text("Second step") },
          {
            type: "list",
            ordered: true,
            items: [
              { content: [{ type: "paragraph", content: text("Nested one") }] },
              { content: [{ type: "paragraph", content: text("Nested two") }] },
            ],
          },
        ],
      },
    ],
  },
  {
    type: "table",
    columnWidths: [300, 100],
    rows: [
      {
        cells: [
          { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: text("Wide") }] },
          { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: text("Narrow") }] },
        ],
      },
      {
        cells: [
          { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: text("left") }] },
          { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: text("right") }] },
        ],
      },
    ],
  },
  {
    type: "image",
    source: { kind: "attachment", filename: "diagram.svg" },
    alt: "Architecture diagram",
    width: 120,
    height: 80,
  },
];

/** A safe, well-sized SVG attachment — passes `assertSafeSvg`, has explicit dimensions. */
export const DOCX_QUALITY_SVG_BYTES: Uint8Array = new TextEncoder().encode(
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80">` +
    `<rect x="0" y="0" width="120" height="80" fill="#4C9AFF"/>` +
    `<circle cx="60" cy="40" r="20" fill="#FFFFFF"/>` +
    `</svg>`,
);

/** The attachment filename the SVG image block references. */
export const DOCX_QUALITY_SVG_FILENAME = "diagram.svg";

/** Minimal root `details` for the blocks-driven DOCX path. */
export const DOCX_QUALITY_DETAILS: ConfluencePageDetails = {
  id: "docx-quality-page",
  title: "Word Quality Coverage",
  url: "https://example.invalid/wiki/spaces/TEST/pages/docx-quality-page",
  version: 1,
  spaceKey: "TEST",
  storage: "",
  created: "2026-07-17T08:00:00.000Z",
  modified: "2026-07-17T08:00:00.000Z",
  createdBy: { displayName: "Harness Author" },
  modifiedBy: { displayName: "Harness Author" },
  labels: [],
};

/**
 * A template whose running header carries a STYLEREF field referencing the
 * "Heading 1" style — which the level-1 heading block emits (its name maps to
 * the emitted `Heading1` style id), so the field resolves with NO
 * `styleref-style-unused-in-export` warning and survives verbatim into
 * `word/header1.xml`. `date` pins DOS timestamps for byte reproducibility.
 */
export const DOCX_QUALITY_TEMPLATE_BYTES: Uint8Array = buildDocx({
  body: para("$scroll.content"),
  styles: stylesXml(headingStyle("Heading1", "Heading 1")),
  header: fldSimpleResult("STYLEREF &quot;Heading 1&quot; \\* MERGEFORMAT ", "STALE"),
  date: new Date("2026-07-17T08:00:00.000Z"),
});
