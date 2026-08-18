/**
 * Bun `with { type: "file" }` asset imports: the module's default export is
 * the file's path (on disk under `bun run`, `$bunfs` inside a compiled
 * binary). TypeScript never resolves these specifiers — these ambient
 * declarations supply the type.
 */
declare module "*.wasm" {
  const path: string;
  export default path;
}

declare module "*.ttf" {
  const path: string;
  export default path;
}

/**
 * The typst.ts wasm is imported via its package `./wasm` subpath with
 * `{ type: "file" }`, so its default export is the file PATH — not the
 * wasm-bindgen symbol table the package's own `.wasm.d.ts` describes. This exact
 * ambient declaration shadows that so the file import types correctly (spec 008
 * T3.1). Revisit when folder 009 vendors the wasm behind a stable subpath.
 */
declare module "@atlcli/pdf-compiler-browser/wasm" {
  const path: string;
  export default path;
}

declare module "@atlcli/import-pdf/wasm" {
  const path: string;
  export default path;
}
