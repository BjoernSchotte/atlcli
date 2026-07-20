import { describe, expect, it } from "bun:test";
import { validatePdfOutput } from "./validate.js";

function fixture(body: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n${body}\n%%EOF\n`);
}

/** A minimal well-formed object graph: one page, tagged, one embedded font. */
function document(catalogExtras: string): Uint8Array {
  return fixture(
    `1 0 obj\n<< /Type /Page >>\nendobj\n` +
      `2 0 obj\n<< /Type /Catalog /Pages 1 0 R ${catalogExtras} /StructTreeRoot 3 0 R >>\nendobj\n` +
      `3 0 obj\n<< /MarkInfo << /Marked true >> /FontFile2 4 0 R >>\nendobj\n`
  );
}

describe("validatePdfOutput", () => {
  it("reports structural PDF properties", () => {
    expect(validatePdfOutput(fixture("/Type/Page /Type/Catalog /Lang (en) /StructTreeRoot /MarkInfo /Outlines /FontFile2")))
      .toEqual({ pageCount: 1, tagged: true, hasOutline: true, embeddedFontFiles: 1, hasLang: true });
  });

  it.each([
    ["truncated", new Uint8Array([37, 80, 68, 70])],
    ["no pages", fixture("/StructTreeRoot /MarkInfo /FontFile2")],
    ["untagged", fixture("/Type/Page /FontFile2")],
    ["fontless", fixture("/Type/Page /StructTreeRoot /MarkInfo")],
  ])("rejects %s output", (_label, bytes) => {
    expect(() => validatePdfOutput(bytes)).toThrow();
  });

  describe("hasLang (spec 011, PDF/UA 7.2)", () => {
    it("is true for a catalog that declares a literal-string /Lang", () => {
      expect(validatePdfOutput(document("/Lang (en-GB)")).hasLang).toBe(true);
    });

    it("is true for a hex-string /Lang", () => {
      expect(validatePdfOutput(document("/Lang <64652D4445>")).hasLang).toBe(true);
    });

    it("is true regardless of where /Lang sits inside the catalog dictionary", () => {
      // Key order inside a PDF dictionary carries no meaning, so a producer
      // writing /Lang BEFORE /Type must still be recognized.
      const bytes = fixture(
        `1 0 obj\n<< /Type /Page >>\nendobj\n` +
          `2 0 obj\n<< /Lang (fr) /Type /Catalog /StructTreeRoot 3 0 R >>\nendobj\n` +
          `3 0 obj\n<< /MarkInfo << /Marked true >> /FontFile2 4 0 R >>\nendobj\n`
      );
      expect(validatePdfOutput(bytes).hasLang).toBe(true);
    });

    it("is false when the catalog declares no language", () => {
      expect(validatePdfOutput(document("")).hasLang).toBe(false);
    });

    it("does not mistake a /Lang on a non-catalog object for the document language", () => {
      // A /Lang on a structure element scopes one subtree; PDF/UA 7.2 requires
      // the DOCUMENT-level declaration in the catalog. Accepting the former
      // would report a conformance property the file does not actually have.
      const bytes = fixture(
        `1 0 obj\n<< /Type /Page >>\nendobj\n` +
          `2 0 obj\n<< /Type /Catalog /StructTreeRoot 3 0 R >>\nendobj\n` +
          `3 0 obj\n<< /Type /StructElem /Lang (de) /MarkInfo << /Marked true >> /FontFile2 4 0 R >>\nendobj\n`
      );
      expect(validatePdfOutput(bytes).hasLang).toBe(false);
    });

    it("does not mistake an XMP dc:language packet for the catalog /Lang", () => {
      const bytes = fixture(
        `1 0 obj\n<< /Type /Page >>\nendobj\n` +
          `2 0 obj\n<< /Type /Catalog /StructTreeRoot 3 0 R >>\nendobj\n` +
          `3 0 obj\n<< /MarkInfo << /Marked true >> /FontFile2 4 0 R >>\nstream\n` +
          `<dc:language><rdf:Bag><rdf:li>en-GB</rdf:li></rdf:Bag></dc:language>\nendstream\nendobj\n`
      );
      expect(validatePdfOutput(bytes).hasLang).toBe(false);
    });
  });
});
