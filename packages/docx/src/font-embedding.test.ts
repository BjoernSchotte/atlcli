import { describe, expect, it } from "bun:test";
import {
  CODE_FONT_FAMILY,
  CODE_FONT_KEY,
  CODE_FONT_SHA256,
  DocxFontEmbeddingError,
  assertBundledCodeFont,
  assertEmbeddableSfnt,
  ensureEmbeddedCodeFont,
  obfuscateFont,
} from "./font-embedding.js";
import { buildDocx, para } from "./fixtures.js";
import { unzipDocx } from "./scan.js";

const fontUrl = new URL("../fonts/JetBrainsMono-Regular.ttf", import.meta.url);

async function codeFont(): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(fontUrl).arrayBuffer());
}

function reverseObfuscation(bytes: Uint8Array, fontKey: string): Uint8Array {
  const compact = fontKey.replace(/[{}-]/gu, "");
  const key = Uint8Array.from(
    compact.match(/[0-9a-f]{2}/giu)!.map((hex) => Number.parseInt(hex, 16)),
  ).reverse();
  const output = bytes.slice();
  for (let index = 0; index < 32; index += 1) {
    output[index] = output[index]! ^ key[index % key.byteLength]!;
  }
  return output;
}

function occurrences(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function withEmbeddingRights(source: Uint8Array, fsType: number): Uint8Array {
  const bytes = source.slice();
  const tableCount = (bytes[4]! << 8) | bytes[5]!;
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4));
    if (tag !== "OS/2") continue;
    const offset =
      ((bytes[record + 8]! << 24) >>> 0)
      + (bytes[record + 9]! << 16)
      + (bytes[record + 10]! << 8)
      + bytes[record + 11]!;
    bytes[offset + 8] = (fsType >>> 8) & 0xff;
    bytes[offset + 9] = fsType & 0xff;
    return bytes;
  }
  throw new Error("fixture font has no OS/2 table");
}

describe("DOCX code-font embedding", () => {
  it("accepts the committed OFL face and applies the ECMA-376 first-32-byte transform", async () => {
    const source = await codeFont();
    expect(() => assertEmbeddableSfnt(source)).not.toThrow();
    expect(CODE_FONT_SHA256).toHaveLength(64);
    await expect(assertBundledCodeFont(source)).resolves.toBeUndefined();

    const obfuscated = obfuscateFont(source);
    expect(obfuscated).not.toEqual(source);
    expect(obfuscated.slice(0, 32)).not.toEqual(source.slice(0, 32));
    expect(obfuscated.slice(32)).toEqual(source.slice(32));
    expect(reverseObfuscation(obfuscated, CODE_FONT_KEY)).toEqual(source);
  });

  it("writes one deterministic font part, font-table entry, and relationship chain", async () => {
    const source = await codeFont();
    const zip = unzipDocx(buildDocx({ body: para("$scroll.content") }));

    ensureEmbeddedCodeFont(zip, source);
    ensureEmbeddedCodeFont(zip, source);

    const fontTable = zip.file("word/fontTable.xml")!.asText();
    const fontTableRels = zip.file("word/_rels/fontTable.xml.rels")!.asText();
    const documentRels = zip.file("word/_rels/document.xml.rels")!.asText();
    const contentTypes = zip.file("[Content_Types].xml")!.asText();
    const fontParts = Object.keys(zip.files).filter((path) => path.endsWith(".odttf"));

    expect(fontParts).toEqual([
      "word/fonts/atlcli-code-001b70dc-aa60-4ad5-90ec-18a0948e1eae.odttf",
    ]);
    expect(reverseObfuscation(zip.file(fontParts[0]!)!.asUint8Array(), CODE_FONT_KEY))
      .toEqual(source);
    expect(occurrences(fontTable, new RegExp(`w:name="${CODE_FONT_FAMILY}"`, "gu"))).toBe(1);
    expect(fontTable).toContain(
      `<w:embedRegular r:id="rIdAtlcliCodeFont" w:fontKey="${CODE_FONT_KEY}"/>`,
    );
    expect(occurrences(fontTableRels, /Id="rIdAtlcliCodeFont"/gu)).toBe(1);
    expect(fontTableRels).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"',
    );
    expect(occurrences(documentRels, /relationships\/fontTable/gu)).toBe(1);
    expect(contentTypes).toContain(
      'ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"',
    );
    expect(contentTypes).toContain(
      'PartName="/word/fontTable.xml"',
    );
  });

  it("rejects corrupt, restricted, and bitmap-only fonts before package mutation", async () => {
    const source = await codeFont();
    const zip = unzipDocx(buildDocx({ body: para("$scroll.content") }));
    const originalNames = Object.keys(zip.files);
    const originalContentTypes = zip.file("[Content_Types].xml")!.asText();

    for (const invalid of [
      new Uint8Array(32),
      withEmbeddingRights(source, 0x0002),
      withEmbeddingRights(source, 0x0200),
    ]) {
      expect(() => ensureEmbeddedCodeFont(zip, invalid)).toThrow(
        DocxFontEmbeddingError,
      );
      expect(Object.keys(zip.files)).toEqual(originalNames);
      expect(zip.file("[Content_Types].xml")!.asText()).toBe(originalContentTypes);
    }
  });

  it("rejects a different otherwise-embeddable font before production export", async () => {
    const source = await codeFont();
    const changed = source.slice();
    changed[changed.byteLength - 1] = changed[changed.byteLength - 1]! ^ 0x01;
    expect(() => assertEmbeddableSfnt(changed)).not.toThrow();
    await expect(assertBundledCodeFont(changed)).rejects.toThrow(
      DocxFontEmbeddingError,
    );
  });
});
