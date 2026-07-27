/**
 * Pinned baseline JPEG decoder (issue #118 Phase 1): huffman-coded baseline
 * and extended-sequential frames (SOF0/SOF1), 1–3 components, sampling
 * factors 1–2 (4:4:4, 4:2:2, 4:2:0, grayscale), restart markers, IDCT over
 * the SAME literal cosine matrix the encoder uses. Deterministic pure TS.
 *
 * Progressive (SOF2), arithmetic coding, 12-bit precision, and anything
 * malformed return `null`: the caller keeps the ORIGINAL bytes — profiles
 * must never corrupt an image they cannot decode faithfully.
 */
import { DCT_MATRIX, ZIGZAG } from "./encode-jpeg.js";
import type { DecodedRaster } from "./decode-png.js";

interface HuffmanNode {
  counts: Int32Array;
  symbols: Int32Array;
}

function buildTable(counts: ArrayLike<number>, symbols: ArrayLike<number>): HuffmanNode {
  return { counts: Int32Array.from({ length: 17 }, (_, i) => (i === 0 ? 0 : Number(counts[i - 1]))), symbols: Int32Array.from(symbols as number[]) };
}

class ScanReader {
  #bitBuffer = 0;
  #bitCount = 0;
  offset: number;
  /** Set when a marker (FF xx, xx != 00) interrupts the entropy stream. */
  marker = 0;

  constructor(private readonly data: Uint8Array, offset: number) {
    this.offset = offset;
  }

  #fill(): boolean {
    if (this.marker) return false;
    if (this.offset >= this.data.byteLength) return false;
    let byte = this.data[this.offset]!;
    if (byte === 0xff) {
      const next = this.data[this.offset + 1];
      if (next === 0x00) {
        this.offset += 2; // stuffed literal FF
      } else {
        this.marker = next ?? 0xd9;
        return false;
      }
    } else {
      this.offset += 1;
    }
    this.#bitBuffer = (this.#bitBuffer << 8) | byte;
    this.#bitCount += 8;
    return true;
  }

  /** MSB-first bit read; past-the-end bits decode as zero (per libjpeg). */
  bit(): number {
    if (this.#bitCount === 0 && !this.#fill()) return 0;
    this.#bitCount -= 1;
    return (this.#bitBuffer >>> this.#bitCount) & 1;
  }

  bits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = (value << 1) | this.bit();
    return value;
  }

  restart(): void {
    this.#bitBuffer = 0;
    this.#bitCount = 0;
    if (this.marker >= 0xd0 && this.marker <= 0xd7) {
      this.marker = 0;
      this.offset += 2; // consume the RSTn marker itself
    }
  }
}

function decodeHuffmanSymbol(reader: ScanReader, table: HuffmanNode): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let length = 1; length <= 16; length += 1) {
    code |= reader.bit();
    const count = table.counts[length]!;
    if (code - first < count) return table.symbols[index + (code - first)]!;
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error("invalid jpeg huffman code");
}

/** EXTEND (ITU T.81 F.2.2.1): map a magnitude-category bit pattern to a value. */
function extend(value: number, size: number): number {
  return value < 1 << (size - 1) ? value - (1 << size) + 1 : value;
}

interface FrameComponent {
  id: number;
  h: number;
  v: number;
  quantId: number;
  dcTable?: HuffmanNode;
  acTable?: HuffmanNode;
  /** Per-component plane at its own sampling resolution. */
  plane?: Uint8Array;
  planeWidth?: number;
  planeHeight?: number;
  pred: number;
}

