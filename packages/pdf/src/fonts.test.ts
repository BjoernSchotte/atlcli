import { beforeAll, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { ensurePdfFonts } from "../scripts/ensure-fonts.js";
import {
  FontParseError,
  FontVerificationError,
  MAX_FONT_BYTES,
  parseFontMeta,
  sha256Hex,
  verifyFontBytes,
  WEB_PACKAGED_FONT_GUIDANCE,
} from "./fonts.js";
import type { FontAsset } from "./types.js";

// Real font bytes come from the actual bundled compiler fonts (Source Sans 3,
// Source Serif 4, …) that `packages/pdf-compiler-browser` compiles with. They
// are downloaded and sha256-verified by `ensurePdfFonts` into `packages/pdf/.fonts`.
let sourceSansTtf: Uint8Array;
let sourceSerifTtf: Uint8Array;

beforeAll(async () => {
  const { cacheDir } = await ensurePdfFonts({ logger: () => {} });
  const read = async (fileName: string): Promise<Uint8Array> =>
    new Uint8Array(await Bun.file(fileURLToPath(new URL(`file://${cacheDir}/${fileName}`))).arrayBuffer());
  sourceSansTtf = await read("SourceSans3-Regular.ttf");
  sourceSerifTtf = await read("SourceSerif4-Regular.ttf");
});

// --- sfnt fixture builders (real name-table bytes extracted from real fonts) ---

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}
function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}
function tagBytes(tag: string): number[] {
  return [tag.charCodeAt(0), tag.charCodeAt(1), tag.charCodeAt(2), tag.charCodeAt(3)];
}

/** Extract the raw bytes of one table from a real sfnt font. */
function extractTable(font: Uint8Array, tag: string): Uint8Array {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const numTables = view.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const t = String.fromCharCode(font[rec]!, font[rec + 1]!, font[rec + 2]!, font[rec + 3]!);
    if (t === tag) {
      const offset = view.getUint32(rec + 8);
      const length = view.getUint32(rec + 12);
      return font.subarray(offset, offset + length);
    }
  }
  throw new Error(`table ${tag} not found`);
}

/**
 * Build a valid single-face sfnt with the given magic and tables. Table data is
 * placed after the directory with file-absolute offsets; checksums are zeroed
 * (parsing does not verify them). Returns { bytes, size } for chaining into a TTC.
 */
function buildSfnt(magic: number[], tables: Array<{ tag: string; data: Uint8Array }>): Uint8Array {
  const numTables = tables.length;
  const dirSize = 12 + numTables * 16;
  const aligned = (n: number): number => (n + 3) & ~3;
  let dataCursor = aligned(dirSize);
  const placed = tables.map((t) => {
    const offset = dataCursor;
    dataCursor = aligned(dataCursor + t.data.length);
    return { ...t, offset };
  });
  const total = dataCursor;
  const out = new Uint8Array(total);
  out.set(magic, 0);
  out.set(u16(numTables), 4); // numTables; searchRange/entrySelector/rangeShift left zero
  placed.forEach((t, i) => {
    const rec = 12 + i * 16;
    out.set(tagBytes(t.tag), rec);
    out.set(u32(0), rec + 4); // checksum
    out.set(u32(t.offset), rec + 8);
    out.set(u32(t.data.length), rec + 12);
    out.set(t.data, t.offset);
  });
  return out;
}

/**
 * Build a valid TTC referencing multiple faces. Each face gets its own offset
 * table and its own copy of its tables, all with file-absolute offsets, so the
 * every-face parse loop is genuinely exercised on real name-table bytes.
 */
