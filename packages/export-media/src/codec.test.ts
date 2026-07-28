import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { adler32, concat, crc32, writeUint32 } from "./bytes.js";
import { decodeJpegRaster } from "./decode-jpeg.js";
import { decodePngRaster, inflateZlib } from "./decode-png.js";
import { encodeJpeg } from "./encode-jpeg.js";
import { encodePng } from "./encode-png.js";
import { normalizeRasterAssetV1 } from "./normalize.js";
import {
  ExportImageQualityError,
  resolveEffectivePpi,
  PRINT_PROFILE_PPI,
  STANDARD_PROFILE_PPI,
} from "./profile.js";
import { boxResampleRgba } from "./resample.js";
import { sha256Hex } from "./sha256.js";

/**
 * REAL-WORLD cross-validation fixtures (committed binaries, ~1.4 KiB total):
 * the same 16x12 photographic crop written by macOS ImageIO as a PNG
 * (dynamic-Huffman zlib stream) and as a 4:2:0 JPEG. The PNG decode is the
 * pixel reference; the JPEG decode must agree within JPEG-quality tolerance.
 * This proves the decoders against an INDEPENDENT encoder, not just our own.
 */
const REAL_PNG = new Uint8Array(
  readFileSync(fileURLToPath(new URL("./__fixtures__/real-imageio-16x12.png", import.meta.url))),
);
const REAL_JPEG_420 = new Uint8Array(
  readFileSync(fileURLToPath(new URL("./__fixtures__/real-imageio-16x12-420.jpg", import.meta.url))),
);



function gradientRgba(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      pixels[i] = Math.floor((x * 255) / (width - 1));
      pixels[i + 1] = Math.floor((y * 255) / (height - 1));
      pixels[i + 2] = Math.floor(((x + y) * 255) / (width + height - 2));
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

function rgb(pixels: Uint8Array): Uint8Array {
  const out = new Uint8Array((pixels.byteLength / 4) * 3);
  for (let i = 0, s = 0, d = 0; i < pixels.byteLength / 4; i += 1, s += 4, d += 3) {
    out[d] = pixels[s]!; out[d + 1] = pixels[s + 1]!; out[d + 2] = pixels[s + 2]!;
  }
  return out;
}

function meanAbsError(a: Uint8Array, b: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < a.byteLength; i += 1) total += Math.abs(a[i]! - b[i]!);
  return total / a.byteLength;
}

describe("inflate (RFC 1951) against node:zlib", () => {
  it("inflates dynamic-Huffman, fixed, and stored streams byte-exactly", async () => {
    const repetitive = new TextEncoder().encode("atlcli ".repeat(4000));
    let noiseState = 7;
    const noisy = Uint8Array.from({ length: 32_768 }, () => {
      noiseState = (Math.imul(noiseState, 1_664_525) + 1_013_904_223) >>> 0;
      return noiseState & 0xff;
    });
    for (const [payload, level] of [
      [repetitive, 9],
      [noisy, 6],
      [repetitive, 1],
      [noisy, 0],
    ] as Array<[Uint8Array, number]>) {
      const compressed = new Uint8Array(deflateSync(payload, { level }));
      const out = new Uint8Array(payload.byteLength);
      const written = inflateZlib(compressed, out);
      expect(written).toBe(payload.byteLength);
      expect(sha256Hex(out)).toBe(sha256Hex(payload));
    }
  });
});

