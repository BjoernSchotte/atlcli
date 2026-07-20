import { describe, expect, it } from "bun:test";
import { PDF_SCAN_CHUNK_BYTES, validatePdfOutput } from "./validate.js";

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

  /**
   * Chunked scanning (spec 010, T5.6) replaced a whole-file
   * `TextDecoder("latin1").decode(bytes)` — measured at 2x the file size in live
   * string (128 MiB for the 64 MiB `PDF_JOB_MAX_BYTES` ceiling).
   *
   * The contract of that change is *identical verdicts*, so these tests compare
   * against a verbatim copy of the implementation it replaced rather than
   * against hand-written expectations. Naive chunking's characteristic failure —
   * a marker straddling a chunk boundary being missed, double-counted, or
   * gaining a false word boundary — is exercised offset by offset.
   */
  describe("chunked scanning (spec 010, T5.6)", () => {
    /** The pre-T5.6 implementation, verbatim, as the equivalence oracle. */
    function referenceValidate(bytes: Uint8Array): unknown {
      if (bytes.byteLength < 32) return "truncated";
      const text = new TextDecoder("latin1").decode(bytes);
      if (!text.startsWith("%PDF-")) return "invalid";
      if (!/%%EOF\s*$/.test(text)) return "incomplete";
      const pageCount = text.match(/\/Type\s*\/Page\b/g)?.length ?? 0;
      if (pageCount === 0) return "no pages";
      const tagged = /\/StructTreeRoot\b/.test(text) && /\/MarkInfo\b/.test(text);
      if (!tagged) return "untagged";
      const embeddedFontFiles = text.match(/\/FontFile(?:2|3)?\b/g)?.length ?? 0;
      if (embeddedFontFiles === 0) return "fontless";

      let hasLang = false;
      for (const match of text.matchAll(/\/Type\s*\/Catalog\b/g)) {
        const objStart = text.lastIndexOf(" obj", match.index);
        const objEnd = text.indexOf("endobj", match.index);
        const body = text.slice(
          objStart < 0 ? match.index : objStart,
          objEnd < 0 ? text.length : objEnd
        );
        if (/\/Lang\s*[(<]/.test(body)) {
          hasLang = true;
          break;
        }
      }
      return { pageCount, tagged, hasOutline: /\/Outlines\b/.test(text), embeddedFontFiles, hasLang };
    }

    /** Whatever the implementation decides, shaped for comparison with the oracle. */
    function actual(bytes: Uint8Array): unknown {
      try {
        return validatePdfOutput(bytes);
      } catch (error) {
        const message = (error as Error).message;
        if (message.includes("truncated")) return "truncated";
        if (message.includes("invalid file bytes")) return "invalid";
        if (message.includes("incomplete")) return "incomplete";
        if (message.includes("no pages")) return "no pages";
        if (message.includes("tag structure")) return "untagged";
        if (message.includes("no embedded font files")) return "fontless";
        throw error;
      }
    }

    function agrees(bytes: Uint8Array): void {
      expect(actual(bytes)).toEqual(referenceValidate(bytes));
    }

    /**
     * A multi-chunk document with `body` planted so that its first byte sits at
     * `at`. Filler is `.` — neither a word character (so a planted marker's `\b`
     * behaves as it would in a real file) nor whitespace (so `\s*` cannot bridge
     * two unrelated planted markers and fabricate a match).
     */
    function plantedAt(at: number, body: string, totalBytes: number): Uint8Array {
      const bytes = new Uint8Array(totalBytes).fill(0x2e);
      const encoder = new TextEncoder();
      const write = (text: string, offset: number): void => bytes.set(encoder.encode(text), offset);
      write("%PDF-1.7\n", 0);
      write(body, at);
      // The structural minimum every accepted document needs, parked in the
      // final chunk well clear of the boundary under test.
      write(
        `\n7 0 obj\n<< /Type /Page /StructTreeRoot 8 0 R /MarkInfo << /Marked true >> /FontFile2 9 0 R >>\nendobj\n`,
        totalBytes - 300
      );
      write("\n%%EOF\n", totalBytes - 7);
      return bytes;
    }

    const BOUNDARY = PDF_SCAN_CHUNK_BYTES;
    const SIZE = PDF_SCAN_CHUNK_BYTES * 2 + 4096;

    it("agrees with the whole-file scan on every existing fixture", () => {
      for (const bytes of [
        fixture("/Type/Page /Type/Catalog /Lang (en) /StructTreeRoot /MarkInfo /Outlines /FontFile2"),
        new Uint8Array([37, 80, 68, 70]),
        fixture("/StructTreeRoot /MarkInfo /FontFile2"),
        fixture("/Type/Page /FontFile2"),
        fixture("/Type/Page /StructTreeRoot /MarkInfo"),
        document("/Lang (en-GB)"),
        document("/Lang <64652D4445>"),
        document(""),
        new TextEncoder().encode("not a pdf at all, but long enough to clear the 32 byte floor"),
        fixture("/Type/Page /StructTreeRoot /MarkInfo /FontFile2 /Type/Pages /FontFileX"),
      ]) {
        agrees(bytes);
      }
    });

    // The marker is 11 bytes, so this walks it from fully inside chunk 0 to
    // fully inside chunk 1, hitting every possible split point in between.
    it.each(Array.from({ length: 14 }, (_, i) => BOUNDARY - 12 + i))(
      "counts a /Type /Page straddling the chunk boundary at offset %i exactly once",
      (at) => {
        const bytes = plantedAt(at, "/Type /Page", SIZE);
        const inspection = validatePdfOutput(bytes);
        // One planted + one in the structural tail; never 0 (missed) or 3 (double).
        expect(inspection.pageCount).toBe(2);
        agrees(bytes);
      }
    );

    it.each(Array.from({ length: 14 }, (_, i) => BOUNDARY - 12 + i))(
      "counts a /FontFile2 straddling the chunk boundary at offset %i exactly once",
      (at) => {
        const bytes = plantedAt(at, "/FontFile2", SIZE);
        expect(validatePdfOutput(bytes).embeddedFontFiles).toBe(2);
        agrees(bytes);
      }
    );

    it.each([BOUNDARY - 16, BOUNDARY - 8, BOUNDARY - 1, BOUNDARY, BOUNDARY + 4])(
      "detects /StructTreeRoot and /Outlines straddling the boundary at offset %i",
      (at) => {
        const bytes = plantedAt(at, "/Outlines", SIZE);
        expect(validatePdfOutput(bytes).hasOutline).toBe(true);
        agrees(bytes);
      }
    );

    it("does not gain a false word boundary from the chunk edge", () => {
      // `/Pages` must NOT count as `/Page\b`. If the window ended mid-token the
      // chunked scan would see end-of-string where the file has an `s`, and
      // report a page that is not there.
      for (let at = BOUNDARY - 12; at < BOUNDARY + 2; at += 1) {
        const bytes = plantedAt(at, "/Type /Pages", SIZE);
        expect(validatePdfOutput(bytes).pageCount).toBe(1); // the tail marker only
        agrees(bytes);
      }
    });

    it("matches /Type across a whitespace run longer than the boundary slack", () => {
      // `\s*` is unbounded, which is why the window extension is a loop and not
      // a constant. A 4 KiB whitespace run spanning the boundary must still join
      // its `/Type` to its `/Page`.
      const bytes = plantedAt(BOUNDARY - 2048, `/Type${" ".repeat(4096)}/Page`, SIZE);
      expect(validatePdfOutput(bytes).pageCount).toBe(2);
      agrees(bytes);
    });

    it("finds a catalog /Lang whose object spans the chunk boundary", () => {
      const bytes = plantedAt(
        BOUNDARY - 6,
        `\n2 0 obj\n<< /Type /Catalog /Lang (de-DE) >>\nendobj\n`,
        SIZE
      );
      expect(validatePdfOutput(bytes).hasLang).toBe(true);
      agrees(bytes);
    });

    it("treats a NO-BREAK SPACE as trailing whitespace after %%EOF, as the regex did", () => {
      // Latin-1 byte 0xA0 decodes to U+00A0, which `\s` matches. A byte scan
      // that only knew ASCII whitespace would call this file incomplete.
      const trailing = new Uint8Array([
        ...fixture("/Type/Page /StructTreeRoot /MarkInfo /FontFile2"),
        0xa0,
        0x0a,
      ]);
      expect(() => validatePdfOutput(trailing)).not.toThrow();
      agrees(trailing);
    });
  });
});
