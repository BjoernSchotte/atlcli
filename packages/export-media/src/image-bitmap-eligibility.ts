/**
 * Conservative, allocation-bounded eligibility for the browser-native raster
 * path. This is deliberately narrower than what Chrome can decode: the native
 * path may only see shapes whose orientation, colour, alpha, and geometry
 * semantics are already explicit in the deterministic reference pipeline.
 *
 * The parser walks container headers and skips compressed payloads. It never
 * decodes pixels, inflates PNG IDAT data, or scans JPEG entropy-coded bytes.
 */

export type ImageBitmapIneligibleReasonV1 =
  | "not-png-or-jpeg"
  | "malformed-raster-header"
  | "unsupported-png-shape"
  | "unsupported-jpeg-shape"
  | "animated-raster"
  | "unsupported-orientation"
  | "embedded-color-metadata";

export type ImageBitmapEligibilityV1 =
  | {
      kind: "eligible";
      format: "png" | "jpeg";
      width: number;
      height: number;
      /** PNG may carry alpha through a channel or tRNS; JPEG is always false. */
      mayHaveAlpha: boolean;
    }
  | { kind: "ineligible"; reason: ImageBitmapIneligibleReasonV1 };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PNG_COLOR_TYPES = new Set([0, 2, 3, 4, 6]);

