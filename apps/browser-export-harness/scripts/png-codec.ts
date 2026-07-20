/**
 * A minimal, REAL PNG codec (encode + decode) used by the shape-parity raster
 * check. No image library, no mock — it round-trips genuine PNG bytes through
 * `node:zlib` DEFLATE/INFLATE and the standard PNG scanline filters, so the
 * parity tests operate on real pixels the same way a browser canvas or resvg
 * would produce them.
 *
 * Scope: 8-bit, non-interlaced, colour type 2 (RGB) and 6 (RGBA). That covers
 * every media part the DOCX/PDF engines emit (canvas / resvg PNG output).
 * Anything outside that scope throws — a parity run must never silently accept
 * an image it could not actually decode.
 */
import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface DecodedImage {
  width: number;
  height: number;
  /** Whether the source PNG carried a real alpha channel (colour type 6). */
  hasAlpha: boolean;
  /** Tightly packed RGBA, 4 bytes per pixel, row-major. */
  rgba: Uint8Array;
}

// --- CRC32 (PNG polynomial) -------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

// --- encode -----------------------------------------------------------------

/** PNG scanline filter types (0=None, 1=Sub, 2=Up, 3=Average, 4=Paeth). */
export type PngFilterType = 0 | 1 | 2 | 3 | 4;

const RGBA_BPP = 4;

/**
 * Apply a single PNG scanline filter to one row (encode direction). `prev` is
 * the RAW (unfiltered) previous scanline. This is the exact inverse of the
 * reconstruction in `decodePng`, so a filtered→decoded round-trip proves BOTH
 * directions of every filter branch.
 */
function applyFilter(
  filter: PngFilterType,
  cur: Uint8Array,
  prev: Uint8Array,
  out: Uint8Array,
): void {
  for (let x = 0; x < cur.length; x++) {
    const a = x >= RGBA_BPP ? cur[x - RGBA_BPP] : 0;
    const b = prev[x];
    const c = x >= RGBA_BPP ? prev[x - RGBA_BPP] : 0;
    let value: number;
    switch (filter) {
      case 0:
        value = cur[x];
        break;
      case 1:
        value = cur[x] - a;
        break;
      case 2:
        value = cur[x] - b;
        break;
      case 3:
        value = cur[x] - ((a + b) >> 1);
        break;
      case 4:
        value = cur[x] - paeth(a, b, c);
        break;
    }
    out[x] = value & 0xff;
  }
}

/**
 * Encode packed RGBA into a real colour-type-6 PNG, forcing `filter` on every
 * scanline. `encodeRgbaPng` is the filter-0 shorthand. The forced-filter form
 * exists so tests can drive the Sub/Up/Average/Paeth decode branches that real
 * canvas/resvg output uses — otherwise those branches would be dead-tested.
 */
export function encodeRgbaPngWithFilter(
  width: number,
  height: number,
  rgba: Uint8Array,
  filter: PngFilterType,
): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodeRgbaPngWithFilter: expected ${width * height * 4} RGBA bytes, got ${rgba.length}.`);
  }
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  const prev = new Uint8Array(stride); // raw previous scanline (zero for row 0)
  for (let y = 0; y < height; y++) {
    const cur = rgba.subarray(y * stride, y * stride + stride);
    raw[y * (stride + 1)] = filter;
    const filtered = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    applyFilter(filter, cur, prev, filtered);
    prev.set(cur);
  }
  const idat = new Uint8Array(deflateSync(raw));

  return assemblePng(width, height, idat);
}

/** Encode packed RGBA pixels (4 bytes/pixel) into a real colour-type-6 PNG. */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodeRgbaPng: expected ${width * height * 4} RGBA bytes, got ${rgba.length}.`);
  }
  const stride = width * 4;
  // Filter type 0 (none) on every scanline — deterministic and trivially decodable.
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const idat = new Uint8Array(deflateSync(raw));

  return assemblePng(width, height, idat);
}

function assemblePng(width: number, height: number, idat: Uint8Array): Uint8Array {

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const parts = [PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// --- decode -----------------------------------------------------------------

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a colour-type 2/6, 8-bit, non-interlaced PNG into packed RGBA.
 *
 * Chunk CRC-32s are intentionally NOT validated on decode: this codec only ever
 * decodes bytes produced by our own engines / pinned rasterizers (trusted
 * input), so a CRC check would add cost without catching a real failure mode —
 * a corrupt IDAT surfaces as an inflate error instead.
 */
export function decodePng(bytes: Uint8Array): DecodedImage {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("decodePng: not a PNG (bad signature).");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  const idatParts: Uint8Array[] = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const bitDepth = bytes[offset + 16];
      colourType = bytes[offset + 17];
      const interlace = bytes[offset + 20];
      if (bitDepth !== 8) throw new Error(`decodePng: unsupported bit depth ${bitDepth}.`);
      if (colourType !== 2 && colourType !== 6) {
        throw new Error(`decodePng: unsupported colour type ${colourType} (only RGB/RGBA).`);
      }
      if (interlace !== 0) throw new Error("decodePng: interlaced PNGs are unsupported.");
    } else if (type === "IDAT") {
      idatParts.push(data.slice());
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error("decodePng: missing or zero-sized IHDR.");

  const channels = colourType === 6 ? 4 : 3;
  const compressed = new Uint8Array(idatParts.reduce((n, p) => n + p.length, 0));
  let cOffset = 0;
  for (const part of idatParts) {
    compressed.set(part, cOffset);
    cOffset += part.length;
  }
  const raw = new Uint8Array(inflateSync(compressed));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawOffset++];
    for (let x = 0; x < stride; x++) {
      const value = raw[rawOffset++];
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let recon: number;
      switch (filter) {
        case 0:
          recon = value;
          break;
        case 1:
          recon = value + a;
          break;
        case 2:
          recon = value + b;
          break;
        case 3:
          recon = value + ((a + b) >> 1);
          break;
        case 4:
          recon = value + paeth(a, b, c);
          break;
        default:
          throw new Error(`decodePng: unknown scanline filter ${filter}.`);
      }
      cur[x] = recon & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      rgba[dst] = cur[src];
      rgba[dst + 1] = cur[src + 1];
      rgba[dst + 2] = cur[src + 2];
      rgba[dst + 3] = channels === 4 ? cur[src + 3] : 255;
    }
    prev.set(cur);
  }
  return { width, height, hasAlpha: colourType === 6, rgba };
}
