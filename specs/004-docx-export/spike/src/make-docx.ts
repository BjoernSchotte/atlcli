/** Tiny helper: build a simple .docx buffer from plain-text paragraphs.
 * Used to author the per-engine NATIVE templates (each paragraph's text is a
 * literal engine command like `+++IMAGE x()+++` or `{@rawXml}`). */
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";

export async function makeDocx(paragraphs: { text: string; heading?: number }[]): Promise<Buffer> {
  const doc = new Document({
    styles: {
      paragraphStyles: [1, 2, 3, 4].map((n) => ({
        id: `Heading${n}`,
        name: `Heading ${n}`,
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { bold: true, size: 32 - n * 3 },
        paragraph: { outlineLevel: n - 1, spacing: { before: 160, after: 80 } },
      })),
    },
    sections: [
      {
        children: paragraphs.map(
          (p) =>
            new Paragraph({
              heading: p.heading
                ? ([HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][
                    p.heading - 1
                  ])
                : undefined,
              children: [new TextRun(p.text)],
            }),
        ),
      },
    ],
  });
  return Packer.toBuffer(doc);
}
