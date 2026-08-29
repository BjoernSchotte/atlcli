import { RASTER_QUALITY_BINARY_FIXTURES } from "./binary-fixtures.js";

export interface RasterQualityFixture {
  id: string;
  role: string;
  mediaType: string;
  expectation: "normalized" | "kept";
  bytes: Uint8Array;
  pinnedSourceSha256?: string;
}

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[value] = crc >>> 0;
  }
  return table;
})();

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function crc32(parts: readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    a += bytes[index]!;
    b += a;
    if ((index & 0xfff) === 0xfff) {
      a %= 65_521;
      b %= 65_521;
    }
  }
  return (((b % 65_521) << 16) | (a % 65_521)) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(type, (char) => char.charCodeAt(0));
  const result = new Uint8Array(12 + data.byteLength);
  writeUint32(result, 0, data.byteLength);
  result.set(typeBytes, 4);
  result.set(data, 8);
  writeUint32(result, 8 + data.byteLength, crc32([typeBytes, data]));
  return result;
}

/** A deterministic zlib stream made of uncompressed DEFLATE blocks. */
function zlibStored(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from([0x78, 0x01])];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const length = Math.min(65_535, bytes.byteLength - offset);
    const final = offset + length === bytes.byteLength;
    const inverse = (~length) & 0xffff;
    parts.push(Uint8Array.from([
      final ? 1 : 0,
      length & 0xff,
      (length >>> 8) & 0xff,
      inverse & 0xff,
      (inverse >>> 8) & 0xff,
    ]));
    parts.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  const checksum = new Uint8Array(4);
  writeUint32(checksum, 0, adler32(bytes));
  parts.push(checksum);
  return concat(parts);
}

function png(input: {
  width: number;
  height: number;
  colorType: 0 | 2 | 3 | 4 | 6;
  pixels: Uint8Array;
  palette?: Uint8Array;
  transparency?: Uint8Array;
}): Uint8Array {
  const channels = input.colorType === 0 || input.colorType === 3
    ? 1
    : input.colorType === 2
      ? 3
      : input.colorType === 4
        ? 2
        : 4;
  if (input.pixels.byteLength !== input.width * input.height * channels) {
    throw new Error(`Invalid PNG fixture payload for color type ${input.colorType}.`);
  }
  const stride = input.width * channels;
  const scanlines = new Uint8Array(input.height * (stride + 1));
  for (let y = 0; y < input.height; y += 1) {
    scanlines[y * (stride + 1)] = 0;
    scanlines.set(
      input.pixels.subarray(y * stride, (y + 1) * stride),
      y * (stride + 1) + 1,
    );
  }
  const header = new Uint8Array(13);
  writeUint32(header, 0, input.width);
  writeUint32(header, 4, input.height);
  header[8] = 8;
  header[9] = input.colorType;
  const chunks = [pngChunk("IHDR", header)];
  if (input.palette) chunks.push(pngChunk("PLTE", input.palette));
  if (input.transparency) chunks.push(pngChunk("tRNS", input.transparency));
  chunks.push(pngChunk("IDAT", zlibStored(scanlines)), pngChunk("IEND", new Uint8Array()));
  return concat([PNG_SIGNATURE, ...chunks]);
}

function rgbFromRgba(pixels: Uint8Array): Uint8Array {
  const result = new Uint8Array((pixels.byteLength / 4) * 3);
  for (let source = 0, target = 0; source < pixels.byteLength; source += 4, target += 3) {
    result[target] = pixels[source]!;
    result[target + 1] = pixels[source + 1]!;
    result[target + 2] = pixels[source + 2]!;
  }
  return result;
}

function lineArt(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      let color: readonly number[] = [248, 247, 242, 255];
      if (x < 12 && y < 12) color = [224, 61, 61, 255];
      else if (x >= width - 12 && y < 12) color = [43, 112, 224, 255];
      else if (x < 12 && y >= height - 12) color = [30, 154, 93, 255];
      else if (x >= width - 12 && y >= height - 12) color = [228, 173, 31, 255];
      else if (x % 29 === 0 || y % 23 === 0) color = [25, 31, 45, 255];
      else if (
        y >= 36 && y < 44 && x >= 22 && x < width - 20
        || y >= 52 && y < 60 && x >= 22 && x < width - 46
        || y >= 68 && y < 76 && x >= 22 && x < width - 30
      ) color = [54, 67, 91, 255];
      pixels.set(color, index);
    }
  }
  return pixels;
}