/** Decode a baseline JPEG into RGBA (alpha always opaque). */
export function decodeJpegRaster(bytes: Uint8Array): DecodedRaster | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const quantTables = new Map<number, Int32Array>();
    const dcTables = new Map<number, HuffmanNode>();
    const acTables = new Map<number, HuffmanNode>();
    let components: FrameComponent[] = [];
    let width = 0;
    let height = 0;
    let restartInterval = 0;
    let offset = 2;

    for (;;) {
      if (offset + 4 > bytes.byteLength) return null;
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      if (marker === 0xd8) { offset += 2; continue; }
      if (marker === 0xd9) return null; // EOI before any scan
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.byteLength) return null;
      const segment = bytes.subarray(offset + 4, offset + 2 + length);

      if (marker === 0xdb) {
        let at = 0;
        while (at < segment.byteLength) {
          const pq = segment[at]! >> 4;
          const tq = segment[at]! & 0x0f;
          at += 1;
          const table = new Int32Array(64);
          for (let i = 0; i < 64; i += 1) {
            table[ZIGZAG[i]!] = pq ? (segment[at]! << 8) | segment[at + 1]! : segment[at]!;
            at += pq ? 2 : 1;
          }
          quantTables.set(tq, table);
        }
      } else if (marker === 0xc4) {
        let at = 0;
        while (at + 17 <= segment.byteLength) {
          const cls = segment[at]! >> 4;
          const id = segment[at]! & 0x0f;
          const counts = segment.subarray(at + 1, at + 17);
          let total = 0;
          for (const count of counts) total += count;
          const symbols = segment.subarray(at + 17, at + 17 + total);
          if (symbols.byteLength !== total) return null;
          (cls === 0 ? dcTables : acTables).set(id, buildTable(counts, symbols));
          at += 17 + total;
        }
      } else if (marker === 0xc0 || marker === 0xc1) {
        const precision = segment[0]!;
        if (precision !== 8) return null;
        height = (segment[1]! << 8) | segment[2]!;
        width = (segment[3]! << 8) | segment[4]!;
        const count = segment[5]!;
        if (!width || !height || count < 1 || count > 3) return null;
        components = [];
        for (let i = 0; i < count; i += 1) {
          const at = 6 + i * 3;
          const h = segment[at + 1]! >> 4;
          const v = segment[at + 1]! & 0x0f;
          if (h < 1 || h > 2 || v < 1 || v > 2) return null;
          components.push({ id: segment[at]!, h, v, quantId: segment[at + 2]!, pred: 0 });
        }
      } else if (marker >= 0xc2 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return null; // progressive/arithmetic/lossless frames unsupported
      } else if (marker === 0xdd) {
        restartInterval = (segment[0]! << 8) | segment[1]!;
      } else if (marker === 0xda) {
        if (!components.length) return null;
        const count = segment[0]!;
        if (count !== components.length) return null;
        for (let i = 0; i < count; i += 1) {
          const id = segment[1 + i * 2]!;
          const tables = segment[2 + i * 2]!;
          const component = components.find((candidate) => candidate.id === id);
          if (!component) return null;
          component.dcTable = dcTables.get(tables >> 4);
          component.acTable = acTables.get(tables & 0x0f);
          if (!component.dcTable || !component.acTable) return null;
        }
        const scanStart = offset + 2 + length;
        return decodeScan(bytes, scanStart, components, quantTables, width, height, restartInterval);
      }
      offset += 2 + length;
    }
  } catch {
    return null;
  }
}