function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength >= PNG_SIGNATURE.length
    && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function chunkName(bytes: Uint8Array, offset: number): string | undefined {
  let value = "";
  for (let index = 0; index < 4; index += 1) {
    const code = bytes[offset + index];
    if (code === undefined || !(
      (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
    )) {
      return undefined;
    }
    value += String.fromCharCode(code);
  }
  return value;
}

type ExifOrientation =
  | { kind: "absent" }
  | { kind: "value"; value: number }
  | { kind: "malformed" };

function exifOrientation(
  bytes: Uint8Array,
  offset: number,
  length: number,
): ExifOrientation {
  if (length < 8 || offset < 0 || offset + length > bytes.byteLength) {
    return { kind: "malformed" };
  }
  const little = bytes[offset] === 0x49 && bytes[offset + 1] === 0x49;
  const big = bytes[offset] === 0x4d && bytes[offset + 1] === 0x4d;
  if (!little && !big) return { kind: "malformed" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read16 = (relative: number): number | undefined =>
    relative >= 0 && relative + 2 <= length
      ? view.getUint16(offset + relative, little)
      : undefined;
  const read32 = (relative: number): number | undefined =>
    relative >= 0 && relative + 4 <= length
      ? view.getUint32(offset + relative, little)
      : undefined;
  if (read16(2) !== 42) return { kind: "malformed" };
  const ifdOffset = read32(4);
  if (ifdOffset === undefined || ifdOffset < 8) return { kind: "malformed" };
  const entryCount = read16(ifdOffset);
  if (entryCount === undefined || entryCount > Math.floor((length - ifdOffset - 2) / 12)) {
    return { kind: "malformed" };
  }
  let orientation: number | undefined;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (read16(entry) !== 0x0112) continue;
    if (orientation !== undefined || read16(entry + 2) !== 3 || read32(entry + 4) !== 1) {
      return { kind: "malformed" };
    }
    orientation = read16(entry + 8);
    if (orientation === undefined || orientation < 1 || orientation > 8) {
      return { kind: "malformed" };
    }
  }
  return orientation === undefined
    ? { kind: "absent" }
    : { kind: "value", value: orientation };
}

function classifyPng(bytes: Uint8Array): ImageBitmapEligibilityV1 {
  if (bytes.byteLength < 33) {
    return { kind: "ineligible", reason: "malformed-raster-header" };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let paletteEntries = 0;
  let seenHeader = false;
  let seenPalette = false;
  let seenTransparency = false;
  let seenImageData = false;
  let seenEnd = false;
  let seenExif = false;

  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const dataOffset = offset + 8;
    const end = dataOffset + length;
    if (!Number.isSafeInteger(end) || end + 4 > bytes.byteLength) {
      return { kind: "ineligible", reason: "malformed-raster-header" };
    }
    const name = chunkName(bytes, offset + 4);
    if (!name) return { kind: "ineligible", reason: "malformed-raster-header" };

    if (!seenHeader) {
      if (name !== "IHDR" || length !== 13) {
        return { kind: "ineligible", reason: "malformed-raster-header" };
      }
      width = view.getUint32(dataOffset);
      height = view.getUint32(dataOffset + 4);
      const bitDepth = bytes[dataOffset + 8];
      colorType = bytes[dataOffset + 9] ?? -1;
      if (
        width === 0
        || height === 0
        || bitDepth !== 8
        || !PNG_COLOR_TYPES.has(colorType)
        || bytes[dataOffset + 10] !== 0
        || bytes[dataOffset + 11] !== 0
        || bytes[dataOffset + 12] !== 0
      ) {
        return { kind: "ineligible", reason: "unsupported-png-shape" };
      }
      seenHeader = true;
    } else if (name === "IHDR") {
      return { kind: "ineligible", reason: "malformed-raster-header" };
    } else if (name === "acTL" || name === "fcTL" || name === "fdAT") {
      return { kind: "ineligible", reason: "animated-raster" };
    } else if (["iCCP", "cICP", "mDCv", "cLLi", "gAMA", "cHRM"].includes(name)) {
      return { kind: "ineligible", reason: "embedded-color-metadata" };
    } else if (name === "eXIf") {
      if (seenExif) return { kind: "ineligible", reason: "malformed-raster-header" };
      seenExif = true;
      const orientation = exifOrientation(bytes, dataOffset, length);
      if (orientation.kind === "malformed") {
        return { kind: "ineligible", reason: "malformed-raster-header" };
      }
      if (orientation.kind === "value" && orientation.value !== 1) {
        return { kind: "ineligible", reason: "unsupported-orientation" };
      }
    } else if (name === "PLTE") {
      if (seenPalette || seenImageData || length === 0 || length > 768 || length % 3 !== 0) {
        return { kind: "ineligible", reason: "malformed-raster-header" };
      }
      seenPalette = true;
      paletteEntries = length / 3;
    } else if (name === "tRNS") {
      if (
        seenTransparency
        || seenImageData
        || !(
          (colorType === 0 && length === 2)
          || (colorType === 2 && length === 6)
          || (colorType === 3 && seenPalette && length > 0 && length <= paletteEntries)
        )
      ) {
        return { kind: "ineligible", reason: "unsupported-png-shape" };
      }
      seenTransparency = true;
    } else if (name === "IDAT") {
      if (colorType === 3 && !seenPalette) {
        return { kind: "ineligible", reason: "malformed-raster-header" };
      }
      seenImageData = true;
    } else if (name === "IEND") {
      if (length !== 0 || !seenImageData || end + 4 !== bytes.byteLength) {
        return { kind: "ineligible", reason: "malformed-raster-header" };
      }
      seenEnd = true;
      break;
    } else if ((bytes[offset + 4]! & 0x20) === 0) {
      // Unknown critical chunks change decode semantics; ancillary chunks are
      // ignored unless explicitly rejected above for colour/orientation.
      return { kind: "ineligible", reason: "unsupported-png-shape" };
    }
    offset = end + 4;
  }

  if (!seenHeader || !seenEnd) {
    return { kind: "ineligible", reason: "malformed-raster-header" };
  }
  return {
    kind: "eligible",
    format: "png",
    width,
    height,
    mayHaveAlpha: colorType === 4 || colorType === 6 || seenTransparency,
  };
}

function classifyJpeg(bytes: Uint8Array): ImageBitmapEligibilityV1 {
  if (bytes.byteLength < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return { kind: "ineligible", reason: "not-png-or-jpeg" };
  }
  if (bytes.byteLength < 4) {
    return { kind: "ineligible", reason: "malformed-raster-header" };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  let width = 0;
  let height = 0;
  let componentIds: number[] | undefined;
  let seenExif = false;

  while (offset + 1 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      return { kind: "ineligible", reason: "malformed-raster-header" };
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    if (marker === undefined || marker === 0x00) {
      return { kind: "ineligible", reason: "malformed-raster-header" };
    }
    offset += 1;
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      if (marker === 0xd9) return { kind: "ineligible", reason: "malformed-raster-header" };
      continue;
    }
    if (offset + 2 > bytes.byteLength) {
      return { kind: "ineligible", reason: "malformed-raster-header" };
    }
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.byteLength) {
      return { kind: "ineligible", reason: "malformed-raster-header" };
    }
    const dataOffset = offset + 2;
    const dataLength = length - 2;

    if (marker === 0xe0) {
      const jfif = dataLength >= 5
        && bytes[dataOffset] === 0x4a
        && bytes[dataOffset + 1] === 0x46
        && bytes[dataOffset + 2] === 0x49
        && bytes[dataOffset + 3] === 0x46
        && bytes[dataOffset + 4] === 0;
      const jfxx = dataLength >= 5
        && bytes[dataOffset] === 0x4a
        && bytes[dataOffset + 1] === 0x46
        && bytes[dataOffset + 2] === 0x58
        && bytes[dataOffset + 3] === 0x58
        && bytes[dataOffset + 4] === 0;
      if (!jfif && !jfxx) {
        return { kind: "ineligible", reason: "unsupported-jpeg-shape" };
      }
    } else if (marker === 0xe1) {
      const isExif = dataLength >= 6
        && bytes[dataOffset] === 0x45
        && bytes[dataOffset + 1] === 0x78
        && bytes[dataOffset + 2] === 0x69
        && bytes[dataOffset + 3] === 0x66
        && bytes[dataOffset + 4] === 0
        && bytes[dataOffset + 5] === 0;
      if (!isExif || seenExif) {
        return { kind: "ineligible", reason: "unsupported-jpeg-shape" };
      }
      seenExif = true;
      const orientation = exifOrientation(bytes, dataOffset + 6, dataLength - 6);
      if (orientation.kind === "malformed") {
        return { kind: "ineligible", reason: "malformed-raster-header" };
      }
      if (orientation.kind === "value" && orientation.value !== 1) {
        return { kind: "ineligible", reason: "unsupported-orientation" };
      }
    } else if (marker >= 0xe2 && marker <= 0xef) {
      return {
        kind: "ineligible",
        reason: marker === 0xe2 ? "embedded-color-metadata" : "unsupported-jpeg-shape",
      };
    } else if (marker === 0xc0 || marker === 0xc1) {
      if (componentIds || dataLength < 9 || bytes[dataOffset] !== 8) {
        return { kind: "ineligible", reason: "unsupported-jpeg-shape" };
      }
      height = view.getUint16(dataOffset + 1);
      width = view.getUint16(dataOffset + 3);
      const count = bytes[dataOffset + 5] ?? 0;
      if (!width || !height || (count !== 1 && count !== 3) || dataLength !== 6 + count * 3) {
        return { kind: "ineligible", reason: "unsupported-jpeg-shape" };
      }
      componentIds = [];
      const sampling: Array<{ h: number; v: number }> = [];
      for (let index = 0; index < count; index += 1) {
        const at = dataOffset + 6 + index * 3;
        const id = bytes[at]!;
        const h = bytes[at + 1]! >> 4;
        const v = bytes[at + 1]! & 0x0f;
        if (componentIds.includes(id) || h < 1 || h > 2 || v < 1 || v > 2) {
          return { kind: "ineligible", reason: "unsupported-jpeg-shape" };
        }
        componentIds.push(id);
        sampling.push({ h, v });
      }
      if (
        (count === 1 && (componentIds[0] !== 1 || sampling[0]!.h !== 1 || sampling[0]!.v !== 1))
        || (
          count === 3
          && (
            componentIds[0] !== 1
            || componentIds[1] !== 2
            || componentIds[2] !== 3
            || sampling[1]!.h !== 1
            || sampling[1]!.v !== 1
            || sampling[2]!.h !== 1
            || sampling[2]!.v !== 1
          )
        )
      ) {
        return { kind: "ineligible", reason: "unsupported-jpeg-shape" };
      }
    } else if (
      marker >= 0xc2
      && marker <= 0xcf
      && marker !== 0xc4
      && marker !== 0xc8
      && marker !== 0xcc
    ) {
      return { kind: "ineligible", reason: "unsupported-jpeg-shape" };
    } else if (marker === 0xcc || marker === 0xdc) {
      return { kind: "ineligible", reason: "unsupported-jpeg-shape" };
    } else if (marker === 0xda) {
      if (!componentIds || dataLength !== 4 + componentIds.length * 2) {
        return { kind: "ineligible", reason: "malformed-raster-header" };
      }
      const count = bytes[dataOffset] ?? 0;
      if (count !== componentIds.length) {
        return { kind: "ineligible", reason: "unsupported-jpeg-shape" };
      }
      for (let index = 0; index < count; index += 1) {
        if (bytes[dataOffset + 1 + index * 2] !== componentIds[index]) {
          return { kind: "ineligible", reason: "unsupported-jpeg-shape" };
        }
      }
      const spectralOffset = dataOffset + 1 + count * 2;
      if (
        bytes[spectralOffset] !== 0
        || bytes[spectralOffset + 1] !== 63
        || bytes[spectralOffset + 2] !== 0
      ) {
        return { kind: "ineligible", reason: "unsupported-jpeg-shape" };
      }
      return {
        kind: "eligible",
        format: "jpeg",
        width,
        height,
        mayHaveAlpha: false,
      };
    }
    offset += length;
  }
  return { kind: "ineligible", reason: "malformed-raster-header" };
}

export function classifyImageBitmapEligibilityV1(
  bytes: Uint8Array,
): ImageBitmapEligibilityV1 {
  if (isPng(bytes)) return classifyPng(bytes);
  return classifyJpeg(bytes);
}
