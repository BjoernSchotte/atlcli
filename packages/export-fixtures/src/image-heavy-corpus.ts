/**
 * Deterministic image-heavy corpus (issue #118 Phase 0).
 *
 * Generates the "image-heavy" benchmark corpus from
 * `specs/issue-118-adaptive-browser-pdf-memory/PLAN.md`: at least 100 MiB of
 * aggregate realistic *compressed* PNG/JPEG at scale 1, with transparency,
 * repeated assets, and both inline and full-width placements — produced at
 * test time from `(seed, scale)` so no blob is ever committed.
 *
 * Determinism is the whole point, so the module ships its own pinned
 * encoders instead of using canvas, zlib bindings, or CompressionStream:
 *
 * - a baseline JPEG encoder (Annex K quantization/Huffman tables, 4:4:4,
 *   integer-reduced cosine constants — no runtime `Math.cos`/`sin`/`pow`,
 *   whose last-ulp results differ between JS engines);
 * - a PNG encoder with Paeth filtering and a fixed-Huffman DEFLATE with
 *   greedy LZ77 matching (RFC 1951), plus zlib wrapper and CRC/Adler32;
 * - a synchronous pure SHA-256 for the per-asset and manifest hashes.
 *
 * Content is photograph-like (multi-octave bilinear value noise, smooth
 * gradients) and screenshot-like (flat panels, text dashes) precisely so the
 * bytes *compress like real pages* — seeded per-pixel noise does not.
 *
 * Like `large-export-corpus.ts`, this module is IO-free and browser-safe.
 */
import type { ExportBlock, InlineNode } from "@atlcli/confluence/browser";

export const IMAGE_HEAVY_CORPUS_SCHEMA = "atlcli.image-heavy-corpus/1" as const;
export const IMAGE_HEAVY_CORPUS_DEFAULT_SEED = 0x1837_c0de;

/** Aggregate unique compressed bytes required at scale 1 (plan corpus table). */
export const IMAGE_HEAVY_MIN_AGGREGATE_BYTES = 100 * 1024 * 1024;

export interface ImageHeavyCorpusOptions {
  seed?: number;
  /**
   * Linear dimension factor in (0, 1]. Pixel counts and therefore compressed
   * bytes scale ~quadratically; the aggregate target scales with `scale²` so
   * small-scale corpora stay cheap for unit tests while exercising the same
   * code paths.
   */
  scale?: number;
}

export type ImageHeavyAssetRole = "photo" | "screenshot" | "diagram" | "logo";

export interface ImageHeavyAsset {
  filename: string;
  mediaType: "image/jpeg" | "image/png";
  role: ImageHeavyAssetRole;
  width: number;
  height: number;
  alpha: boolean;
  bytes: Uint8Array;
  sha256: string;
}

export interface ImageHeavyManifestEntry {
  filename: string;
  mediaType: "image/jpeg" | "image/png";
  role: ImageHeavyAssetRole;
  width: number;
  height: number;
  alpha: boolean;
  byteLength: number;
  sha256: string;
  placements: number;
}

export interface ImageHeavyCorpusCounts {
  uniqueAssets: number;
  uniqueAssetBytes: number;
  jpegBytes: number;
  pngBytes: number;
  alphaAssets: number;
  chapters: number;
  blocks: number;
  placements: number;
  inlinePlacements: number;
  fullWidthPlacements: number;
  logoPlacements: number;
}

export interface ImageHeavyCorpus {
  schema: typeof IMAGE_HEAVY_CORPUS_SCHEMA;
  seed: number;
  scale: number;
  minAggregateBytes: number;
  assets: ImageHeavyAsset[];
  blocks: ExportBlock[];
  manifest: ImageHeavyManifestEntry[];
  /** Pinnable digest over the manifest (recipe version + every asset hash). */
  manifestSha256: string;
  counts: ImageHeavyCorpusCounts;
}

/* ------------------------------------------------------------------------- *
 * Seeded randomness (same generator family as large-export-corpus).
 * ------------------------------------------------------------------------- */

interface RandomSource {
  next(): number;
  int(maxExclusive: number): number;
}

