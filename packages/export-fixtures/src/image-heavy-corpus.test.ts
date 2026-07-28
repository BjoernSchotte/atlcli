import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import {
  generateImageHeavyCorpus,
  IMAGE_HEAVY_CORPUS_SCHEMA,
  IMAGE_HEAVY_MIN_AGGREGATE_BYTES,
  resolveImageHeavyAsset,
  sha256Hex,
  type ImageHeavyCorpus,
} from "./image-heavy-corpus.js";

// Small scale keeps the unit suite fast while exercising every encoder code
// path; the full-scale (scale=1, >=100 MiB) proof is env-gated below.
const TEST_SCALE = 0.06;

let cachedCorpus: ImageHeavyCorpus | undefined;
function corpus(): ImageHeavyCorpus {
  cachedCorpus ??= generateImageHeavyCorpus({ scale: TEST_SCALE });
  return cachedCorpus;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
  );
}

/** Extract IHDR facts and the concatenated zlib IDAT stream from a PNG. */
function parsePng(bytes: Uint8Array): {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  idat: Uint8Array;
} {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  signature.forEach((byte, index) => expect(bytes[index]).toBe(byte));
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatParts: Uint8Array[] = [];
  while (offset < bytes.byteLength) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!
    );
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === "IDAT") {
      idatParts.push(data);
    }
    offset += 12 + length;
  }
  const idat = new Uint8Array(idatParts.reduce((total, part) => total + part.byteLength, 0));
  let idatOffset = 0;
  for (const part of idatParts) {
    idat.set(part, idatOffset);
    idatOffset += part.byteLength;
  }
  return { width, height, bitDepth, colorType, idat };
}

