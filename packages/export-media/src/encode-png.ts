/**
 * Pinned PNG encoder: Paeth-filtered scanlines over an in-repo fixed-Huffman
 * DEFLATE with greedy LZ77 (RFC 1951). Deterministic across engines by
 * construction — no host zlib, no CompressionStream. Moved verbatim from
 * `@atlcli/export-fixtures` (the corpus recipe-hash pin proves byte
 * identity); issue #118 Phase 1 uses it for normalized derivatives too.
 */
import { adler32, ByteSink, concat, crc32, writeUint32 } from "./bytes.js";

/* ------------------------------------------------------------------------- *
 * DEFLATE (RFC 1951): fixed Huffman, greedy LZ77 — deterministic by
 * construction, pinned in-repo instead of trusting a host zlib.
 * ------------------------------------------------------------------------- */

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
  131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
  2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
  13, 13,
];

export class DeflateBitWriter {
  private sink = new ByteSink();
  private bitBuffer = 0;
  private bitCount = 0;

  writeBitsLsb(value: number, count: number): void {
    this.bitBuffer |= value << this.bitCount;
    this.bitCount += count;
    while (this.bitCount >= 8) {
      this.sink.push(this.bitBuffer & 0xff);
      this.bitBuffer >>>= 8;
      this.bitCount -= 8;
    }
  }

  /** Huffman codes are packed most-significant-bit first (RFC 1951 §3.1.1). */
  writeCodeMsb(code: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.writeBitsLsb((code >>> i) & 1, 1);
  }

  finish(): Uint8Array {
    if (this.bitCount > 0) this.sink.push(this.bitBuffer & 0xff);
    return this.sink.bytes();
  }
}

function writeFixedLiteral(writer: DeflateBitWriter, symbol: number): void {
  if (symbol <= 143) writer.writeCodeMsb(0x30 + symbol, 8);
  else if (symbol <= 255) writer.writeCodeMsb(0x190 + (symbol - 144), 9);
  else if (symbol <= 279) writer.writeCodeMsb(symbol - 256, 7);
  else writer.writeCodeMsb(0xc0 + (symbol - 280), 8);
}

const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const WINDOW_SIZE = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const MAX_CHAIN = 64;

function hash3(data: Uint8Array, index: number): number {
  return (
    Math.imul(
      (data[index]! << 16) ^ (data[index + 1]! << 8) ^ data[index + 2]!,
      0x9e3779b1
    ) >>> (32 - HASH_BITS)
  ) & (HASH_SIZE - 1);
}

/** Raw DEFLATE stream: one final fixed-Huffman block with greedy LZ77. */
export function deflateFixed(data: Uint8Array): Uint8Array {
  const writer = new DeflateBitWriter();
  writer.writeBitsLsb(1, 1); // BFINAL
  writer.writeBitsLsb(1, 2); // BTYPE=01 fixed Huffman

  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(data.byteLength).fill(-1);
  let index = 0;
  while (index < data.byteLength) {
    let bestLength = 0;
    let bestDistance = 0;
    if (index + MIN_MATCH <= data.byteLength) {
      let candidate = head[hash3(data, index)]!;
      let chain = 0;
      const limit = Math.min(MAX_MATCH, data.byteLength - index);
      while (candidate >= 0 && index - candidate <= WINDOW_SIZE && chain < MAX_CHAIN) {
        let length = 0;
        while (length < limit && data[candidate + length] === data[index + length]) {
          length += 1;
        }
        if (length > bestLength) {
          bestLength = length;
          bestDistance = index - candidate;
          if (length === limit) break;
        }
        candidate = prev[candidate]!;
        chain += 1;
      }
    }
    if (bestLength >= MIN_MATCH) {
      let lengthCode = 28;
      while (bestLength < LENGTH_BASE[lengthCode]!) lengthCode -= 1;
      writeFixedLiteral(writer, 257 + lengthCode);
      writer.writeBitsLsb(bestLength - LENGTH_BASE[lengthCode]!, LENGTH_EXTRA[lengthCode]!);
      let distCode = 29;
      while (bestDistance < DIST_BASE[distCode]!) distCode -= 1;
      writer.writeCodeMsb(distCode, 5);
      writer.writeBitsLsb(bestDistance - DIST_BASE[distCode]!, DIST_EXTRA[distCode]!);
      const matchEnd = index + bestLength;
      const hashable = Math.min(matchEnd, data.byteLength - MIN_MATCH + 1);
      while (index < hashable) {
        const slot = hash3(data, index);
        prev[index] = head[slot]!;
        head[slot] = index;
        index += 1;
      }
      index = matchEnd;
    } else {
      writeFixedLiteral(writer, data[index]!);
      if (index + MIN_MATCH <= data.byteLength) {
        const slot = hash3(data, index);
        prev[index] = head[slot]!;
        head[slot] = index;
      }
      index += 1;
    }
  }
  writeFixedLiteral(writer, 256); // end of block
  return writer.finish();
}

export function zlibWrap(raw: Uint8Array, deflated: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + deflated.byteLength + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(deflated, 2);
  writeUint32(out, 2 + deflated.byteLength, adler32(raw));
  return out;
}

/* ------------------------------------------------------------------------- *
 * PNG encoder (Paeth-filtered scanlines, single IDAT).
 * ------------------------------------------------------------------------- */

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((char) => char.charCodeAt(0)));
  const chunk = new Uint8Array(12 + data.byteLength);
  writeUint32(chunk, 0, data.byteLength);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  writeUint32(chunk, 8 + data.byteLength, crc32([typeBytes, data]));
  return chunk;
}

/** Encode interleaved pixels (RGBA when alpha, RGB otherwise) as a PNG. */
export function encodePng(
  pixels: Uint8Array,
  width: number,
  height: number,
  alpha: boolean
): Uint8Array {
  const channels = alpha ? 4 : 3;
  const stride = width * channels;
  const filtered = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    const outStart = y * (1 + stride);
    filtered[outStart] = 4; // Paeth for every row: deterministic and effective
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[rowStart + x - channels]! : 0;
      const up = y > 0 ? pixels[rowStart - stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[rowStart - stride + x - channels]! : 0;
      filtered[outStart + 1 + x] = (pixels[rowStart + x]! - paeth(left, up, upLeft)) & 0xff;
    }
  }
  const idat = zlibWrap(filtered, deflateFixed(filtered));
  const header = new Uint8Array(13);
  writeUint32(header, 0, width);
  writeUint32(header, 4, height);
  header[8] = 8; // bit depth
  header[9] = alpha ? 6 : 2; // color type
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array()),
  ]);
}