function randomSource(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next(): number {
      state = (state + 0x6d2b_79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    },
    int(maxExclusive: number): number {
      return Math.floor(this.next() * maxExclusive);
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Synchronous SHA-256 (pure, for manifest pinning; verified against
 * node:crypto in the test suite).
 * ------------------------------------------------------------------------- */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Hex(bytes: Uint8Array): string {
  const length = bytes.byteLength;
  const bitLength = length * 8;
  const paddedLength = (((length + 8) >> 6) + 1) << 6;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as [
      number, number, number, number, number, number, number, number,
    ];
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }
  let hex = "";
  for (let i = 0; i < 8; i += 1) hex += h[i]!.toString(16).padStart(8, "0");
  return hex;
}

/* ------------------------------------------------------------------------- *
 * Checksums and byte plumbing.
 * ------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(parts: Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (let i = 0; i < part.byteLength; i += 1) {
      crc = CRC_TABLE[(crc ^ part[i]!) & 0xff]! ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    a += bytes[i]!;
    b += a;
    if ((i & 0xfff) === 0xfff) {
      a %= 65521;
      b %= 65521;
    }
  }
  return (((b % 65521) << 16) | (a % 65521)) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

class ByteSink {
  private buffer = new Uint8Array(1 << 16);
  private used = 0;

  push(byte: number): void {
    if (this.used === this.buffer.byteLength) {
      const next = new Uint8Array(this.buffer.byteLength * 2);
      next.set(this.buffer);
      this.buffer = next;
    }
    this.buffer[this.used] = byte;
    this.used += 1;
  }

  bytes(): Uint8Array {
    return this.buffer.slice(0, this.used);
  }
}

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

class DeflateBitWriter {
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
function deflateFixed(data: Uint8Array): Uint8Array {
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

function zlibWrap(raw: Uint8Array, deflated: Uint8Array): Uint8Array {
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
function encodePng(
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

/* ------------------------------------------------------------------------- *
 * Baseline JPEG encoder (Annex K tables, 4:4:4).
 * ------------------------------------------------------------------------- */

// cos(m * π/16) for m = 0..8, as literals: runtime Math.cos is not pinned
// across JS engines, these doubles are.
const COS16 = [
  1,
  0.9807852804032304,
  0.9238795325112867,
  0.8314696123025452,
  0.7071067811865476,
  0.5555702330196022,
  0.3826834323650898,
  0.19509032201612825,
  0,
];

function cosByIndex(k: number): number {
  const reduced = k % 32;
  if (reduced <= 8) return COS16[reduced]!;
  if (reduced <= 16) return -COS16[16 - reduced]!;
  if (reduced <= 24) return -COS16[reduced - 16]!;
  return COS16[32 - reduced]!;
}

// M[u][x] = alpha(u)/2 * cos((2x+1)uπ/16) — the orthonormal DCT-II matrix.
const DCT_MATRIX = (() => {
  const matrix = new Float64Array(64);
  const invSqrt2 = COS16[4]!; // 1/√2 exactly equals cos(π/4)
  for (let u = 0; u < 8; u += 1) {
    for (let x = 0; x < 8; x += 1) {
      const alpha = u === 0 ? invSqrt2 : 1;
      matrix[u * 8 + x] = 0.5 * alpha * cosByIndex((2 * x + 1) * u);
    }
  }
  return matrix;
})();

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27,
  20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

const NATURAL_TO_ZIGZAG = (() => {
  const map = new Int32Array(64);
  ZIGZAG.forEach((naturalIndex, zigzagIndex) => {
    map[naturalIndex] = zigzagIndex;
  });
  return map;
})();

const QUANT_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69,
  56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81,
  104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const QUANT_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99,
  99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_CHROMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125];
const AC_LUMA_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61,
  0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52,
  0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25,
  0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
  0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64,
  0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83,
  0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99,
  0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3,
  0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8,
  0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];
const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 119];
const AC_CHROMA_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61,
  0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33,
  0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18,
  0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44,
  0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63,
  0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a,
  0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97,
  0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
  0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7,
  0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

interface HuffmanTable {
  codes: Int32Array;
  lengths: Int32Array;
}

function buildHuffmanTable(bits: number[], values: number[]): HuffmanTable {
  const codes = new Int32Array(256).fill(-1);
  const lengths = new Int32Array(256).fill(-1);
  let code = 0;
  let valueIndex = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let i = 0; i < bits[length - 1]!; i += 1) {
      const symbol = values[valueIndex]!;
      codes[symbol] = code;
      lengths[symbol] = length;
      code += 1;
      valueIndex += 1;
    }
    code <<= 1;
  }
  return { codes, lengths };
}

const DC_LUMA_TABLE = buildHuffmanTable(DC_LUMA_BITS, DC_LUMA_VALS);
const DC_CHROMA_TABLE = buildHuffmanTable(DC_CHROMA_BITS, DC_CHROMA_VALS);
const AC_LUMA_TABLE = buildHuffmanTable(AC_LUMA_BITS, AC_LUMA_VALS);
const AC_CHROMA_TABLE = buildHuffmanTable(AC_CHROMA_BITS, AC_CHROMA_VALS);

class JpegBitWriter {
  private sink = new ByteSink();
  private bitBuffer = 0;
  private bitCount = 0;

