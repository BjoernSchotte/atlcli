/**
 * Pinned PNG decoder (issue #118 Phase 1): zlib/RFC-1951 inflate (stored,
 * fixed, and dynamic Huffman), scanline unfiltering (all five filters), and
 * expansion of the 8-bit color types (gray, RGB, palette, gray+alpha, RGBA,
 * plus tRNS) into RGBA. Deterministic pure TS — no host zlib.
 *
 * Anything outside the supported envelope (16-bit depth, interlacing,
 * malformed streams) returns `null` so the caller keeps the ORIGINAL bytes
 * instead of guessing — profiles must never corrupt an image they cannot
 * decode faithfully.
 */
import { adler32 } from "./bytes.js";

export interface DecodedRaster {
  /** RGBA, 4 bytes per pixel. */
  pixels: Uint8Array;
  width: number;
  height: number;
  /** True when any pixel carries alpha below 255. */
  hasAlpha: boolean;
}

/* ------------------------------------------------------------------------- *
 * Inflate (RFC 1951).
 * ------------------------------------------------------------------------- */

class BitReader {
  #bitBuffer = 0;
  #bitCount = 0;
  #offset: number;

  constructor(private readonly data: Uint8Array, offset: number) {
    this.#offset = offset;
  }

  bits(count: number): number {
    while (this.#bitCount < count) {
      if (this.#offset >= this.data.byteLength) throw new Error("deflate stream truncated");
      this.#bitBuffer |= this.data[this.#offset]! << this.#bitCount;
      this.#offset += 1;
      this.#bitCount += 8;
    }
    const value = this.#bitBuffer & ((1 << count) - 1);
    this.#bitBuffer >>>= count;
    this.#bitCount -= count;
    return value;
  }

  alignToByte(): void {
    this.#bitBuffer = 0;
    this.#bitCount = 0;
  }

  byteOffset(): number {
    return this.#offset;
  }

  copyStored(length: number, out: Uint8Array, outOffset: number): void {
    this.alignToByte();
    if (this.#offset + length > this.data.byteLength) {
      throw new Error("deflate stored block truncated");
    }
    out.set(this.data.subarray(this.#offset, this.#offset + length), outOffset);
    this.#offset += length;
  }
}

/** Canonical Huffman decode table: per-length first codes and symbol rows. */
interface HuffmanDecodeTable {
  counts: Int32Array; // symbols per length 1..15
  symbols: Int32Array; // symbols ordered by (length, code)
}

function buildDecodeTable(lengths: ArrayLike<number>): HuffmanDecodeTable {
  const counts = new Int32Array(16);
  for (let i = 0; i < lengths.length; i += 1) counts[lengths[i]!]! += 1;
  counts[0] = 0;
  const offsets = new Int32Array(16);
  for (let length = 1; length < 16; length += 1) {
    offsets[length] = offsets[length - 1]! + counts[length - 1]!;
  }
  const symbols = new Int32Array(lengths.length);
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol]!;
    if (length !== 0) {
      symbols[offsets[length]!] = symbol;
      offsets[length] = offsets[length]! + 1;
    }
  }
  return { counts, symbols };
}

function decodeSymbol(reader: BitReader, table: HuffmanDecodeTable): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let length = 1; length < 16; length += 1) {
    code |= reader.bits(1);
    const count = table.counts[length]!;
    if (code - first < count) return table.symbols[index + (code - first)]!;
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error("invalid huffman code");
}

const INFLATE_LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
  131, 163, 195, 227, 258,
];
const INFLATE_LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const INFLATE_DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
  2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const INFLATE_DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
  13, 13,
];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const FIXED_LITERAL_TABLE = (() => {
  const lengths = new Int32Array(288);
  for (let i = 0; i < 144; i += 1) lengths[i] = 8;
  for (let i = 144; i < 256; i += 1) lengths[i] = 9;
  for (let i = 256; i < 280; i += 1) lengths[i] = 7;
  for (let i = 280; i < 288; i += 1) lengths[i] = 8;
  return buildDecodeTable(lengths);
})();
const FIXED_DIST_TABLE = (() => {
  const lengths = new Int32Array(30).fill(5);
  return buildDecodeTable(lengths);
})();