function buildTtc(faces: Array<Array<{ tag: string; data: Uint8Array }>>): Uint8Array {
  const numFonts = faces.length;
  const aligned = (n: number): number => (n + 3) & ~3;
  const headerSize = 12 + numFonts * 4;
  // Layout: [ttc header][offset table 0][offset table 1]…[data 0][data 1]…
  const offsetTableSizes = faces.map((f) => 12 + f.length * 16);
  const faceOffsets: number[] = [];
  let cursor = aligned(headerSize);
  for (const size of offsetTableSizes) {
    faceOffsets.push(cursor);
    cursor = aligned(cursor + size);
  }
  // Place each face's table data and record absolute offsets.
  const facePlacements = faces.map((f) => {
    const placed = f.map((t) => {
      const offset = cursor;
      cursor = aligned(cursor + t.data.length);
      return { ...t, offset };
    });
    return placed;
  });
  const total = cursor;
  const out = new Uint8Array(total);
  out.set(tagBytes("ttcf"), 0);
  out.set(u16(1), 4); // majorVersion
  out.set(u16(0), 6); // minorVersion
  out.set(u32(numFonts), 8);
  faceOffsets.forEach((off, i) => out.set(u32(off), 12 + i * 4));
  faces.forEach((f, fi) => {
    const dir = faceOffsets[fi]!;
    out.set(u32(0x00010000), dir); // sfntVersion
    out.set(u16(f.length), dir + 4);
    facePlacements[fi]!.forEach((t, i) => {
      const rec = dir + 12 + i * 16;
      out.set(tagBytes(t.tag), rec);
      out.set(u32(0), rec + 4);
      out.set(u32(t.offset), rec + 8);
      out.set(u32(t.data.length), rec + 12);
      out.set(t.data, t.offset);
    });
  });
  return out;
}

