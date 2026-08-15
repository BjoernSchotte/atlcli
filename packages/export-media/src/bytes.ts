/**
 * Internal byte plumbing shared by the pinned encoders (moved verbatim from
 * `@atlcli/export-fixtures`; issue #118 Phase 1).
 */
/* ------------------------------------------------------------------------- *
 * Checksums and byte plumbing.
 * ------------------------------------------------------------------------- */

export const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(parts: Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (let i = 0; i < part.byteLength; i += 1) {
      crc = CRC_TABLE[(crc ^ part[i]!) & 0xff]! ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    a += bytes[i]!;
    b += a;
    if ((i & 0xfff) === 0xfff) {
      a %= 65521;
      b %= 65521;
    }
  }
  return (((b % 65521) << 16) | (a % 65521)) >>> 0;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

export class ByteSink {
  private buffer = new Uint8Array(1 << 16);
  private used = 0;

  push(byte: number): void {
    if (this.used === this.buffer.byteLength) {
      const next = new Uint8Array(this.buffer.byteLength * 2);
      next.set(this.buffer);
      this.buffer = next;
    }
    this.buffer[this.used] = byte;
    this.used += 1;
  }

  bytes(): Uint8Array {
    return this.buffer.slice(0, this.used);
  }
}
