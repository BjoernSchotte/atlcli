/**
 * Synchronous, dependency-free SHA-256 — the isomorphic replacement for
 * `createHash("sha256")` in {@link ./markdown.ts}.
 *
 * ## Why this exists
 *
 * `markdown.ts` is one of the browser entrypoints the CI gate
 * (`scripts/check-browser-build.ts`) guarantees to be isomorphic, and it used
 * to reach `crypto` in the LEGACY BARE form (`import { createHash } from
 * "crypto"`). Bundlers do not fail on that — Bun silently substitutes its
 * `crypto-browserify` polyfill — so the cost was invisible: the browser bundle
 * for `markdown.ts` grew to 1.2 MB and carried `Buffer.` member access plus
 * `runInThisContext`, neither of which exists in an extension page. The gate's
 * source-graph rule now names that import; this module removes the need for it.
 *
 * ## Why not WebCrypto
 *
 * `crypto.subtle.digest` is the obvious isomorphic answer, but it is
 * **asynchronous**. `hashContent` is synchronous and is called from dozens of
 * sites in `apps/cli/src/commands/docs.ts`, several inside object literals used
 * for change detection; making it async would ripple through the whole sync
 * pipeline for no functional gain. A ~60-line block implementation stays sync
 * and adds ~1 KB to the bundle instead of ~1.2 MB.
 *
 * Digests are byte-identical to `node:crypto`'s — asserted against it in
 * `sha256.test.ts`, which matters because stored hashes in `.atlcli` state
 * files were produced by the old implementation.
 */

/** SHA-256 round constants: first 32 bits of the cube roots of the first 64 primes. */
// prettier-ignore
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Initial hash state: first 32 bits of the square roots of the first 8 primes. */
// prettier-ignore
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** Lowercase hex SHA-256 of `bytes` (FIPS 180-4). */
export function sha256HexSync(bytes: Uint8Array): string {
  // Padded message: original bytes, 0x80, zero fill, 64-bit big-endian bit length.
  const bitLength = bytes.length * 8;
  // ceil((len + 1 + 8) / 64) * 64 — the `+ 63` rounds UP. Writing this as
  // `(((len + 9) >> 6) + 1) << 6` looks equivalent but adds a spurious empty
  // block whenever `len + 9` is already a multiple of 64 (len 55, 119, …),
  // which silently changes the digest; `sha256.test.ts` pins those lengths.
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  // Bit lengths beyond 2^32 are unreachable here (inputs are in-memory strings),
  // but the high word is written correctly anyway.
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const h = new Uint32Array(H0);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  let hex = "";
  for (const word of h) hex += word.toString(16).padStart(8, "0");
  return hex;
}

/** Lowercase hex SHA-256 of `text`, hashed as UTF-8 (matching `.update(text, "utf8")`). */
export function sha256HexOfUtf8(text: string): string {
  return sha256HexSync(new TextEncoder().encode(text));
}
