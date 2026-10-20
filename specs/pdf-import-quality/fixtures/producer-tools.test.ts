import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { unzipSync, strFromU8 } from "fflate";
import { PdfObjectReader, pdfText } from "../../../packages/import-pdf/src/pdf-objects.js";
import { createNodePdfiumFactsAdapterV2 } from "../../../packages/import-pdf/src/node.js";
import { producerDocx, sanitizePdf } from "./producer-tools.js";

const here = import.meta.dir;
const strip = ({ inputSha256: _sha, inputBytes: _bytes, ...facts }: Record<string, unknown>) => facts;

describe("producer fixture tools", () => {
  for (const name of [
    "producer-browser.pdf",
    "producer-libreoffice.pdf",
    "producer-word.pdf",
    "struct-tree/browser-multipage-table.pdf",
  ]) {
    it(`sanitizes without changing PDFium facts: ${name}`, async () => {
      const original = new Uint8Array(await readFile(resolve(here, name)));
      const sanitized = sanitizePdf(original, "Neutral test producer 1.0");
      const adapter = await createNodePdfiumFactsAdapterV2();
      const before = await adapter.analyze(original);
      const after = await adapter.analyze(sanitized);
      expect(strip(after.facts as never)).toEqual(strip(before.facts as never));

      const reader = new PdfObjectReader(sanitized);
      expect(reader.recoveredByScan).toBe(false);
      const info = reader.dict(reader.trailer.entries.get("Info"))!;
      expect(pdfText(reader.resolve(info.entries.get("Producer")))).toBe("Neutral test producer 1.0");
      expect([...info.entries.keys()].sort()).toEqual(["Author", "Creator", "Producer", "Subject", "Title"]);
      expect(reader.dict(reader.trailer.entries.get("Root"))!.entries.has("Metadata")).toBe(false);
      // Idempotent: sanitizing again yields the same bytes.
      expect(sanitizePdf(sanitized, "Neutral test producer 1.0")).toEqual(sanitized);
    });
  }

  it("builds the neutral producer DOCX deterministically from producer-source.json", async () => {
    const source = JSON.parse(await readFile(resolve(here, "producer-source.json"), "utf8"));
    const docx = producerDocx(source);
    expect(producerDocx(source)).toEqual(docx);
    const document = strFromU8(unzipSync(docx)["word/document.xml"]!);
    expect(document).toContain('<w:pStyle w:val="Heading1"/>');
    expect(document.match(/<w:numId w:val="1"\/>/g)).toHaveLength(source.listItems.length);
    expect(document.match(/<w:tr>/g)).toHaveLength(source.table.length);
    expect(document).toContain('<w:lang w:eastAsia="ja-JP"/>');
    expect(document).toContain('<w:jc w:val="right"/>');
  });
});