  writeBits(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i -= 1) {
      this.bitBuffer = (this.bitBuffer << 1) | ((value >>> i) & 1);
      this.bitCount += 1;
      if (this.bitCount === 8) {
        const byte = this.bitBuffer & 0xff;
        this.sink.push(byte);
        if (byte === 0xff) this.sink.push(0x00);
        this.bitBuffer = 0;
        this.bitCount = 0;
      }
    }
  }

  finish(): Uint8Array {
    // Pad the final byte with 1-bits per the JPEG spec.
    if (this.bitCount > 0) this.writeBits((1 << (8 - this.bitCount)) - 1, 8 - this.bitCount);
    return this.sink.bytes();
  }
}

function scaledQuantTable(base: number[], quality: number): Int32Array {
  const scale = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
  const table = new Int32Array(64);
  for (let i = 0; i < 64; i += 1) {
    const value = Math.floor((base[i]! * scale + 50) / 100);
    table[i] = Math.min(255, Math.max(1, value));
  }
  return table;
}

function magnitudeCategory(value: number): number {
  let magnitude = value < 0 ? -value : value;
  let category = 0;
  while (magnitude > 0) {
    magnitude >>= 1;
    category += 1;
  }
  return category;
}

function forwardDctQuantized(
  samples: Float64Array,
  quant: Int32Array,
  out: Int32Array
): void {
  const temp = new Float64Array(64);
  // rows: temp = M · samplesᵀ-ish — 1D DCT across x for each row y.
  for (let y = 0; y < 8; y += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let x = 0; x < 8; x += 1) sum += DCT_MATRIX[u * 8 + x]! * samples[y * 8 + x]!;
      temp[y * 8 + u] = sum;
    }
  }
  for (let u = 0; u < 8; u += 1) {
    for (let v = 0; v < 8; v += 1) {
      let sum = 0;
      for (let y = 0; y < 8; y += 1) sum += DCT_MATRIX[v * 8 + y]! * temp[y * 8 + u]!;
      // Quantize against the NATURAL-order table entry for (v, u); emit the
      // result at that coefficient's ZIGZAG position.
      const naturalIndex = v * 8 + u;
      out[NATURAL_TO_ZIGZAG[naturalIndex]!] = Math.round(sum / quant[naturalIndex]!);
    }
  }
}

function marker(id: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.byteLength);
  out[0] = 0xff;
  out[1] = id;
  out[2] = ((payload.byteLength + 2) >>> 8) & 0xff;
  out[3] = (payload.byteLength + 2) & 0xff;
  out.set(payload, 4);
  return out;
}