describe("PNG decode", () => {
  it("round-trips our own encoder exactly (RGB and RGBA)", () => {
    const pixels = gradientRgba(21, 13);
    const rgba = decodePngRaster(encodePng(pixels, 21, 13, true))!;
    expect(rgba.width).toBe(21);
    expect(rgba.hasAlpha).toBe(false); // gradient is fully opaque
    expect(sha256Hex(rgba.pixels)).toBe(sha256Hex(pixels));

    const rgbOnly = decodePngRaster(encodePng(rgb(pixels), 21, 13, false))!;
    expect(sha256Hex(rgbOnly.pixels)).toBe(sha256Hex(pixels));
  });

  it("decodes every PNG filter type from an independent zlib stream", () => {
    // Build a 4x5 RGB image, filter each row with a DIFFERENT filter type,
    // compress with node:zlib, wrap as a PNG, and require exact pixels back.
    const width = 4;
    const height = 5;
    const channels = 3;
    const pixels = rgb(gradientRgba(width, height));
    const stride = width * channels;
    const raw = new Uint8Array(height * (1 + stride));
    const paeth = (a: number, b: number, c: number): number => {
      const p = a + b - c;
      const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    for (let y = 0; y < height; y += 1) {
      const filter = y % 5;
      raw[y * (1 + stride)] = filter;
      for (let x = 0; x < stride; x += 1) {
        const value = pixels[y * stride + x]!;
        const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
        const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
        const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels]! : 0;
        const predicted =
          filter === 0 ? 0
          : filter === 1 ? left
          : filter === 2 ? up
          : filter === 3 ? (left + up) >> 1
          : paeth(left, up, upLeft);
        raw[y * (1 + stride) + 1 + x] = (value - predicted) & 0xff;
      }
    }
    const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
    const chunk = (type: string, data: Uint8Array): Uint8Array => {
      const typeBytes = Uint8Array.from(type, (c) => c.charCodeAt(0));
      const out = new Uint8Array(12 + data.byteLength);
      writeUint32(out, 0, data.byteLength);
      out.set(typeBytes, 4);
      out.set(data, 8);
      writeUint32(out, 8 + data.byteLength, crc32([typeBytes, data]));
      return out;
    };
    const header = new Uint8Array(13);
    writeUint32(header, 0, width);
    writeUint32(header, 4, height);
    header.set([8, 2, 0, 0, 0], 8);
    const png = concat([
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", idat),
      chunk("IEND", new Uint8Array()),
    ]);
    const decoded = decodePngRaster(png)!;
    expect(decoded).not.toBeNull();
    expect(sha256Hex(rgb(decoded.pixels))).toBe(sha256Hex(pixels));
  });

  it("decodes a real ImageIO-written PNG (dynamic Huffman, real filters)", () => {
    const decoded = decodePngRaster(REAL_PNG)!;
    expect(decoded).not.toBeNull();
    expect(decoded.width).toBe(16);
    expect(decoded.height).toBe(12);
    expect(decoded.hasAlpha).toBe(false);
  });

  it("keeps palette + tRNS alpha intact", () => {
    const chunkOf = (type: string, data: Uint8Array): Uint8Array => {
      const typeBytes = Uint8Array.from(type, (c) => c.charCodeAt(0));
      const out = new Uint8Array(12 + data.byteLength);
      writeUint32(out, 0, data.byteLength);
      out.set(typeBytes, 4);
      out.set(data, 8);
      writeUint32(out, 8 + data.byteLength, crc32([typeBytes, data]));
      return out;
    };
    const header = new Uint8Array(13);
    writeUint32(header, 0, 2);
    writeUint32(header, 4, 1);
    header.set([8, 3, 0, 0, 0], 8); // 8-bit palette
    const raw = Uint8Array.from([0, 0, 1]); // filter none, indices 0 and 1
    const png = concat([
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunkOf("IHDR", header),
      chunkOf("PLTE", Uint8Array.from([255, 0, 0, 0, 0, 255])),
      chunkOf("tRNS", Uint8Array.from([128])), // index 0 half-transparent
      chunkOf("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
      chunkOf("IEND", new Uint8Array()),
    ]);
    const decoded = decodePngRaster(png)!;
    expect([...decoded.pixels]).toEqual([255, 0, 0, 128, 0, 0, 255, 255]);
    expect(decoded.hasAlpha).toBe(true);
  });

  it("returns null for 16-bit and interlaced PNGs instead of guessing", () => {
    const png = encodePng(gradientRgba(8, 8), 8, 8, true);
    const sixteen = Uint8Array.from(png);
    sixteen[24] = 16; // IHDR bit depth
    expect(decodePngRaster(sixteen)).toBeNull();
    const interlaced = Uint8Array.from(png);
    interlaced[28] = 1; // IHDR interlace
    expect(decodePngRaster(interlaced)).toBeNull();
  });
});

describe("JPEG decode", () => {
  it("round-trips our own 4:4:4 encoder within JPEG tolerance, deterministically", () => {
    const pixels = gradientRgba(32, 24);
    const encoded = encodeJpeg(rgb(pixels), 32, 24, 90);
    const decoded = decodeJpegRaster(encoded)!;
    expect(decoded).not.toBeNull();
    expect(decoded.width).toBe(32);
    expect(decoded.height).toBe(24);
    expect(meanAbsError(rgb(decoded.pixels), rgb(pixels))).toBeLessThan(4);
    const again = decodeJpegRaster(encoded)!;
    expect(sha256Hex(again.pixels)).toBe(sha256Hex(decoded.pixels));
  });

  it("decodes a real ImageIO 4:2:0 JPEG and agrees with the PNG reference", () => {
    const reference = decodePngRaster(REAL_PNG)!;
    const decoded = decodeJpegRaster(REAL_JPEG_420)!;
    expect(decoded).not.toBeNull();
    expect(decoded.width).toBe(16);
    expect(decoded.height).toBe(12);
    // Same crop, q70 4:2:0 versus lossless: generous but bounded tolerance.
    expect(meanAbsError(rgb(decoded.pixels), rgb(reference.pixels))).toBeLessThan(14);
  });

  it("returns null for progressive frames instead of guessing", () => {
    const encoded = encodeJpeg(rgb(gradientRgba(16, 16)), 16, 16, 90);
    const progressive = Uint8Array.from(encoded);
    // Rewrite the SOF0 marker (FF C0) to SOF2 (progressive).
    for (let i = 2; i + 1 < progressive.byteLength; i += 1) {
      if (progressive[i] === 0xff && progressive[i + 1] === 0xc0) {
        progressive[i + 1] = 0xc2;
        break;
      }
    }
    expect(decodeJpegRaster(progressive)).toBeNull();
  });
});

describe("box resample", () => {
  it("averages exact areas", () => {
    const src = Uint8Array.from([
      10, 20, 30, 255, 30, 40, 50, 255,
      50, 60, 70, 255, 70, 80, 90, 255,
    ]);
    const out = boxResampleRgba(src, 2, 2, 1, 1);
    expect([...out]).toEqual([40, 50, 60, 255]);
  });

  it("does not bleed transparent RGB into opaque neighbors", () => {
    const src = Uint8Array.from([
      255, 0, 0, 0, /* fully transparent red */ 0, 0, 255, 255,
    ]);
    const out = boxResampleRgba(src, 2, 1, 1, 1);
    expect(out[3]).toBe(128); // half coverage
    expect(out[0]).toBe(0); // premultiplied: no red bleed
    expect(out[2]).toBe(255);
  });
});

describe("profiles", () => {
  it("resolves preset and override PPIs and rejects invalid combinations", () => {
    expect(resolveEffectivePpi({ imageProfile: "original" })).toBeNull();
    expect(resolveEffectivePpi({ imageProfile: "standard" })).toBe(STANDARD_PROFILE_PPI);
    expect(resolveEffectivePpi({ imageProfile: "print" })).toBe(PRINT_PROFILE_PPI);
    expect(resolveEffectivePpi({ imageProfile: "standard", imagePpi: 240 })).toBe(240);
    expect(() => resolveEffectivePpi({ imageProfile: "original", imagePpi: 240 }))
      .toThrow(ExportImageQualityError);
    expect(() => resolveEffectivePpi({ imageProfile: "standard", imagePpi: 30 }))
      .toThrow("must be an integer");
    expect(() => resolveEffectivePpi({ imageProfile: "standard", imagePpi: 2400 }))
      .toThrow("must be an integer");
  });
});

describe("normalizeRasterAssetV1", () => {
  const envelope = { renderEnvelopeWidthPt: 470, ppi: 180 } as const;

  it("downscales a large JPEG, keeps it JPEG, and is deterministic", () => {
    const source = encodeJpeg(rgb(gradientRgba(1600, 1200)), 1600, 1200, 90);
    const result = normalizeRasterAssetV1({
      bytes: source,
      mediaType: "image/jpeg",
      ...envelope,
    });
    if (result.kind !== "normalized") throw new Error(`kept: ${JSON.stringify(result)}`);
    // 470pt = 6.527in ⇒ ceil(6.527 × 180) = 1176 ⇒ padded to /8 = 1176.
    expect(result.mediaType).toBe("image/jpeg");
    expect(result.width).toBe(1176);
    expect(result.bytes.byteLength).toBeLessThan(source.byteLength);
    expect(decodeJpegRaster(result.bytes)).not.toBeNull();
    const again = normalizeRasterAssetV1({ bytes: source, mediaType: "image/jpeg", ...envelope });
    if (again.kind !== "normalized") throw new Error("expected normalized");
    expect(sha256Hex(again.bytes)).toBe(sha256Hex(result.bytes));
  });

  it("keeps transparency lossless: alpha PNG stays PNG with alpha", () => {
    const width = 1400;
    const height = 700;
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      pixels[i * 4] = 40; pixels[i * 4 + 1] = 90; pixels[i * 4 + 2] = 200;
      pixels[i * 4 + 3] = i % 3 === 0 ? 0 : 255;
    }
    const source = encodePng(pixels, width, height, true);
    const result = normalizeRasterAssetV1({ bytes: source, mediaType: "image/png", ...envelope });
    if (result.kind !== "normalized") throw new Error(`kept: ${JSON.stringify(result)}`);
    expect(result.mediaType).toBe("image/png");
    const decoded = decodePngRaster(result.bytes)!;
    expect(decoded.hasAlpha).toBe(true);
    expect(decoded.width).toBe(result.width);
  });

  it("never upscales and skips sub-2% downscales", () => {
    const small = encodePng(rgb(gradientRgba(200, 100)), 200, 100, false);
    expect(normalizeRasterAssetV1({ bytes: small, mediaType: "image/png", ...envelope }))
      .toEqual({ kind: "kept", reason: "no-downscale" });
  });

  it("keeps SVG, GIF, and undecodable bytes untouched with a stated reason", () => {
    const svg = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"/>`);
    expect(normalizeRasterAssetV1({ bytes: svg, mediaType: "image/svg+xml", ...envelope }))
      .toEqual({ kind: "kept", reason: "not-raster" });
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 4, 0, 4, 0, 0, 0, 0]);
    expect(normalizeRasterAssetV1({ bytes: gif, mediaType: "image/gif", ...envelope }))
      .toEqual({ kind: "kept", reason: "not-raster" });
    const corruptPng = encodePng(rgb(gradientRgba(1600, 8)), 1600, 8, false);
    corruptPng.fill(0, 64, 128); // damage the IDAT stream
    expect(normalizeRasterAssetV1({ bytes: corruptPng, mediaType: "image/png", ...envelope }))
      .toMatchObject({ kind: "kept" });
  });

  it("honors an authored width below the envelope", () => {
    const source = encodeJpeg(rgb(gradientRgba(1600, 800)), 1600, 800, 90);
    const result = normalizeRasterAssetV1({
      bytes: source,
      mediaType: "image/jpeg",
      renderEnvelopeWidthPt: 470,
      ppi: 180,
      authored: { widthPx: 300 }, // 300 css-px = 3.125in ⇒ 563px target
    });
    if (result.kind !== "normalized") throw new Error("expected normalized");
    expect(result.width).toBe(568); // ceil(3.125×180)=563 → padded to /8
  });

  it("accepts a re-encode that is not byte-smaller: fewer pixels is the goal", () => {
    // Observed live (issue #118 Phase 3 CLI proof): a small, well-compressed
    // source can grow slightly under the pinned fixed-Huffman encoder. The
    // profile optimizes decoded pixel area (peak memory), not file size, so
    // the downscale is still taken — this pins that trade-off as intended.
    const source = encodePng(rgb(gradientRgba(400, 200)), 400, 200, false);
    const result = normalizeRasterAssetV1({
      bytes: source,
      mediaType: "image/png",
      renderEnvelopeWidthPt: 470,
      ppi: 72,
      authored: { widthPx: 300 }, // 300 css-px = 3.125in ⇒ ceil(3.125 × 72) = 225px target
    });
    if (result.kind !== "normalized") throw new Error(`kept: ${JSON.stringify(result)}`);
    expect(result.width).toBe(225);
    expect(result.width * result.height).toBeLessThan(400 * 200);
  });

  it("adler32/crc32 fixtures stay pinned (zlib interop guards)", () => {
    const payload = new TextEncoder().encode("atlcli");
    expect(adler32(payload)).toBe(0x08aa027a);
    expect(crc32([payload])).toBe(0xb87ffbc6);
  });
});