function gradient(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      pixels[index] = Math.round((x * 255) / (width - 1));
      pixels[index + 1] = Math.round((y * 255) / (height - 1));
      pixels[index + 2] = Math.round(((x + y) * 255) / (width + height - 2));
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

function transparentEdges(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const radius = Math.min(width, height) * 0.34;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const distance = Math.hypot(x - centerX, y - centerY);
      const alpha = Math.max(0, Math.min(255, Math.round((radius + 4 - distance) * 32)));
      // Fully transparent source pixels deliberately contain red. A correct
      // premultiplied resize cannot bleed that hidden colour into the edge.
      pixels[index] = alpha === 0 ? 255 : 28;
      pixels[index + 1] = alpha === 0 ? 0 : Math.round((x * 210) / width);
      pixels[index + 2] = alpha === 0 ? 0 : 224;
      pixels[index + 3] = alpha;
    }
  }
  return pixels;
}

function noise(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 3);
  let state = 0x1bad_f00d;
  for (let index = 0; index < pixels.byteLength; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    pixels[index] = state >>> 24;
  }
  return pixels;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function exifTiff(orientation: number): Uint8Array {
  const bytes = new Uint8Array(26);
  const view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x49]);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, 0x0112, true);
  view.setUint16(12, 3, true);
  view.setUint32(14, 1, true);
  view.setUint16(18, orientation, true);
  return bytes;
}

function jpegWithExif(bytes: Uint8Array, orientation: number): Uint8Array {
  const payload = concat([
    new TextEncoder().encode("Exif\0\0"),
    exifTiff(orientation),
  ]);
  const segment = new Uint8Array(payload.byteLength + 4);
  segment.set([0xff, 0xe1]);
  segment[2] = ((payload.byteLength + 2) >>> 8) & 0xff;
  segment[3] = (payload.byteLength + 2) & 0xff;
  segment.set(payload, 4);
  return concat([bytes.subarray(0, 2), segment, bytes.subarray(2)]);
}

function insertBeforeIdat(bytes: Uint8Array, type: string, data: Uint8Array): Uint8Array {
  let offset = PNG_SIGNATURE.byteLength;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (name === "IDAT") return concat([bytes.subarray(0, offset), pngChunk(type, data), bytes.subarray(offset)]);
    offset += 12 + length;
  }
  throw new Error("PNG fixture has no IDAT chunk.");
}

function fixture(
  id: string,
  role: string,
  mediaType: string,
  expectation: "normalized" | "kept",
  bytes: Uint8Array,
  pinnedSourceSha256?: string,
): RasterQualityFixture {
  return {
    id,
    role,
    mediaType,
    expectation,
    bytes,
    ...(pinnedSourceSha256 ? { pinnedSourceSha256 } : {}),
  };
}

