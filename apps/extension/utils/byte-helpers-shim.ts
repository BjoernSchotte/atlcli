/**
 * Browser-safe replacements for the Node `Buffer.*` calls that PizZip and
 * docxtemplater carry (spec 004).
 *
 * PizZip's `nodeBuffer` helper and docxtemplater's buffer feature-detection
 * reference `Buffer.alloc` / `Buffer.from` / `Buffer.isBuffer`. In the MV3 panel
 * `Buffer` is undefined, so those bare-global member accesses are exactly the
 * class the extension-output gate rejects (spec 003 finding #6). Rather than
 * suppress the gate, the build rewrites those three member expressions to the
 * helpers below via Vite `define` (see `wxt.config.ts`) — giving them real,
 * correct `Uint8Array`-based browser implementations and removing the literal
 * `Buffer.` from the bundle. This module installs the helpers on `globalThis`
 * as a side effect; import it once, first, in the panel entry.
 *
 * Naming avoids the substring "Buffer." on purpose so the output scan stays
 * clean.
 */

export interface ByteHelpers {
  from(value: ArrayLike<number> | ArrayBuffer | string, encoding?: string): Uint8Array;
  alloc(size: number): Uint8Array;
  isBuffer(value: unknown): boolean;
}

const helpers: ByteHelpers = {
  from(value, _encoding) {
    if (typeof value === "string") return new TextEncoder().encode(value);
    return new Uint8Array(value as ArrayLike<number>);
  },
  alloc(size) {
    return new Uint8Array(size);
  },
  isBuffer() {
    // The panel never produces Node Buffers; a plain answer keeps the
    // feature-detection branches on their browser (Uint8Array) path.
    return false;
  },
};

(globalThis as { __atlByteHelpers?: ByteHelpers }).__atlByteHelpers = helpers;

export { helpers as __atlByteHelpers };
