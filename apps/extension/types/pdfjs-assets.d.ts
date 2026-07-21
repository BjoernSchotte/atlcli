/**
 * Ambient declarations for the PDF.js runtime files imported as URLs
 * (spec 010 T5.3).
 *
 * `pdfjs-dist` ships no `types`/`exports` entry, and both files are vendored
 * with Vite's `?url&no-inline` so they are emitted **verbatim** rather than
 * bundled — which is what makes their sha256 pin in
 * `scripts/check-output-build.ts` meaningful. The runtime surface is declared
 * structurally in `utils/pdf/viewer.ts`, so nothing here needs the package's
 * own typings.
 */
declare module "*.mjs?url&no-inline" {
  const url: string;
  export default url;
}
