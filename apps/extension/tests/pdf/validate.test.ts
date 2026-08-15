import { describe, expect, it } from "bun:test";
import { validatePdfOutput } from "@atlcli/pdf/internal";

function fixture(body: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n${body}\n%%EOF\n`);
}

describe("validatePdfOutput", () => {
  it("reports pages, tags, outline and embedded fonts", () => {
    expect(
      validatePdfOutput(
        fixture("/Type /Page /Type/Page /StructTreeRoot /MarkInfo /Outlines /FontFile2")
      )
    ).toEqual({ pageCount: 2, tagged: true, hasOutline: true, embeddedFontFiles: 1, hasLang: false });
  });

  it("reports the document language the extension's own exports declare (spec 011)", () => {
    // The extension consumes the same structural gate as the CLI, so the
    // PDF/UA language property must be visible on this side of the seam too.
    expect(
      validatePdfOutput(
        fixture("/Type/Page /Type /Catalog /Lang (de-DE) /StructTreeRoot /MarkInfo /FontFile2")
      ).hasLang
    ).toBe(true);
  });

  it.each([
    ["truncated", new Uint8Array([37, 80, 68, 70]), "truncated"],
    ["no pages", fixture("/StructTreeRoot /MarkInfo /FontFile2"), "no pages"],
    ["untagged", fixture("/Type/Page /FontFile2"), "tag structure"],
    ["fontless", fixture("/Type/Page /StructTreeRoot /MarkInfo"), "font files"],
  ])("rejects %s output", (_label, bytes, expected) => {
    expect(() => validatePdfOutput(bytes)).toThrow(expected);
  });
});