export function buildRasterQualityFixtures(): {
  supported: RasterQualityFixture[];
  unsupported: RasterQualityFixture[];
} {
  const width = 160;
  const height = 120;
  const art = lineArt(width, height);
  const smooth = gradient(width, height);
  const alpha = transparentEdges(width, height);
  const gray = new Uint8Array(width * height);
  const grayAlpha = new Uint8Array(width * height * 2);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * 4;
    gray[pixel] = Math.round(
      smooth[source]! * 0.299 + smooth[source + 1]! * 0.587 + smooth[source + 2]! * 0.114,
    );
    grayAlpha[pixel * 2] = Math.round(
      alpha[source]! * 0.299 + alpha[source + 1]! * 0.587 + alpha[source + 2]! * 0.114,
    );
    grayAlpha[pixel * 2 + 1] = alpha[source + 3]!;
  }
  const palette = Uint8Array.from([
    250, 248, 240,
    29, 42, 68,
    222, 70, 56,
    37, 151, 112,
  ]);
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      indices[y * width + x] = (Math.floor(x / 20) + Math.floor(y / 15)) % 4;
    }
  }
  const keyedRgb = rgbFromRgba(art);
  for (let y = 28; y < 92; y += 1) {
    for (let x = 48; x < 112; x += 1) {
      const index = (y * width + x) * 3;
      keyedRgb.set([255, 0, 255], index);
    }
  }

  const rgbLineArt = png({ width, height, colorType: 2, pixels: rgbFromRgba(art) });
  const rgbaEdges = png({ width, height, colorType: 6, pixels: alpha });
  const grayGradient = png({ width, height, colorType: 0, pixels: gray });
  const grayAlphaEdges = png({ width, height, colorType: 4, pixels: grayAlpha });
  const paletteOpaque = png({ width, height, colorType: 3, pixels: indices, palette });
  const paletteAlpha = png({
    width,
    height,
    colorType: 3,
    pixels: indices,
    palette,
    transparency: Uint8Array.from([0, 96, 192, 255]),
  });
  const rgbTransparency = png({
    width,
    height,
    colorType: 2,
    pixels: keyedRgb,
    transparency: Uint8Array.from([0, 255, 0, 0, 0, 255]),
  });
  const noisy = png({ width, height, colorType: 2, pixels: noise(width, height) });

  const jpeg444 = decodeBase64(RASTER_QUALITY_BINARY_FIXTURES.jpeg444.base64);
  const jpeg422 = decodeBase64(RASTER_QUALITY_BINARY_FIXTURES.jpeg422.base64);
  const jpeg420 = decodeBase64(RASTER_QUALITY_BINARY_FIXTURES.jpeg420.base64);
  const jpegGray = decodeBase64(RASTER_QUALITY_BINARY_FIXTURES.jpegGray.base64);
  const jpegExif1 = jpegWithExif(jpeg444, 1);

  const supported = [
    fixture("png-rgb-line-art", "sharp-text-line-art", "image/png", "normalized", rgbLineArt),
    fixture("png-rgba-transparent-edge", "transparent-edges", "image/png", "normalized", rgbaEdges),
    fixture("png-grayscale-gradient", "smooth-gradient", "image/png", "normalized", grayGradient),
    fixture("png-grayscale-alpha", "grayscale-alpha", "image/png", "normalized", grayAlphaEdges),
    fixture("png-palette", "palette-line-art", "image/png", "normalized", paletteOpaque),
    fixture("png-palette-trns", "palette-transparency", "image/png", "normalized", paletteAlpha),
    fixture("png-rgb-trns", "transparent-key", "image/png", "normalized", rgbTransparency),
    fixture("png-rgb-noise", "high-frequency-noise", "image/png", "normalized", noisy),
    fixture("jpeg-rgb-444", "photograph-444", "image/jpeg", "normalized", jpeg444, RASTER_QUALITY_BINARY_FIXTURES.jpeg444.sha256),
    fixture("jpeg-rgb-422", "photograph-422", "image/jpeg", "normalized", jpeg422, RASTER_QUALITY_BINARY_FIXTURES.jpeg422.sha256),
    fixture("jpeg-rgb-420", "photograph-420", "image/jpeg", "normalized", jpeg420, RASTER_QUALITY_BINARY_FIXTURES.jpeg420.sha256),
    fixture("jpeg-grayscale", "photograph-grayscale", "image/jpeg", "normalized", jpegGray, RASTER_QUALITY_BINARY_FIXTURES.jpegGray.sha256),
    fixture("jpeg-exif-1", "orientation-1", "image/jpeg", "normalized", jpegExif1),
  ];

  const apngControl = new Uint8Array(8);
  writeUint32(apngControl, 0, 1);
  const unsupported = [
    fixture("jpeg-exif-3", "orientation-3-control", "image/jpeg", "kept", jpegWithExif(jpeg444, 3)),
    fixture("jpeg-exif-6", "orientation-6-control", "image/jpeg", "kept", jpegWithExif(jpeg444, 6)),
    fixture("jpeg-exif-8", "orientation-8-control", "image/jpeg", "kept", jpegWithExif(jpeg444, 8)),
    fixture("jpeg-progressive", "progressive-control", "image/jpeg", "kept", decodeBase64(RASTER_QUALITY_BINARY_FIXTURES.jpegProgressive.base64), RASTER_QUALITY_BINARY_FIXTURES.jpegProgressive.sha256),
    fixture("jpeg-cmyk", "cmyk-control", "image/jpeg", "kept", decodeBase64(RASTER_QUALITY_BINARY_FIXTURES.jpegCmyk.base64), RASTER_QUALITY_BINARY_FIXTURES.jpegCmyk.sha256),
    fixture("jpeg-profiled", "icc-profile-control", "image/jpeg", "kept", decodeBase64(RASTER_QUALITY_BINARY_FIXTURES.jpegProfiled.base64), RASTER_QUALITY_BINARY_FIXTURES.jpegProfiled.sha256),
    fixture("png-16-bit", "16-bit-control", "image/png", "kept", decodeBase64(RASTER_QUALITY_BINARY_FIXTURES.png16Bit.base64), RASTER_QUALITY_BINARY_FIXTURES.png16Bit.sha256),
    fixture("png-interlaced", "interlace-control", "image/png", "kept", decodeBase64(RASTER_QUALITY_BINARY_FIXTURES.pngInterlaced.base64), RASTER_QUALITY_BINARY_FIXTURES.pngInterlaced.sha256),
    fixture("png-animation", "animation-control", "image/png", "kept", insertBeforeIdat(rgbLineArt, "acTL", apngControl)),
    fixture("gif", "gif-control", "image/gif", "kept", decodeBase64("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")),
    fixture("svg", "svg-control", "image/svg+xml", "kept", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#246"/></svg>')),
    fixture("malformed", "malformed-control", "image/png", "kept", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d])),
  ];
  return { supported, unsupported };
}