/** Encode interleaved RGB pixels as a baseline 4:4:4 JFIF JPEG. */
function encodeJpeg(
  pixels: Uint8Array,
  width: number,
  height: number,
  quality: number
): Uint8Array {
  if (width % 8 !== 0 || height % 8 !== 0) {
    throw new Error("The image-heavy JPEG encoder requires dimensions in whole 8x8 blocks.");
  }
  const quantLuma = scaledQuantTable(QUANT_LUMA, quality);
  const quantChroma = scaledQuantTable(QUANT_CHROMA, quality);

  const writer = new JpegBitWriter();
  const block = new Float64Array(64);
  const coefficients = new Int32Array(64);
  const previousDc = [0, 0, 0];

  const encodeBlock = (
    component: number,
    quant: Int32Array,
    dcTable: HuffmanTable,
    acTable: HuffmanTable
  ): void => {
    forwardDctQuantized(block, quant, coefficients);
    const dc = coefficients[0]!;
    const diff = dc - previousDc[component]!;
    previousDc[component] = dc;
    const dcCategory = magnitudeCategory(diff);
    writer.writeBits(dcTable.codes[dcCategory]!, dcTable.lengths[dcCategory]!);
    if (dcCategory > 0) {
      const bits = diff < 0 ? diff + (1 << dcCategory) - 1 : diff;
      writer.writeBits(bits, dcCategory);
    }
    let run = 0;
    for (let i = 1; i < 64; i += 1) {
      const value = coefficients[i]!;
      if (value === 0) {
        run += 1;
        continue;
      }
      while (run > 15) {
        writer.writeBits(acTable.codes[0xf0]!, acTable.lengths[0xf0]!);
        run -= 16;
      }
      const category = magnitudeCategory(value);
      const symbol = (run << 4) | category;
      writer.writeBits(acTable.codes[symbol]!, acTable.lengths[symbol]!);
      const bits = value < 0 ? value + (1 << category) - 1 : value;
      writer.writeBits(bits, category);
      run = 0;
    }
    if (run > 0) writer.writeBits(acTable.codes[0x00]!, acTable.lengths[0x00]!);
  };

  const luma = new Float64Array(width * height);
  const cb = new Float64Array(width * height);
  const cr = new Float64Array(width * height);
  for (let i = 0, p = 0; i < width * height; i += 1, p += 3) {
    const r = pixels[p]!;
    const g = pixels[p + 1]!;
    const b = pixels[p + 2]!;
    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
    cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }

  for (let blockY = 0; blockY < height; blockY += 8) {
    for (let blockX = 0; blockX < width; blockX += 8) {
      for (let component = 0; component < 3; component += 1) {
        const plane = component === 0 ? luma : component === 1 ? cb : cr;
        for (let y = 0; y < 8; y += 1) {
          for (let x = 0; x < 8; x += 1) {
            block[y * 8 + x] = plane[(blockY + y) * width + (blockX + x)]!;
          }
        }
        encodeBlock(
          component,
          component === 0 ? quantLuma : quantChroma,
          component === 0 ? DC_LUMA_TABLE : DC_CHROMA_TABLE,
          component === 0 ? AC_LUMA_TABLE : AC_CHROMA_TABLE
        );
      }
    }
  }

  const scanData = writer.finish();

  const jfif = marker(
    0xe0,
    new Uint8Array([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0])
  );
  // DQT payloads are zigzag-ordered per the JPEG spec; the scaled tables are
  // kept in natural order for quantization.
  const zigzagged = (table: Int32Array): Uint8Array => {
    const out = new Uint8Array(64);
    for (let k = 0; k < 64; k += 1) out[k] = table[ZIGZAG[k]!]!;
    return out;
  };
  const dqt = marker(0xdb, concat([
    new Uint8Array([0x00]),
    zigzagged(quantLuma),
    new Uint8Array([0x01]),
    zigzagged(quantChroma),
  ]));
  const sof = marker(0xc0, new Uint8Array([
    8,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    3,
    1, 0x11, 0,
    2, 0x11, 1,
    3, 0x11, 1,
  ]));
  const huffmanSegment = (cls: number, id: number, bits: number[], vals: number[]): Uint8Array =>
    concat([new Uint8Array([(cls << 4) | id]), new Uint8Array(bits), new Uint8Array(vals)]);
  const dht = marker(0xc4, concat([
    huffmanSegment(0, 0, DC_LUMA_BITS, DC_LUMA_VALS),
    huffmanSegment(1, 0, AC_LUMA_BITS, AC_LUMA_VALS),
    huffmanSegment(0, 1, DC_CHROMA_BITS, DC_CHROMA_VALS),
    huffmanSegment(1, 1, AC_CHROMA_BITS, AC_CHROMA_VALS),
  ]));
  const sos = marker(0xda, new Uint8Array([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]));

  return concat([
    new Uint8Array([0xff, 0xd8]),
    jfif,
    dqt,
    sof,
    dht,
    sos,
    scanData,
    new Uint8Array([0xff, 0xd9]),
  ]);
}

/* ------------------------------------------------------------------------- *
 * Deterministic content synthesis.
 * ------------------------------------------------------------------------- */

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Multi-octave bilinear value noise in [0, 1] — smooth, photograph-like. */
function valueNoiseField(
  width: number,
  height: number,
  seed: number,
  octaves: Array<{ cell: number; weight: number }>
): Float64Array {
  const field = new Float64Array(width * height);
  let totalWeight = 0;
  for (const octave of octaves) totalWeight += octave.weight;
  for (let octaveIndex = 0; octaveIndex < octaves.length; octaveIndex += 1) {
    const { cell, weight } = octaves[octaveIndex]!;
    const latticeWidth = Math.ceil(width / cell) + 2;
    const latticeHeight = Math.ceil(height / cell) + 2;
    const random = randomSource((seed ^ Math.imul(octaveIndex + 1, 0x85eb_ca6b)) >>> 0);
    const lattice = new Float64Array(latticeWidth * latticeHeight);
    for (let i = 0; i < lattice.length; i += 1) lattice[i] = random.next();
    for (let y = 0; y < height; y += 1) {
      const gy = y / cell;
      const y0 = Math.floor(gy);
      const ty = smoothstep(gy - y0);
      for (let x = 0; x < width; x += 1) {
        const gx = x / cell;
        const x0 = Math.floor(gx);
        const tx = smoothstep(gx - x0);
        const i00 = lattice[y0 * latticeWidth + x0]!;
        const i10 = lattice[y0 * latticeWidth + x0 + 1]!;
        const i01 = lattice[(y0 + 1) * latticeWidth + x0]!;
        const i11 = lattice[(y0 + 1) * latticeWidth + x0 + 1]!;
        const top = i00 + (i10 - i00) * tx;
        const bottom = i01 + (i11 - i01) * tx;
        field[y * width + x]! += (top + (bottom - top) * ty) * (weight / totalWeight);
      }
    }
  }
  return field;
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.floor(value);
}

/**
 * Photograph-like RGB content: layered smooth noise through a color ramp,
 * plus fine texture and sensor-style grain. The detail layers are what make
 * the JPEG land in a realistic 0.3–1.5 bytes/pixel band — perfectly smooth
 * gradients under-compress the corpus into uselessness, and pure per-pixel
 * noise over-compresses nothing at all.
 */
