import { describe, expect, it } from "bun:test";
import { validatePdfOutput } from "./validate.js";

function fixture(body: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n${body}\n%%EOF\n`);
}

describe("validatePdfOutput", () => {
  it("reports structural PDF properties", () => {
    expect(validatePdfOutput(fixture("/Type/Page /StructTreeRoot /MarkInfo /Outlines /FontFile2")))
      .toEqual({ pageCount: 1, tagged: true, hasOutline: true, embeddedFontFiles: 1 });
  });

  it.each([
    ["truncated", new Uint8Array([37, 80, 68, 70])],
    ["no pages", fixture("/StructTreeRoot /MarkInfo /FontFile2")],
    ["untagged", fixture("/Type/Page /FontFile2")],
    ["fontless", fixture("/Type/Page /StructTreeRoot /MarkInfo")],
  ])("rejects %s output", (_label, bytes) => {
    expect(() => validatePdfOutput(bytes)).toThrow();
  });
});