/** Inflate a raw RFC 1951 stream into a caller-sized output buffer. */
export function inflateRaw(data: Uint8Array, offset: number, out: Uint8Array): number {
  const reader = new BitReader(data, offset);
  let outOffset = 0;
  for (;;) {
    const final = reader.bits(1);
    const type = reader.bits(2);
    if (type === 0) {
      reader.alignToByte();
      const length = reader.bits(16);
      const complement = reader.bits(16);
      if ((length ^ 0xffff) !== complement) throw new Error("deflate stored length mismatch");
      if (outOffset + length > out.byteLength) throw new Error("inflate output overflow");
      reader.copyStored(length, out, outOffset);
      outOffset += length;
      if (final) return outOffset;
      continue;
    }
    let literalTable = FIXED_LITERAL_TABLE;
    let distTable = FIXED_DIST_TABLE;
    if (type === 2) {
      const hlit = reader.bits(5) + 257;
      const hdist = reader.bits(5) + 1;
      const hclen = reader.bits(4) + 4;
      const codeLengths = new Int32Array(19);
      for (let i = 0; i < hclen; i += 1) codeLengths[CODE_LENGTH_ORDER[i]!] = reader.bits(3);
      const codeTable = buildDecodeTable(codeLengths);
      const lengths = new Int32Array(hlit + hdist);
      let filled = 0;
      while (filled < hlit + hdist) {
        const symbol = decodeSymbol(reader, codeTable);
        if (symbol < 16) {
          lengths[filled] = symbol;
          filled += 1;
        } else if (symbol === 16) {
          if (filled === 0) throw new Error("invalid code-length repeat");
          const previous = lengths[filled - 1]!;
          const repeat = 3 + reader.bits(2);
          for (let i = 0; i < repeat; i += 1) lengths[filled + i] = previous;
          filled += repeat;
        } else if (symbol === 17) {
          filled += 3 + reader.bits(3);
        } else {
          filled += 11 + reader.bits(7);
        }
      }
      literalTable = buildDecodeTable(lengths.subarray(0, hlit));
      distTable = buildDecodeTable(lengths.subarray(hlit));
    } else if (type !== 1) {
      throw new Error("invalid deflate block type");
    }
    for (;;) {
      const symbol = decodeSymbol(reader, literalTable);
      if (symbol < 256) {
        if (outOffset >= out.byteLength) throw new Error("inflate output overflow");
        out[outOffset] = symbol;
        outOffset += 1;
        continue;
      }
      if (symbol === 256) break;
      const lengthCode = symbol - 257;
      if (lengthCode >= INFLATE_LENGTH_BASE.length) throw new Error("invalid length code");
      const length = INFLATE_LENGTH_BASE[lengthCode]! + reader.bits(INFLATE_LENGTH_EXTRA[lengthCode]!);
      const distCode = decodeSymbol(reader, distTable);
      if (distCode >= INFLATE_DIST_BASE.length) throw new Error("invalid distance code");
      const distance = INFLATE_DIST_BASE[distCode]! + reader.bits(INFLATE_DIST_EXTRA[distCode]!);
      if (distance > outOffset) throw new Error("inflate distance before start");
      if (outOffset + length > out.byteLength) throw new Error("inflate output overflow");
      for (let i = 0; i < length; i += 1) {
        out[outOffset] = out[outOffset - distance]!;
        outOffset += 1;
      }
    }
    if (final) return outOffset;
  }
}

/** zlib-wrapped inflate with Adler-32 verification. */
export function inflateZlib(data: Uint8Array, out: Uint8Array): number {
  if (data.byteLength < 6) throw new Error("zlib stream truncated");
  const cmf = data[0]!;
  const flg = data[1]!;
  if ((cmf & 0x0f) !== 8) throw new Error("unsupported zlib method");
  if (((cmf << 8) | flg) % 31 !== 0) throw new Error("zlib header check failed");
  if (flg & 0x20) throw new Error("zlib preset dictionary unsupported");
  const written = inflateRaw(data, 2, out);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const expected = view.getUint32(data.byteLength - 4);
  const actual = adler32(out.subarray(0, written));
  if (expected !== actual) throw new Error("zlib adler32 mismatch");
  return written;
}

