/**
 * Pinned baseline JPEG encoder (Annex K tables, 4:4:4, literal cosine
 * constants — no runtime transcendentals, whose last-ulp results differ
 * between JS engines). Moved verbatim from `@atlcli/export-fixtures` (the
 * corpus recipe-hash pin proves byte identity); issue #118 Phase 1 uses it
 * for normalized derivatives too. The shared DCT constants also drive the
 * decoder's IDCT.
 */
import { ByteSink, concat, writeUint32 } from "./bytes.js";

/* ------------------------------------------------------------------------- *
 * Baseline JPEG encoder (Annex K tables, 4:4:4).
 * ------------------------------------------------------------------------- */

// cos(m * π/16) for m = 0..8, as literals: runtime Math.cos is not pinned
// across JS engines, these doubles are.
export const COS16 = [
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
export const DCT_MATRIX = (() => {
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

export const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27,
  20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

export const NATURAL_TO_ZIGZAG = (() => {
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
export function encodeJpeg(
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
