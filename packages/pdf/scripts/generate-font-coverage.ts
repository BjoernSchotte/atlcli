import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDF_RUNTIME_ASSETS } from "../src/runtime-assets.js";

const FONT_DIR = fileURLToPath(new URL("../.fonts/", import.meta.url));
const OUTPUT = fileURLToPath(
  new URL("../src/font-coverage.generated.ts", import.meta.url),
);

function readU16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) {
    throw new Error(`Font coverage read exceeded the file at offset ${offset}.`);
  }
  return view.getUint16(offset);
}

function readI16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) {
    throw new Error(`Font coverage read exceeded the file at offset ${offset}.`);
  }
  return view.getInt16(offset);
}

function readU32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) {
    throw new Error(`Font coverage read exceeded the file at offset ${offset}.`);
  }
  return view.getUint32(offset);
}

function tag(bytes: Uint8Array, offset: number): string {
  if (offset < 0 || offset + 4 > bytes.byteLength) {
    throw new Error(`Font coverage tag exceeded the file at offset ${offset}.`);
  }
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

function cmapOffset(bytes: Uint8Array, view: DataView): number {
  const tableCount = readU16(view, 4);
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    if (tag(bytes, record) === "cmap") return readU32(view, record + 8);
  }
  throw new Error("Font has no cmap table.");
}

function addFormat4(
  codePoints: Set<number>,
  view: DataView,
  offset: number,
): void {
  const length = readU16(view, offset + 2);
  if (offset + length > view.byteLength) {
    throw new Error("Format 4 cmap exceeds the font bytes.");
  }
  const segmentCount = readU16(view, offset + 6) / 2;
  const endCodes = offset + 14;
  const startCodes = endCodes + segmentCount * 2 + 2;
  const deltas = startCodes + segmentCount * 2;
  const rangeOffsets = deltas + segmentCount * 2;
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const start = readU16(view, startCodes + segment * 2);
    const end = readU16(view, endCodes + segment * 2);
    const delta = readI16(view, deltas + segment * 2);
    const rangeOffsetAddress = rangeOffsets + segment * 2;
    const rangeOffset = readU16(view, rangeOffsetAddress);
    if (start > end || start === 0xffff) continue;
    for (let codePoint = start; codePoint <= end; codePoint += 1) {
      let glyph;
      if (rangeOffset === 0) {
        glyph = (codePoint + delta) & 0xffff;
      } else {
        const glyphAddress =
          rangeOffsetAddress + rangeOffset + (codePoint - start) * 2;
        glyph = readU16(view, glyphAddress);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) codePoints.add(codePoint);
    }
  }
}

function addFormat12(
  codePoints: Set<number>,
  view: DataView,
  offset: number,
): void {
  const length = readU32(view, offset + 4);
  if (offset + length > view.byteLength) {
    throw new Error("Format 12 cmap exceeds the font bytes.");
  }
  const groupCount = readU32(view, offset + 12);
  for (let group = 0; group < groupCount; group += 1) {
    const record = offset + 16 + group * 12;
    const start = readU32(view, record);
    const end = readU32(view, record + 4);
    const startGlyph = readU32(view, record + 8);
    if (start > end || end > 0x10ffff) {
      throw new Error("Format 12 cmap contains an invalid Unicode range.");
    }
    for (let codePoint = start; codePoint <= end; codePoint += 1) {
      if (startGlyph + codePoint - start !== 0) codePoints.add(codePoint);
    }
  }
}

export function fontCodePointRanges(
  bytes: Uint8Array,
): ReadonlyArray<readonly [number, number]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cmap = cmapOffset(bytes, view);
  const subtableCount = readU16(view, cmap + 2);
  const codePoints = new Set<number>();
  const visited = new Set<number>();
  for (let index = 0; index < subtableCount; index += 1) {
    const record = cmap + 4 + index * 8;
    const platform = readU16(view, record);
    const encoding = readU16(view, record + 2);
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) {
      continue;
    }
    const offset = cmap + readU32(view, record + 4);
    if (visited.has(offset)) continue;
    visited.add(offset);
    const format = readU16(view, offset);
    if (format === 4) addFormat4(codePoints, view, offset);
    else if (format === 12) addFormat12(codePoints, view, offset);
  }
  const sorted = [...codePoints].sort((left, right) => left - right);
  const ranges: Array<readonly [number, number]> = [];
  for (const codePoint of sorted) {
    const last = ranges.at(-1);
    if (last && codePoint === last[1] + 1) {
      ranges[ranges.length - 1] = [last[0], codePoint];
    } else {
      ranges.push([codePoint, codePoint]);
    }
  }
  return ranges;
}

export async function generatePdfFontCoverageSource(): Promise<string> {
  const entries = await Promise.all(
    PDF_RUNTIME_ASSETS.fonts.map(async (font) => {
      const bytes = new Uint8Array(
        await readFile(join(FONT_DIR, font.fileName)),
      );
      return {
        fileName: font.fileName,
        sha256: font.sha256,
        ranges: fontCodePointRanges(bytes),
      };
    }),
  );
  return `/* Generated by packages/pdf/scripts/generate-font-coverage.ts. */
/* Do not edit by hand; every range is derived from the SHA-256-pinned sfnt. */
export const PDF_FONT_COVERAGE_V1 = ${JSON.stringify(entries)} as const;
`;
}

if (import.meta.main) {
  await writeFile(OUTPUT, await generatePdfFontCoverageSource());
}
