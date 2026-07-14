/**
 * Builds `fixtures/fixture-template.docx` — a realistic mayflower-style Word
 * template with Scroll Word Exporter placeholders left as LITERAL text, so we
 * can test whether each engine leaves `$scroll.*` untouched / can replace them.
 *
 * Produced with the `docx` library (MIT). This template mimics what a Scroll
 * customer hands us: a cover page, a header with `$scroll.title` +
 * `$scroll.exportdate`, a footer with `$scroll.exporter.fullName` + a native
 * Word page-number field, a native Word Table-of-Contents field, and a body
 * that positions `$scroll.content` after some placeholder metadata lines.
 *
 * Run: bun run src/build-template.ts
 */
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  StyleLevel,
  TableOfContents,
  TextRun,
} from "docx";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const outPath = join(import.meta.dir, "..", "fixtures", "fixture-template.docx");

const doc = new Document({
  creator: "atlcli spike",
  title: "Fixture Template",
  // Custom heading styles so we can prove style-driven TOC population.
  styles: {
    paragraphStyles: [
      {
        id: "Heading1",
        name: "Heading 1",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 32, bold: true, color: "1F4E79" },
        paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0 },
      },
      {
        id: "Heading2",
        name: "Heading 2",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 26, bold: true, color: "2E74B5" },
        paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 1 },
      },
      {
        id: "Heading3",
        name: "Heading 3",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: 22, bold: true, color: "5B9BD5" },
        paragraph: { spacing: { before: 160, after: 80 }, outlineLevel: 2 },
      },
    ],
  },
  sections: [
    {
      properties: {},
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [
                // Literal Scroll placeholders inside the HEADER part.
                new TextRun({ text: "$scroll.title", italics: true }),
                new TextRun({ text: "   ·   " }),
                new TextRun({ text: "$scroll.exportdate", italics: true }),
              ],
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                // Literal Scroll placeholder + native Word page-number field in FOOTER.
                new TextRun({ text: "Exported by $scroll.exporter.fullName — Page " }),
                new TextRun({ children: [PageNumber.CURRENT] }),
                new TextRun({ text: " of " }),
                new TextRun({ children: [PageNumber.TOTAL_PAGES] }),
              ],
            }),
          ],
        }),
      },
      children: [
        // ---- Cover page ----
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 2400 },
          children: [new TextRun({ text: "$scroll.space.name", bold: true, size: 56 })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 240 },
          children: [new TextRun({ text: "$scroll.title", size: 40, color: "1F4E79" })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 240 },
          children: [new TextRun({ text: "Labels: $scroll.pagelabels", italics: true, size: 20 })],
        }),
        new Paragraph({ children: [new PageBreak()] }),

        // ---- TOC page: native Word TOC field driven by Heading 1-3 styles ----
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun("Table of Contents")],
        }),
        new TableOfContents("Table of Contents", {
          hyperlink: true,
          headingStyleRange: "1-3",
          stylesWithLevels: [new StyleLevel("Heading1", 1), new StyleLevel("Heading2", 2), new StyleLevel("Heading3", 3)],
        }),
        new Paragraph({ children: [new PageBreak()] }),

        // ---- Content insertion point ----
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun("$scroll.title")],
        }),
        new Paragraph({
          children: [new TextRun("Space: $scroll.space.name — Labels: $scroll.pagelabels")],
        }),
        // The single content-insertion placeholder. Engines replace this with
        // the converted page body (raw OOXML).
        new Paragraph({ children: [new TextRun("$scroll.content")] }),
      ],
    },
  ],
});

const buf = await Packer.toBuffer(doc);
writeFileSync(outPath, buf);
console.log(`wrote ${outPath} (${buf.length} bytes)`);