function photoPixels(width: number, height: number, seed: number): Uint8Array {
  // Smooth composition field: color blend and lighting.
  const base = valueNoiseField(width, height, seed, [
    { cell: Math.max(8, Math.floor(width / 4)), weight: 4 },
    { cell: Math.max(6, Math.floor(width / 12)), weight: 2 },
    { cell: Math.max(4, Math.floor(width / 40)), weight: 1 },
  ]);
  // Fine texture field: foliage/fabric-style luminance modulation. This is
  // where realistic JPEG bytes come from — coefficients must be large enough
  // to survive quantization, unlike faint grain.
  const detail = valueNoiseField(width, height, seed ^ 0x27d4_eb2f, [
    { cell: 6, weight: 1 },
    { cell: 3, weight: 1 },
    { cell: 2, weight: 0.8 },
  ]);
  // Medium-scale patch field thresholded into hard-edged regions (rocks,
  // shadows, foliage clumps): step edges carry high-frequency energy.
  const patches = valueNoiseField(width, height, seed ^ 0x165_667b1, [
    { cell: Math.max(6, Math.floor(width / 20)), weight: 1 },
    { cell: Math.max(4, Math.floor(width / 60)), weight: 0.5 },
  ]);
  const tint = randomSource(seed ^ 0x5bd1_e995);
  const skyR = 90 + tint.int(90);
  const skyG = 110 + tint.int(80);
  const skyB = 140 + tint.int(80);
  const groundR = 40 + tint.int(70);
  const groundG = 60 + tint.int(70);
  const groundB = 30 + tint.int(60);
  const pixels = new Uint8Array(width * height * 3);
  const centerX = width / 2;
  const centerY = height / 2;
  const maxDistance = centerX * centerX + centerY * centerY;
  let grainState = (seed ^ 0x9e37_79b9) >>> 0;
  for (let y = 0; y < height; y += 1) {
    const vertical = y / height;
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const noise = base[index]!;
      const dx = x - centerX;
      const dy = y - centerY;
      const vignette = 1 - (0.28 * (dx * dx + dy * dy)) / maxDistance;
      const blend = Math.min(1, Math.max(0, vertical * 1.2 - 0.1 + (noise - 0.5) * 0.7));
      const patch = patches[index]!;
      const shading = patch > 0.62 ? 0.55 : patch < 0.34 ? 1.18 : 1;
      const texture = 1 + 0.4 * (detail[index]! - 0.5);
      const light = (0.55 + 0.7 * noise) * vignette * shading * texture;
      grainState = (Math.imul(grainState, 1_664_525) + 1_013_904_223) >>> 0;
      const grain = ((grainState >>> 24) & 0x1f) - 15.5;
      const offset = index * 3;
      pixels[offset] = clampByte((skyR + (groundR - skyR) * blend) * light + grain);
      pixels[offset + 1] = clampByte((skyG + (groundG - skyG) * blend) * light + grain);
      pixels[offset + 2] = clampByte((skyB + (groundB - skyB) * blend) * light + grain);
    }
  }
  return pixels;
}

function fillRect(
  pixels: Uint8Array,
  width: number,
  channels: number,
  x0: number,
  y0: number,
  rectWidth: number,
  rectHeight: number,
  color: number[]
): void {
  for (let y = y0; y < y0 + rectHeight; y += 1) {
    for (let x = x0; x < x0 + rectWidth; x += 1) {
      const offset = (y * width + x) * channels;
      for (let c = 0; c < channels; c += 1) pixels[offset + c] = color[c]!;
    }
  }
}

/**
 * Screenshot-like RGB content: flat panels, header, sidebar, text dashes,
 * plus one textured "hero image" region — real page screenshots embed
 * photos/previews, and that region is what gives a screenshot PNG both its
 * realistic byte weight and a non-trivial decoded footprint.
 */