/* ------------------------------------------------------------------------- *
 * PNG structure, unfiltering, RGBA expansion.
 * ------------------------------------------------------------------------- */

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decode an 8-bit, non-interlaced PNG into RGBA. Returns `null` for anything
 * outside that envelope or for malformed data.
 */
export function decodePngRaster(bytes: Uint8Array): DecodedRaster | null {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength < 45 || SIG.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    let palette: Uint8Array | undefined;
    let transparency: Uint8Array | undefined;
    let idatLength = 0;
    const idatParts: Uint8Array[] = [];
    while (offset + 12 <= bytes.byteLength) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(
        bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!,
      );
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      if (data.byteLength !== length) return null;
      if (type === "IHDR") {
        width = view.getUint32(offset + 8);
        height = view.getUint32(offset + 12);
        bitDepth = data[8]!;
        colorType = data[9]!;
        interlace = data[12]!;
      } else if (type === "PLTE") {
        palette = data;
      } else if (type === "tRNS") {
        transparency = data;
      } else if (type === "IDAT") {
        idatParts.push(data);
        idatLength += data.byteLength;
      } else if (type === "IEND") {
        break;
      }
      offset += 12 + length;
    }
    if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
    const channels = PNG_CHANNELS[colorType];
    if (!channels) return null;
    if (colorType === 3 && !palette) return null;

    const idat = new Uint8Array(idatLength);
    let idatOffset = 0;
    for (const part of idatParts) {
      idat.set(part, idatOffset);
      idatOffset += part.byteLength;
    }
    const stride = width * channels;
    const raw = new Uint8Array(height * (1 + stride));
    const written = inflateZlib(idat, raw);
    if (written !== raw.byteLength) return null;

    // Unfilter in place (per scanline; the filter byte prefixes each row).
    const line = new Uint8Array(stride); // previous unfiltered row
    const pixels = new Uint8Array(width * height * 4);
    let hasAlpha = false;
    const current = new Uint8Array(stride);
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * (1 + stride);
      const filter = raw[rowStart]!;
      for (let x = 0; x < stride; x += 1) {
        const value = raw[rowStart + 1 + x]!;
        const left = x >= channels ? current[x - channels]! : 0;
        const up = line[x]!;
        const upLeft = x >= channels ? line[x - channels]! : 0;
        let reconstructed: number;
        switch (filter) {
          case 0: reconstructed = value; break;
          case 1: reconstructed = value + left; break;
          case 2: reconstructed = value + up; break;
          case 3: reconstructed = value + ((left + up) >> 1); break;
          case 4: reconstructed = value + paethPredictor(left, up, upLeft); break;
          default: return null;
        }
        current[x] = reconstructed & 0xff;
      }
      // Expand this row to RGBA.
      for (let x = 0; x < width; x += 1) {
        const src = x * channels;
        const dst = (y * width + x) * 4;
        let r = 0; let g = 0; let b = 0; let a = 255;
        if (colorType === 0) {
          r = g = b = current[src]!;
          if (transparency && transparency.byteLength >= 2 && ((transparency[0]! << 8) | transparency[1]!) === r) a = 0;
        } else if (colorType === 2) {
          r = current[src]!; g = current[src + 1]!; b = current[src + 2]!;
          if (
            transparency && transparency.byteLength >= 6 &&
            ((transparency[0]! << 8) | transparency[1]!) === r &&
            ((transparency[2]! << 8) | transparency[3]!) === g &&
            ((transparency[4]! << 8) | transparency[5]!) === b
          ) a = 0;
        } else if (colorType === 3) {
          const index = current[src]!;
          const p = index * 3;
          if (p + 2 >= palette!.byteLength) return null;
          r = palette![p]!; g = palette![p + 1]!; b = palette![p + 2]!;
          if (transparency && index < transparency.byteLength) a = transparency[index]!;
        } else if (colorType === 4) {
          r = g = b = current[src]!; a = current[src + 1]!;
        } else {
          r = current[src]!; g = current[src + 1]!; b = current[src + 2]!; a = current[src + 3]!;
        }
        pixels[dst] = r; pixels[dst + 1] = g; pixels[dst + 2] = b; pixels[dst + 3] = a;
        if (a !== 255) hasAlpha = true;
      }
      line.set(current);
    }
    return { pixels, width, height, hasAlpha };
  } catch {
    return null;
  }
}
