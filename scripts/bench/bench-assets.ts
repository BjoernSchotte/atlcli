/**
 * Deterministic in-memory asset port for the benchmark runners (spec 011).
 *
 * The bench fixtures reference `bench-asset-<n>.png` attachments. Rather than
 * hitting a tenant (which would make the benchmark non-deterministic and
 * network-bound), the runners resolve them from a seeded, REAL PNG encoder —
 * genuine signature/IHDR/IDAT/IEND bytes through `node:zlib`, not a stub
 * header. That matters: a header-only "PNG" would be rejected downstream and
 * the image-embedding cost would silently drop out of the measured envelope.
 *
 * Same filename → same bytes, always, so two runs of the same fixture embed
 * byte-identical media and the outputs stay comparable.
 */
import { deflateSync } from "node:zlib";
import type { AssetFetcher, AssetRef } from "@atlcli/docx";
import type { PdfAssetRef, PdfAssetResolver, PdfResolvedAsset } from "@atlcli/pdf";

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode tightly packed RGBA as a real, non-interlaced 8-bit colour-type-6 PNG. */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None) — deterministic, no prediction
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const idat = new Uint8Array(deflateSync(raw, { level: 6 }));
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

/**
 * A small deterministic figure keyed by filename: a 64x48 gradient whose hue
 * is derived from a hash of the name, so different attachments differ in bytes
 * (realistic compression behaviour) while any one attachment is stable.
 */
export function benchPngFor(filename: string): Uint8Array {
  let hash = 0x811c9dc5;
  for (let i = 0; i < filename.length; i++) {
    hash ^= filename.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const width = 64;
  const height = 48;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = (x * 4 + (hash & 0xff)) & 0xff;
      rgba[i + 1] = (y * 5 + ((hash >>> 8) & 0xff)) & 0xff;
      rgba[i + 2] = ((x ^ y) + ((hash >>> 16) & 0xff)) & 0xff;
      rgba[i + 3] = 0xff;
    }
  }
  return encodeRgbaPng(width, height, rgba);
}

/** DOCX-side asset port over the deterministic bench figures. */
export const benchDocxAssets: AssetFetcher = {
  async fetch(ref: AssetRef): Promise<Uint8Array> {
    if (!ref.filename) throw new Error(`bench asset port: ref without a filename (${JSON.stringify(ref)})`);
    return benchPngFor(ref.filename);
  },
};

/** PDF-side asset port over the same deterministic bench figures. */
export const benchPdfAssets: PdfAssetResolver = {
  async resolve(ref: PdfAssetRef): Promise<PdfResolvedAsset> {
    if (!ref.filename) throw new Error(`bench asset port: ref without a filename (${JSON.stringify(ref)})`);
    return { bytes: benchPngFor(ref.filename), mediaType: "image/png", filename: ref.filename };
  },
};