function screenshotPixels(width: number, height: number, seed: number): Uint8Array {
  const random = randomSource(seed);
  const pixels = new Uint8Array(width * height * 3);
  fillRect(pixels, width, 3, 0, 0, width, height, [248, 249, 251]);
  const headerHeight = Math.max(24, Math.floor(height * 0.07));
  fillRect(pixels, width, 3, 0, 0, width, headerHeight, [23, 43, 77]);
  const sidebarWidth = Math.max(32, Math.floor(width * 0.18));
  fillRect(pixels, width, 3, 0, headerHeight, sidebarWidth, height - headerHeight, [235, 237, 240]);
  const accent = [
    [38, 132, 255],
    [0, 135, 90],
    [222, 53, 11],
    [101, 84, 192],
  ][random.int(4)]!;

  const contentX = sidebarWidth + Math.floor(width * 0.03);
  const contentWidth = width - contentX - Math.floor(width * 0.03);

  // Hero image region under the header: duotone-textured, grainy.
  const heroHeight = Math.max(24, Math.floor(height * 0.24));
  const heroY = headerHeight + Math.floor(height * 0.03);
  const hero = valueNoiseField(contentWidth, heroHeight, seed ^ 0x4e60, [
    { cell: Math.max(8, Math.floor(contentWidth / 10)), weight: 2 },
    { cell: 4, weight: 1 },
    { cell: 2, weight: 0.6 },
  ]);
  let heroGrain = (seed ^ 0x00c0_ffee) >>> 0;
  for (let y = 0; y < heroHeight; y += 1) {
    for (let x = 0; x < contentWidth; x += 1) {
      const value = hero[y * contentWidth + x]!;
      heroGrain = (Math.imul(heroGrain, 1_664_525) + 1_013_904_223) >>> 0;
      const grain = ((heroGrain >>> 26) & 0x07) - 3.5;
      const offset = ((heroY + y) * width + contentX + x) * 3;
      pixels[offset] = clampByte(40 + accent[0]! * value * 0.75 + grain);
      pixels[offset + 1] = clampByte(46 + accent[1]! * value * 0.75 + grain);
      pixels[offset + 2] = clampByte(58 + accent[2]! * value * 0.75 + grain);
    }
  }

  let cursorY = heroY + heroHeight + Math.floor(height * 0.02);
  while (cursorY < height - 40) {
    const panelHeight = Math.min(height - cursorY - 8, 60 + random.int(120));
    fillRect(pixels, width, 3, contentX, cursorY, contentWidth, panelHeight, [255, 255, 255]);
    fillRect(pixels, width, 3, contentX, cursorY, contentWidth, 2, [223, 225, 230]);
    fillRect(pixels, width, 3, contentX, cursorY + 8, Math.floor(contentWidth * 0.3), 10, accent);
    let lineY = cursorY + 28;
    while (lineY < cursorY + panelHeight - 12) {
      let dashX = contentX + 12;
      const lineEnd = contentX + contentWidth - 16 - random.int(Math.floor(contentWidth * 0.3));
      while (dashX < lineEnd) {
        const dashWidth = 12 + random.int(48);
        const clipped = Math.min(dashWidth, lineEnd - dashX);
        fillRect(pixels, width, 3, dashX, lineY, clipped, 6, [66, 82, 110]);
        dashX += clipped + 6 + random.int(10);
      }
      lineY += 16;
    }
    cursorY += panelHeight + Math.floor(height * 0.02);
  }
  return pixels;
}

/** Diagram-like RGBA content with a genuinely transparent background. */
function diagramPixels(width: number, height: number, seed: number): Uint8Array {
  const random = randomSource(seed);
  const pixels = new Uint8Array(width * height * 4); // alpha 0 everywhere first
  const nodeWidth = Math.max(48, Math.floor(width * 0.18));
  const nodeHeight = Math.max(32, Math.floor(height * 0.22));
  const laneY = [Math.floor(height * 0.18), Math.floor(height * 0.55)];
  const palette = [
    [222, 235, 255, 255],
    [212, 244, 230, 255],
    [255, 235, 213, 255],
    [234, 230, 255, 255],
  ];
  for (const y of laneY) {
    for (let column = 0; column < 3; column += 1) {
      const x = Math.floor(width * 0.08 + column * width * 0.32);
      // soft shadow: semi-transparent, exercises non-trivial alpha values
      fillRect(pixels, width, 4, x + 6, y + 6, nodeWidth, nodeHeight, [23, 43, 77, 96]);
      fillRect(pixels, width, 4, x, y, nodeWidth, nodeHeight, palette[random.int(4)]!);
      fillRect(pixels, width, 4, x, y, nodeWidth, 4, [23, 43, 77, 255]);
      if (column < 2) {
        const connectorY = y + Math.floor(nodeHeight / 2);
        fillRect(
          pixels, width, 4,
          x + nodeWidth, connectorY - 2, Math.floor(width * 0.32) - nodeWidth, 4,
          [23, 43, 77, 255]
        );
      }
    }
  }
  return pixels;
}

/** Small logo tile (RGBA) reused across every chapter for dedup pressure. */
function logoPixels(width: number, height: number, seed: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const random = randomSource(seed);
  const hueSeed = random.int(3);
  const color = [[0, 82, 204, 255], [0, 135, 90, 255], [101, 84, 192, 255]][hueSeed]!;
  fillRect(pixels, width, 4, 0, 0, width, height, [255, 255, 255, 0]);
  const bar = Math.floor(height / 5);
  fillRect(pixels, width, 4, 0, bar, width, bar, color);
  fillRect(pixels, width, 4, 0, bar * 3, Math.floor(width * 0.7), bar, [23, 43, 77, 255]);
  return pixels;
}