function decodeScan(
  bytes: Uint8Array,
  scanStart: number,
  components: FrameComponent[],
  quantTables: Map<number, Int32Array>,
  width: number,
  height: number,
  restartInterval: number,
): DecodedRaster | null {
  const hMax = Math.max(...components.map((c) => c.h));
  const vMax = Math.max(...components.map((c) => c.v));
  const mcuWidth = hMax * 8;
  const mcuHeight = vMax * 8;
  const mcusX = Math.ceil(width / mcuWidth);
  const mcusY = Math.ceil(height / mcuHeight);

  for (const component of components) {
    component.planeWidth = mcusX * component.h * 8;
    component.planeHeight = mcusY * component.v * 8;
    component.plane = new Uint8Array(component.planeWidth * component.planeHeight);
    if (!quantTables.has(component.quantId)) return null;
  }

  const reader = new ScanReader(bytes, scanStart);
  const coefficients = new Int32Array(64);
  const block = new Float64Array(64);
  const temp = new Float64Array(64);
  let mcusSinceRestart = 0;

  for (let mcuY = 0; mcuY < mcusY; mcuY += 1) {
    for (let mcuX = 0; mcuX < mcusX; mcuX += 1) {
      if (restartInterval && mcusSinceRestart === restartInterval) {
        reader.restart();
        for (const component of components) component.pred = 0;
        mcusSinceRestart = 0;
      }
      for (const component of components) {
        const quant = quantTables.get(component.quantId)!;
        for (let blockV = 0; blockV < component.v; blockV += 1) {
          for (let blockH = 0; blockH < component.h; blockH += 1) {
            coefficients.fill(0);
            const dcSize = decodeHuffmanSymbol(reader, component.dcTable!);
            const diff = dcSize ? extend(reader.bits(dcSize), dcSize) : 0;
            component.pred += diff;
            coefficients[0] = component.pred;
            let index = 1;
            while (index < 64) {
              const symbol = decodeHuffmanSymbol(reader, component.acTable!);
              const run = symbol >> 4;
              const size = symbol & 0x0f;
              if (size === 0) {
                if (run === 15) { index += 16; continue; }
                break; // EOB
              }
              index += run;
              if (index >= 64) return null;
              coefficients[ZIGZAG[index]!] = extend(reader.bits(size), size);
              index += 1;
            }
            // The DC coefficient sits at natural index 0 either way; AC values
            // above were stored via ZIGZAG into natural order — but index 0 of
            // ZIGZAG is 0, so overwrite with the running DC prediction.
            coefficients[0] = component.pred;

            // Dequantize (natural order) then inverse DCT: S = Mᵀ · C · M.
            for (let i = 0; i < 64; i += 1) block[i] = coefficients[i]! * quant[i]!;
            for (let x = 0; x < 8; x += 1) {
              for (let yRow = 0; yRow < 8; yRow += 1) {
                let sum = 0;
                for (let v = 0; v < 8; v += 1) sum += DCT_MATRIX[v * 8 + yRow]! * block[v * 8 + x]!;
                temp[yRow * 8 + x] = sum;
              }
            }
            const plane = component.plane!;
            const planeWidth = component.planeWidth!;
            const originX = (mcuX * component.h + blockH) * 8;
            const originY = (mcuY * component.v + blockV) * 8;
            for (let yRow = 0; yRow < 8; yRow += 1) {
              for (let x = 0; x < 8; x += 1) {
                let sum = 0;
                for (let u = 0; u < 8; u += 1) sum += DCT_MATRIX[u * 8 + x]! * temp[yRow * 8 + u]!;
                const sample = Math.round(sum) + 128;
                plane[(originY + yRow) * planeWidth + originX + x] =
                  sample < 0 ? 0 : sample > 255 ? 255 : sample;
              }
            }
          }
        }
      }
      mcusSinceRestart += 1;
    }
  }

  // Assemble RGBA with per-component nearest-neighbor upsampling.
  const pixels = new Uint8Array(width * height * 4);
  const [luma, cb, cr] = [components[0], components[1], components[2]];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dst = (y * width + x) * 4;
      const sample = (component: FrameComponent): number => {
        const sx = Math.floor((x * component.h) / hMax);
        const sy = Math.floor((y * component.v) / vMax);
        return component.plane![sy * component.planeWidth! + sx]!;
      };
      if (components.length === 1) {
        const value = sample(luma!);
        pixels[dst] = value; pixels[dst + 1] = value; pixels[dst + 2] = value;
      } else {
        const Y = sample(luma!);
        const Cb = sample(cb!) - 128;
        const Cr = sample(cr!) - 128;
        const r = Y + 1.402 * Cr;
        const g = Y - 0.344136 * Cb - 0.714136 * Cr;
        const b = Y + 1.772 * Cb;
        pixels[dst] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
        pixels[dst + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
        pixels[dst + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
      }
      pixels[dst + 3] = 255;
    }
  }
  return { pixels, width, height, hasAlpha: false };
}
