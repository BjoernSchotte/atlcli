import type { PdfNormalizedRect } from "./contracts.js";

function uint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

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

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function storedZlib(bytes: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let offset = 0; offset < bytes.byteLength || offset === 0; offset += 65_535) {
    const length = Math.min(65_535, bytes.byteLength - offset);
    const final = offset + length >= bytes.byteLength;
    blocks.push(new Uint8Array([
      final ? 1 : 0,
      length & 0xff,
      (length >>> 8) & 0xff,
      (~length) & 0xff,
      ((~length) >>> 8) & 0xff,
    ]));
    blocks.push(bytes.subarray(offset, offset + length));
    if (final) break;
  }
  blocks.push(uint32(adler32(bytes)));
  return concat(blocks);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const payload = concat([typeBytes, data]);
  return concat([uint32(data.byteLength), payload, uint32(crc32(payload))]);
}

/** Deterministic RGBA PNG encoder using bounded uncompressed DEFLATE blocks. */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width < 1
    || height < 1
    || rgba.byteLength !== width * height * 4
  ) throw new Error("Invalid bounded RGBA image dimensions.");
  const scanlines = new Uint8Array(height * (1 + width * 4));
  for (let row = 0; row < height; row += 1) {
    const target = row * (1 + width * 4);
    scanlines[target] = 0;
    scanlines.set(rgba.subarray(row * width * 4, (row + 1) * width * 4), target + 1);
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(uint32(width), 0);
  ihdr.set(uint32(height), 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", storedZlib(scanlines)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

export function expandNormalizedRect(rect: PdfNormalizedRect, margin = 0.008): PdfNormalizedRect {
  const left = Math.max(0, rect.x - margin);
  const top = Math.max(0, rect.y - margin);
  const right = Math.min(1, rect.x + rect.width + margin);
  const bottom = Math.min(1, rect.y + rect.height + margin);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function rectsTouch(a: PdfNormalizedRect, b: PdfNormalizedRect, gap = 0.012): boolean {
  return a.x <= b.x + b.width + gap
    && b.x <= a.x + a.width + gap
    && a.y <= b.y + b.height + gap
    && b.y <= a.y + a.height + gap;
}
