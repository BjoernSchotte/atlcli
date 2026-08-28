import { describe, expect, test } from "bun:test";
import { concat, crc32, writeUint32 } from "./bytes.js";
import { encodeJpeg } from "./encode-jpeg.js";
import { encodePng } from "./encode-png.js";
import { classifyImageBitmapEligibilityV1 } from "./image-bitmap-eligibility.js";

const encoder = new TextEncoder();

function pngChunk(name: string, data: Uint8Array): Uint8Array {
  const type = encoder.encode(name);
  const chunk = new Uint8Array(12 + data.byteLength);
  writeUint32(chunk, 0, data.byteLength);
  chunk.set(type, 4);
  chunk.set(data, 8);
  writeUint32(chunk, 8 + data.byteLength, crc32([type, data]));
  return chunk;
}

function insertPngBeforeIdat(bytes: Uint8Array, chunk: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    if (
      bytes[offset + 4] === 0x49
      && bytes[offset + 5] === 0x44
      && bytes[offset + 6] === 0x41
      && bytes[offset + 7] === 0x54
    ) {
      return concat([bytes.subarray(0, offset), chunk, bytes.subarray(offset)]);
    }
    offset += 12 + view.getUint32(offset);
  }
  throw new Error("PNG fixture has no IDAT chunk.");
}

function exifTiff(orientation: number): Uint8Array {
  const out = new Uint8Array(26);
  const view = new DataView(out.buffer);
  out[0] = 0x49;
  out[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, 0x0112, true);
  view.setUint16(12, 3, true);
  view.setUint32(14, 1, true);
  view.setUint16(18, orientation, true);
  view.setUint32(22, 0, true);
  return out;
}

function jpegSegment(marker: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + data.byteLength);
  out[0] = 0xff;
  out[1] = marker;
  new DataView(out.buffer).setUint16(2, data.byteLength + 2);
  out.set(data, 4);
  return out;
}

function jpegHeader(input: {
  components: Array<{ id: number; sampling: number }>;
  sof?: number;
  app?: Uint8Array[];
}): Uint8Array {
  const frame = new Uint8Array(6 + input.components.length * 3);
  const frameView = new DataView(frame.buffer);
  frame[0] = 8;
  frameView.setUint16(1, 24);
  frameView.setUint16(3, 32);
  frame[5] = input.components.length;
  input.components.forEach((component, index) => {
    frame[6 + index * 3] = component.id;
    frame[7 + index * 3] = component.sampling;
    frame[8 + index * 3] = index === 0 ? 0 : 1;
  });
  const scan = new Uint8Array(4 + input.components.length * 2);
  scan[0] = input.components.length;
  input.components.forEach((component, index) => {
    scan[1 + index * 2] = component.id;
    scan[2 + index * 2] = index === 0 ? 0 : 0x11;
  });
  const spectral = 1 + input.components.length * 2;
  scan[spectral] = 0;
  scan[spectral + 1] = 63;
  scan[spectral + 2] = 0;
  const jfif = jpegSegment(0xe0, new Uint8Array([
    0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  ]));
  return concat([
    new Uint8Array([0xff, 0xd8]),
    jfif,
    ...(input.app ?? []),
    jpegSegment(input.sof ?? 0xc0, frame),
    jpegSegment(0xda, scan),
    new Uint8Array([0xff, 0xd9]),
  ]);
}

function jpegExif(orientation: number): Uint8Array {
  return jpegSegment(0xe1, concat([encoder.encode("Exif\0\0"), exifTiff(orientation)]));
}

