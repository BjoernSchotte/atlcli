/** Build-time rewrites required by PizZip/docxtemplater in browser hosts. */
export const DOCX_BROWSER_VITE_DEFINES = Object.freeze({
  "Buffer.from": "globalThis.__atlDocxByteHelpers.from",
  "Buffer.alloc": "globalThis.__atlDocxByteHelpers.alloc",
  "Buffer.isBuffer": "globalThis.__atlDocxByteHelpers.isBuffer",
});