/* ------------------------------------------------------------------------- *
 * Corpus assembly.
 * ------------------------------------------------------------------------- */

function roundToBlocks(value: number): number {
  return Math.max(64, Math.floor(value / 8) * 8);
}

const FULL_SCALE = {
  photo: { width: 2400, height: 1792, quality: 88, count: 12 },
  screenshot: { width: 2200, height: 1400, count: 12 },
  diagram: { width: 2000, height: 1200, count: 6 },
  logo: { width: 400, height: 160 },
  maxTopUpPhotos: 64,
} as const;

export function generateImageHeavyCorpus(
  options: ImageHeavyCorpusOptions = {}
): ImageHeavyCorpus {
  const seed = (options.seed ?? IMAGE_HEAVY_CORPUS_DEFAULT_SEED) >>> 0;
  const scale = options.scale ?? 1;
  if (!(scale > 0 && scale <= 1)) {
    throw new Error("The image-heavy corpus scale must be in (0, 1].");
  }
  const minAggregateBytes = Math.ceil(IMAGE_HEAVY_MIN_AGGREGATE_BYTES * scale * scale);

  const photoWidth = roundToBlocks(FULL_SCALE.photo.width * scale);
  const photoHeight = roundToBlocks(FULL_SCALE.photo.height * scale);
  const screenshotWidth = roundToBlocks(FULL_SCALE.screenshot.width * scale);
  const screenshotHeight = roundToBlocks(FULL_SCALE.screenshot.height * scale);
  const diagramWidth = roundToBlocks(FULL_SCALE.diagram.width * scale);
  const diagramHeight = roundToBlocks(FULL_SCALE.diagram.height * scale);
  const logoWidth = roundToBlocks(FULL_SCALE.logo.width * Math.max(scale, 0.25));
  const logoHeight = roundToBlocks(FULL_SCALE.logo.height * Math.max(scale, 0.25));

  const assets: ImageHeavyAsset[] = [];
  let aggregateBytes = 0;

  const pushAsset = (asset: Omit<ImageHeavyAsset, "sha256">): void => {
    assets.push({ ...asset, sha256: sha256Hex(asset.bytes) });
    aggregateBytes += asset.bytes.byteLength;
  };

  for (let index = 0; index < FULL_SCALE.screenshot.count; index += 1) {
    const bytes = encodePng(
      screenshotPixels(screenshotWidth, screenshotHeight, seed ^ (0x51ee + index)),
      screenshotWidth, screenshotHeight, false
    );
    pushAsset({
      filename: `screenshot-${index + 1}.png`,
      mediaType: "image/png",
      role: "screenshot",
      width: screenshotWidth,
      height: screenshotHeight,
      alpha: false,
      bytes,
    });
  }
  for (let index = 0; index < FULL_SCALE.diagram.count; index += 1) {
    const bytes = encodePng(
      diagramPixels(diagramWidth, diagramHeight, seed ^ (0xd1a6 + index)),
      diagramWidth, diagramHeight, true
    );
    pushAsset({
      filename: `diagram-${index + 1}.png`,
      mediaType: "image/png",
      role: "diagram",
      width: diagramWidth,
      height: diagramHeight,
      alpha: true,
      bytes,
    });
  }
  pushAsset({
    filename: "corpus-logo.png",
    mediaType: "image/png",
    role: "logo",
    width: logoWidth,
    height: logoHeight,
    alpha: true,
    bytes: encodePng(logoPixels(logoWidth, logoHeight, seed ^ 0x1060), logoWidth, logoHeight, true),
  });

  // Photos carry the bulk of the aggregate; keep adding unique ones until the
  // scale-adjusted minimum is guaranteed, so the ≥100 MiB claim is enforced by
  // construction rather than by hoping the fixed counts land above it.
  let photoIndex = 0;
  while (
    photoIndex < FULL_SCALE.photo.count ||
    (aggregateBytes < minAggregateBytes && photoIndex < FULL_SCALE.photo.count + FULL_SCALE.maxTopUpPhotos)
  ) {
    const bytes = encodeJpeg(
      photoPixels(photoWidth, photoHeight, seed ^ (0xf070 + photoIndex * 7)),
      photoWidth, photoHeight, FULL_SCALE.photo.quality
    );
    pushAsset({
      filename: `photo-${photoIndex + 1}.jpg`,
      mediaType: "image/jpeg",
      role: "photo",
      width: photoWidth,
      height: photoHeight,
      alpha: false,
      bytes,
    });
    photoIndex += 1;
  }
  if (aggregateBytes < minAggregateBytes) {
    throw new Error(
      `The image-heavy corpus recipe cannot reach its aggregate minimum: ` +
        `${aggregateBytes} < ${minAggregateBytes} bytes after ${photoIndex} photos.`
    );
  }

  const photos = assets.filter((asset) => asset.role === "photo");
  const screenshots = assets.filter((asset) => asset.role === "screenshot");
  const diagrams = assets.filter((asset) => asset.role === "diagram");
  const logo = assets.find((asset) => asset.role === "logo")!;

  const placements = new Map<string, number>();
  const placed = (filename: string): string => {
    placements.set(filename, (placements.get(filename) ?? 0) + 1);
    return filename;
  };

  const blocks: ExportBlock[] = [];
  let inlinePlacements = 0;
  let fullWidthPlacements = 0;
  let logoPlacements = 0;
  const chapters = photos.length;
  for (let chapter = 0; chapter < chapters; chapter += 1) {
    const photo = photos[chapter]!;
    blocks.push({
      type: "heading",
      level: 1,
      content: [{ type: "text", text: `Image-heavy chapter ${chapter + 1}` }],
    });
    blocks.push({
      type: "image",
      source: { kind: "attachment", filename: placed(logo.filename) },
      alt: "Corpus logo",
    });
    logoPlacements += 1;
    blocks.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text:
            "Deterministic image-heavy corpus chapter exercising realistic " +
            "compressed media, repeats, and mixed placements.",
        },
      ],
    });
    blocks.push({
      type: "image",
      source: { kind: "attachment", filename: placed(photo.filename) },
      alt: `Photographic fixture ${chapter + 1}`,
    });
    fullWidthPlacements += 1;

    const screenshot = screenshots[chapter % screenshots.length]!;
    const inlineMedia: InlineNode = {
      type: "media",
      media: { filename: screenshot.filename },
      source: { kind: "attachment", filename: placed(screenshot.filename) },
      alt: `Inline screenshot ${chapter + 1}`,
    };
    blocks.push({
      type: "paragraph",
      content: [
        { type: "text", text: "Wrapped inline media " },
        inlineMedia,
        { type: "text", text: " inside running text keeps the inline path exercised." },
      ],
    });
    inlinePlacements += 1;

    if (chapter % 3 === 0) {
      const diagram = diagrams[Math.floor(chapter / 3) % diagrams.length]!;
      blocks.push({
        type: "image",
        source: { kind: "attachment", filename: placed(diagram.filename) },
        alt: `Transparent diagram ${chapter + 1}`,
      });
      fullWidthPlacements += 1;
    }
    if (chapter < chapters - 1) blocks.push({ type: "pageBreak" });
  }

  const manifest: ImageHeavyManifestEntry[] = assets.map((asset) => ({
    filename: asset.filename,
    mediaType: asset.mediaType,
    role: asset.role,
    width: asset.width,
    height: asset.height,
    alpha: asset.alpha,
    byteLength: asset.bytes.byteLength,
    sha256: asset.sha256,
    placements: placements.get(asset.filename) ?? 0,
  }));

  const manifestDescriptor =
    `${IMAGE_HEAVY_CORPUS_SCHEMA}|seed=${seed}|scale=${scale}|` +
    manifest
      .map(
        (entry) =>
          `${entry.filename}|${entry.mediaType}|${entry.width}x${entry.height}|` +
          `${entry.byteLength}|${entry.sha256}|${entry.placements}`
      )
      .join("|");
  const manifestSha256 = sha256Hex(new TextEncoder().encode(manifestDescriptor));

  const counts: ImageHeavyCorpusCounts = {
    uniqueAssets: assets.length,
    uniqueAssetBytes: aggregateBytes,
    jpegBytes: assets
      .filter((asset) => asset.mediaType === "image/jpeg")
      .reduce((total, asset) => total + asset.bytes.byteLength, 0),
    pngBytes: assets
      .filter((asset) => asset.mediaType === "image/png")
      .reduce((total, asset) => total + asset.bytes.byteLength, 0),
    alphaAssets: assets.filter((asset) => asset.alpha).length,
    chapters,
    blocks: blocks.length,
    placements: [...placements.values()].reduce((total, count) => total + count, 0),
    inlinePlacements,
    fullWidthPlacements,
    logoPlacements,
  };

  return {
    schema: IMAGE_HEAVY_CORPUS_SCHEMA,
    seed,
    scale,
    minAggregateBytes,
    assets,
    blocks,
    manifest,
    manifestSha256,
    counts,
  };
}

/** Resolve a corpus asset by attachment filename (throws on a miss). */
export function resolveImageHeavyAsset(
  corpus: ImageHeavyCorpus,
  filename: string
): { bytes: Uint8Array; mediaType: string; filename: string } {
  const asset = corpus.assets.find((candidate) => candidate.filename === filename);
  if (!asset) throw new Error(`Unknown image-heavy corpus asset: ${filename}`);
  return { bytes: asset.bytes, mediaType: asset.mediaType, filename: asset.filename };
}