describe("classifyImageBitmapEligibilityV1", () => {
  test("admits the pinned encoder's plain RGB JPEG and RGB/RGBA PNG", () => {
    const rgb = new Uint8Array(32 * 24 * 3).fill(0x7f);
    const rgba = new Uint8Array(32 * 24 * 4).fill(0x7f);
    for (let index = 3; index < rgba.byteLength; index += 4) rgba[index] = 0x80;

    expect(classifyImageBitmapEligibilityV1(encodeJpeg(rgb, 32, 24, 82))).toEqual({
      kind: "eligible",
      format: "jpeg",
      width: 32,
      height: 24,
      mayHaveAlpha: false,
    });
    expect(classifyImageBitmapEligibilityV1(encodePng(rgb, 32, 24, false))).toEqual({
      kind: "eligible",
      format: "png",
      width: 32,
      height: 24,
      mayHaveAlpha: false,
    });
    expect(classifyImageBitmapEligibilityV1(encodePng(rgba, 32, 24, true))).toEqual({
      kind: "eligible",
      format: "png",
      width: 32,
      height: 24,
      mayHaveAlpha: true,
    });
  });

  test("admits the supported PNG colour-type and tRNS header shapes", () => {
    const base = encodePng(new Uint8Array(8 * 8 * 3), 8, 8, false);
    for (const colorType of [0, 2, 4, 6]) {
      const bytes = base.slice();
      bytes[25] = colorType;
      expect(classifyImageBitmapEligibilityV1(bytes)).toMatchObject({
        kind: "eligible",
        format: "png",
        mayHaveAlpha: colorType === 4 || colorType === 6,
      });
    }
    const palette = base.slice();
    palette[25] = 3;
    const withPalette = insertPngBeforeIdat(
      palette,
      pngChunk("PLTE", new Uint8Array([0, 0, 0, 255, 255, 255])),
    );
    expect(classifyImageBitmapEligibilityV1(withPalette)).toMatchObject({
      kind: "eligible",
      mayHaveAlpha: false,
    });
    expect(classifyImageBitmapEligibilityV1(
      insertPngBeforeIdat(withPalette, pngChunk("tRNS", new Uint8Array([0, 255]))),
    )).toMatchObject({ kind: "eligible", mayHaveAlpha: true });
  });

  test("rejects PNG animation, non-8-bit/interlaced shapes, colour metadata, and rotation", () => {
    const base = encodePng(new Uint8Array(8 * 8 * 4), 8, 8, true);
    const sixteenBit = base.slice();
    sixteenBit[24] = 16;
    expect(classifyImageBitmapEligibilityV1(sixteenBit)).toEqual({
      kind: "ineligible",
      reason: "unsupported-png-shape",
    });
    const interlaced = base.slice();
    interlaced[28] = 1;
    expect(classifyImageBitmapEligibilityV1(interlaced)).toEqual({
      kind: "ineligible",
      reason: "unsupported-png-shape",
    });
    expect(classifyImageBitmapEligibilityV1(
      insertPngBeforeIdat(base, pngChunk("acTL", new Uint8Array(8))),
    )).toEqual({ kind: "ineligible", reason: "animated-raster" });
    expect(classifyImageBitmapEligibilityV1(
      insertPngBeforeIdat(base, pngChunk("iCCP", new Uint8Array([1, 2, 3]))),
    )).toEqual({ kind: "ineligible", reason: "embedded-color-metadata" });
    expect(classifyImageBitmapEligibilityV1(
      insertPngBeforeIdat(base, pngChunk("eXIf", exifTiff(6))),
    )).toEqual({ kind: "ineligible", reason: "unsupported-orientation" });
  });

  test("admits sequential grayscale and common RGB subsampling plus EXIF orientation 1", () => {
    for (const components of [
      [{ id: 1, sampling: 0x11 }],
      [{ id: 1, sampling: 0x11 }, { id: 2, sampling: 0x11 }, { id: 3, sampling: 0x11 }],
      [{ id: 1, sampling: 0x21 }, { id: 2, sampling: 0x11 }, { id: 3, sampling: 0x11 }],
      [{ id: 1, sampling: 0x22 }, { id: 2, sampling: 0x11 }, { id: 3, sampling: 0x11 }],
    ]) {
      expect(classifyImageBitmapEligibilityV1(jpegHeader({
        components,
        app: [jpegExif(1)],
      }))).toMatchObject({ kind: "eligible", format: "jpeg", width: 32, height: 24 });
    }
  });

  test("rejects rotated, progressive, CMYK/profiled, and malformed JPEG controls", () => {
    const rgb = [
      { id: 1, sampling: 0x22 },
      { id: 2, sampling: 0x11 },
      { id: 3, sampling: 0x11 },
    ];
    for (const orientation of [3, 6, 8]) {
      expect(classifyImageBitmapEligibilityV1(jpegHeader({
        components: rgb,
        app: [jpegExif(orientation)],
      }))).toEqual({ kind: "ineligible", reason: "unsupported-orientation" });
    }
    expect(classifyImageBitmapEligibilityV1(jpegHeader({ components: rgb, sof: 0xc2 })))
      .toEqual({ kind: "ineligible", reason: "unsupported-jpeg-shape" });
    expect(classifyImageBitmapEligibilityV1(jpegHeader({
      components: [...rgb, { id: 4, sampling: 0x11 }],
    }))).toEqual({ kind: "ineligible", reason: "unsupported-jpeg-shape" });
    expect(classifyImageBitmapEligibilityV1(jpegHeader({
      components: rgb,
      app: [jpegSegment(0xe2, encoder.encode("ICC_PROFILE\0"))],
    }))).toEqual({ kind: "ineligible", reason: "embedded-color-metadata" });
    expect(classifyImageBitmapEligibilityV1(new Uint8Array([0xff, 0xd8, 0xff])))
      .toEqual({ kind: "ineligible", reason: "malformed-raster-header" });
  });

  test("rejects non-PNG/JPEG input without inspecting raster payloads", () => {
    expect(classifyImageBitmapEligibilityV1(encoder.encode("<svg/>"))).toEqual({
      kind: "ineligible",
      reason: "not-png-or-jpeg",
    });
  });
});