describe("parseFontMeta", () => {
  it("accepts a real TrueType (TTF) font and reads its family", () => {
    const faces = parseFontMeta(sourceSansTtf);
    expect(faces).toHaveLength(1);
    expect(faces[0]!.family).toBe("Source Sans 3");
    expect(faces[0]!.style).toBe("normal");
    expect(faces[0]!.weight).toBe(400);
  });

  it("accepts a real CFF/OpenType (OTF) sfnt built from a real name table", () => {
    // No .otf ships in the repo; build a genuine OTTO-signatured sfnt whose
    // `name` table is the real, unmodified Source Sans 3 name table.
    const otf = buildSfnt(tagBytes("OTTO"), [{ tag: "name", data: extractTable(sourceSansTtf, "name") }]);
    const faces = parseFontMeta(otf);
    expect(faces).toHaveLength(1);
    expect(faces[0]!.family).toBe("Source Sans 3");
  });

  it("returns one record per face for a real multi-face ttcf collection", () => {
    // A TTC bundling two real faces (Sans + Serif). Must not drop the second.
    const ttc = buildTtc([
      [{ tag: "name", data: extractTable(sourceSansTtf, "name") }],
      [{ tag: "name", data: extractTable(sourceSerifTtf, "name") }],
    ]);
    const faces = parseFontMeta(ttc);
    expect(faces).toHaveLength(2);
    expect(faces.map((f) => f.family).sort()).toEqual(["Source Sans 3", "Source Serif 4"]);
  });

  it("rejects WOFF2 with actionable desktop-font guidance", () => {
    const woff2 = new Uint8Array([...tagBytes("wOF2"), ...u32(0x00010000), 0, 0, 0, 0]);
    try {
      parseFontMeta(woff2);
      throw new Error("expected FontParseError");
    } catch (error) {
      expect(error).toBeInstanceOf(FontParseError);
      expect((error as FontParseError).reason).toBe("web-packaged");
      expect((error as FontParseError).message).toBe(WEB_PACKAGED_FONT_GUIDANCE);
    }
  });

  it("rejects WOFF with the web-packaged reason", () => {
    const woff = new Uint8Array([...tagBytes("wOFF"), ...u32(0x00010000), 0, 0, 0, 0]);
    expect(() => parseFontMeta(woff)).toThrow(FontParseError);
    try {
      parseFontMeta(woff);
    } catch (error) {
      expect((error as FontParseError).reason).toBe("web-packaged");
    }
  });

  it("rejects an unsupported magic cleanly", () => {
    const junk = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0]); // "%PDF"
    try {
      parseFontMeta(junk);
      throw new Error("expected FontParseError");
    } catch (error) {
      expect(error).toBeInstanceOf(FontParseError);
      expect((error as FontParseError).reason).toBe("unsupported-format");
    }
  });

  it("rejects a zero-length buffer with a typed error (not RangeError)", () => {
    try {
      parseFontMeta(new Uint8Array(0));
      throw new Error("expected FontParseError");
    } catch (error) {
      expect(error).toBeInstanceOf(FontParseError);
      expect(error).not.toBeInstanceOf(RangeError);
      expect((error as FontParseError).reason).toBe("empty");
    }
  });

  it("rejects a truncated header cleanly (not RangeError)", () => {
    // Valid TTF magic + a numTables claim, but no table directory follows.
    const truncated = new Uint8Array([...u32(0x00010000), ...u16(5)]);
    try {
      parseFontMeta(truncated);
      throw new Error("expected FontParseError");
    } catch (error) {
      expect(error).toBeInstanceOf(FontParseError);
      expect(error).not.toBeInstanceOf(RangeError);
      expect((error as FontParseError).reason).toBe("truncated");
    }
  });

  it("rejects a hostile numTables cleanly (not RangeError)", () => {
    // numTables = 0xFFFF but no directory bytes — must not read out of bounds.
    const hostile = new Uint8Array([...u32(0x00010000), ...u16(0xffff), 0, 0, 0, 0]);
    try {
      parseFontMeta(hostile);
      throw new Error("expected FontParseError");
    } catch (error) {
      expect(error).toBeInstanceOf(FontParseError);
      expect(error).not.toBeInstanceOf(RangeError);
      expect((error as FontParseError).reason).toBe("truncated");
    }
  });

  it("rejects a name-table offset pointing past the buffer cleanly (not RangeError)", () => {
    // One 'name' table whose directory offset points far beyond the bytes.
    const numTables = 1;
    const bytes = new Uint8Array(12 + numTables * 16);
    bytes.set(u32(0x00010000), 0);
    bytes.set(u16(numTables), 4);
    const rec = 12;
    bytes.set(tagBytes("name"), rec);
    bytes.set(u32(0), rec + 4);
    bytes.set(u32(0x7fffffff), rec + 8); // offset far past the buffer
    bytes.set(u32(64), rec + 12); // length
    try {
      parseFontMeta(bytes);
      throw new Error("expected FontParseError");
    } catch (error) {
      expect(error).toBeInstanceOf(FontParseError);
      expect(error).not.toBeInstanceOf(RangeError);
      expect(["truncated", "malformed-name-table"]).toContain((error as FontParseError).reason);
    }
  });

  it("rejects a font over the 10 MB cap", () => {
    const oversized = new Uint8Array(MAX_FONT_BYTES + 1);
    oversized.set(u32(0x00010000), 0);
    try {
      parseFontMeta(oversized);
      throw new Error("expected FontParseError");
    } catch (error) {
      expect(error).toBeInstanceOf(FontParseError);
      expect((error as FontParseError).reason).toBe("too-large");
    }
  });
});

describe("verifyFontBytes", () => {
  function assetFor(sha256: string): FontAsset {
    return { family: "Source Sans 3", style: "normal", weight: 400, sha256 };
  }

  it("accepts bytes whose real SHA-256 matches the asset", async () => {
    const digest = await sha256Hex(sourceSansTtf);
    await expect(verifyFontBytes(assetFor(digest), sourceSansTtf)).resolves.toBeUndefined();
  });

  it("is case-insensitive on the recorded hash", async () => {
    const digest = (await sha256Hex(sourceSansTtf)).toUpperCase();
    await expect(verifyFontBytes(assetFor(digest), sourceSansTtf)).resolves.toBeUndefined();
  });

  it("throws a typed mismatch on a single flipped bit (real WebCrypto)", async () => {
    const digest = await sha256Hex(sourceSansTtf);
    const tampered = new Uint8Array(sourceSansTtf);
    tampered[Math.floor(tampered.length / 2)]! ^= 0x01;
    await expect(verifyFontBytes(assetFor(digest), tampered)).rejects.toBeInstanceOf(FontVerificationError);
  });
});