describe("image-heavy corpus (issue #118 Phase 0)", () => {
  it("is deterministic for a fixed seed and scale, and seed-sensitive", () => {
    const again = generateImageHeavyCorpus({ scale: TEST_SCALE });
    expect(again.manifestSha256).toBe(corpus().manifestSha256);
    expect(again.manifest).toEqual(corpus().manifest);
    const reseeded = generateImageHeavyCorpus({ scale: TEST_SCALE, seed: 0xdead_beef });
    expect(reseeded.manifestSha256).not.toBe(corpus().manifestSha256);
  });

  it("reproduces the pinned recipe hash (encoder or content drift is a recipe change)", () => {
    // Pinned on Bun 1.3.14 / macOS arm64; the generator uses only
    // engine-independent integer and IEEE-754 float arithmetic, so this hash
    // must hold on every platform. If an intentional content or encoder
    // change moves it, update the pin AND bump the corpus schema version.
    expect(corpus().manifestSha256).toBe(
      "db93075b0a2e2d4aa6a8493fade9884bd0cc010fbb07d946647638a4270b161c"
    );
  });

  it("verifies its pure SHA-256 against node:crypto", () => {
    for (const asset of corpus().assets.slice(0, 3)) {
      const expected = createHash("sha256").update(asset.bytes).digest("hex");
      expect(asset.sha256).toBe(expected);
      expect(sha256Hex(asset.bytes)).toBe(expected);
    }
  });

  it("produces spec-valid DEFLATE streams: every PNG inflates to its exact raw size", () => {
    for (const asset of corpus().assets.filter((entry) => entry.mediaType === "image/png")) {
      const png = parsePng(asset.bytes);
      expect(png.width).toBe(asset.width);
      expect(png.height).toBe(asset.height);
      expect(png.bitDepth).toBe(8);
      expect(png.colorType).toBe(asset.alpha ? 6 : 2);
      const channels = asset.alpha ? 4 : 3;
      const inflated = inflateSync(png.idat);
      expect(inflated.byteLength).toBe(asset.height * (1 + asset.width * channels));
    }
  });

  it("produces structurally valid baseline JFIF JPEGs with matching dimensions", () => {
    for (const asset of corpus().assets.filter((entry) => entry.mediaType === "image/jpeg")) {
      const bytes = asset.bytes;
      expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]); // SOI
      expect([bytes[2], bytes[3]]).toEqual([0xff, 0xe0]); // JFIF APP0
      expect([bytes[bytes.byteLength - 2], bytes[bytes.byteLength - 1]]).toEqual([0xff, 0xd9]);
      // Find SOF0 and check dimensions.
      let offset = 2;
      let sofFound = false;
      while (offset + 4 <= bytes.byteLength) {
        if (bytes[offset] !== 0xff) break;
        const id = bytes[offset + 1]!;
        if (id === 0xda) break; // SOS: entropy data follows
        const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
        if (id === 0xc0) {
          const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
          const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
          expect(height).toBe(asset.height);
          expect(width).toBe(asset.width);
          expect(bytes[offset + 9]).toBe(3); // components
          sofFound = true;
        }
        offset += 2 + length;
      }
      expect(sofFound).toBe(true);
    }
  });

  it("compresses like real pages, not like noise", () => {
    for (const asset of corpus().manifest) {
      const rawBytes = asset.width * asset.height * (asset.alpha ? 4 : 3);
      const ratio = asset.byteLength / rawBytes;
      if (asset.mediaType === "image/jpeg") {
        // Photographic JPEG: clearly compressed, clearly not degenerate.
        const bytesPerPixel = asset.byteLength / (asset.width * asset.height);
        expect(bytesPerPixel).toBeGreaterThan(0.05);
        expect(bytesPerPixel).toBeLessThan(3);
      } else if (asset.role === "screenshot") {
        // Flat UI content must compress hard even with fixed-Huffman DEFLATE.
        expect(ratio).toBeLessThan(0.4);
      } else {
        expect(ratio).toBeLessThan(0.75);
      }
    }
  });

  it("covers transparency, repeats, inline, and full-width placements", () => {
    const value = corpus();
    expect(value.counts.alphaAssets).toBeGreaterThan(0);
    expect(value.counts.inlinePlacements).toBeGreaterThan(0);
    expect(value.counts.fullWidthPlacements).toBeGreaterThan(0);
    // The logo repeats in every chapter: dedup pressure by construction.
    expect(value.counts.logoPlacements).toBe(value.counts.chapters);
    expect(value.counts.placements).toBeGreaterThan(value.counts.uniqueAssets);
    const logo = value.manifest.find((entry) => entry.role === "logo");
    expect(logo?.placements).toBe(value.counts.chapters);
  });

  it("places every asset at least once and resolves every placed filename", () => {
    const value = corpus();
    for (const entry of value.manifest) {
      expect(entry.placements).toBeGreaterThan(0);
      const resolved = resolveImageHeavyAsset(value, entry.filename);
      expect(resolved.mediaType).toBe(entry.mediaType);
      expect(resolved.bytes.byteLength).toBe(entry.byteLength);
    }
    expect(() => resolveImageHeavyAsset(value, "missing.png")).toThrow(
      "Unknown image-heavy corpus asset: missing.png"
    );
  });

  it("meets the scale-adjusted aggregate minimum and keeps assets under the per-file cap", () => {
    const value = corpus();
    expect(value.schema).toBe(IMAGE_HEAVY_CORPUS_SCHEMA);
    expect(value.counts.uniqueAssetBytes).toBeGreaterThanOrEqual(value.minAggregateBytes);
    expect(value.counts.uniqueAssetBytes).toBe(
      value.manifest.reduce((total, entry) => total + entry.byteLength, 0)
    );
    for (const entry of value.manifest) {
      expect(entry.byteLength).toBeLessThan(25 * 1024 * 1024);
    }
  });

  it("rejects an out-of-range scale", () => {
    expect(() => generateImageHeavyCorpus({ scale: 0 })).toThrow();
    expect(() => generateImageHeavyCorpus({ scale: 1.5 })).toThrow();
  });
});

// Full-scale proof (>=100 MiB, ~tens of seconds): run explicitly with
//   ATLCLI_IMAGE_HEAVY_FULL=1 bun run test packages/export-fixtures/src/image-heavy-corpus.test.ts
describe.if(process.env.ATLCLI_IMAGE_HEAVY_FULL === "1")("image-heavy corpus at scale 1", () => {
  it("aggregates at least 100 MiB of unique compressed media", () => {
    const full = generateImageHeavyCorpus();
    expect(full.counts.uniqueAssetBytes).toBeGreaterThanOrEqual(IMAGE_HEAVY_MIN_AGGREGATE_BYTES);
    for (const entry of full.manifest) {
      expect(entry.byteLength).toBeLessThan(25 * 1024 * 1024);
    }
    console.log(
      `ATLCLI_IMAGE_HEAVY_CORPUS manifestSha256=${full.manifestSha256} ` +
        `assets=${full.counts.uniqueAssets} bytes=${full.counts.uniqueAssetBytes}`
    );
  }, 600_000);
});
