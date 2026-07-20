/**
 * Spec 012 T6.5 — the "Manuscript" curated-template conformance fixture.
 *
 * Spec 012 shipped a SECOND built-in PDF template that renders through the
 * identical `wiki.pdf-template/v1` engine as "Editorial Indigo" — only the
 * manifest differs (serif-display/sans-body pairing, green accent, book-like
 * margins, chapter running head). The conformance case built on this fixture
 * proves that claim end to end on both hosts: the same blocks compile under
 * both manifests, the outputs differ, and each is independently deterministic.
 *
 * The blocks deliberately exercise the design surfaces where the two templates
 * actually diverge — headings at three levels (different type scale), a callout
 * (different semantic palette), and a table (different stroke/header fill) —
 * because a fixture of plain paragraphs would compile identically-ish and prove
 * nothing. No images and no macros, so the output stays byte-stable across
 * hosts and there is nothing for a rasterizer to disagree about.
 */
import type { ExportBlock } from "@atlcli/confluence/browser";
import type { PdfExportMetadata } from "@atlcli/pdf/browser";

export const MANUSCRIPT_BLOCKS: ExportBlock[] = [
  { type: "heading", level: 1, content: [{ type: "text", text: "Manuscript" }] },
  {
    type: "paragraph",
    content: [{ type: "text", text: "Body copy set in the second curated template's sans body face." }],
  },
  { type: "heading", level: 2, content: [{ type: "text", text: "Typography" }] },
  {
    type: "paragraph",
    content: [
      { type: "text", text: "The heading face is a serif display — " },
      { type: "text", text: "the inverse", marks: ["italic"] },
      { type: "text", text: " of the built-in pairing." },
    ],
  },
  {
    type: "callout",
    kind: "info",
    title: "Palette",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Callout colours come from the manifest." }] }],
  },
  { type: "heading", level: 3, content: [{ type: "text", text: "Tabular matter" }] },
  {
    type: "table",
    rows: [
      {
        cells: [
          {
            header: true,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "Surface" }] }],
          },
          {
            header: true,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "Source" }] }],
          },
        ],
      },
      {
        cells: [
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "stroke" }] }],
          },
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "tokens.colors" }] }],
          },
        ],
      },
    ],
  },
];

export const MANUSCRIPT_METADATA: PdfExportMetadata = {
  title: "Manuscript Conformance",
  space: "TEST",
  version: 1,
  author: "Harness Author",
  exporter: "atlcli browser harness",
  language: "en",
  region: "GB",
  exportedAt: new Date("2026-07-17T08:00:00.000Z"),
};

export const MANUSCRIPT_FILENAME = "Manuscript Conformance.pdf";
