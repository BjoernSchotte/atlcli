/**
 * Minimal bootstrap that must evaluate before PizZip/docxtemplater.
 *
 * Keep this file free of DOCX engine and Shiki imports so browser hosts can
 * establish the byte-helper contract before any static dependency reads it.
 */
export interface DocxByteHelpers {
  from(value: ArrayLike<number> | ArrayBuffer | string, encoding?: string): Uint8Array;
  alloc(size: number): Uint8Array;
  isBuffer(value: unknown): boolean;
}

const helpers: DocxByteHelpers = {
  from(value, _encoding) {
    if (typeof value === "string") return new TextEncoder().encode(value);
    return new Uint8Array(value as ArrayLike<number>);
  },
  alloc(size) {
    return new Uint8Array(size);
  },
  isBuffer() {
    return false;
  },
};

type DocxBrowserGlobal = typeof globalThis & {
  __atlDocxByteHelpers?: DocxByteHelpers;
};

/** Install the namespaced byte helpers once without defining a fake Buffer. */
export function installDocxBrowserByteRuntime(): void {
  const scope = globalThis as DocxBrowserGlobal;
  scope.__atlDocxByteHelpers ??= helpers;
}

installDocxBrowserByteRuntime();
