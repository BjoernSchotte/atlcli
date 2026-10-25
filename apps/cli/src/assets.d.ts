/**
 * Bun asset imports. TypeScript never resolves these specifiers; these ambient
 * declarations supply the types.
 *
 * - `with { type: "file" }`: the default export is the file's path (on disk
 *   under `bun run`, `$bunfs` inside a compiled binary).
 * - `with { type: "text" }`: the default export is the file's content, inlined
 *   into bundles and compiled binaries as a string.
 */
declare module "*.wasm" {
  const path: string;
  export default path;
}

declare module "*.ttf" {
  const path: string;
  export default path;
}

/** A built-in `atlcli script`, imported with `type: "text"` (`src/builtin-scripts/`). */
declare module "*.script" {
  const content: string;
  export default content;
}

/** Imported with `type: "text"` (the agent skill under `skills/atlcli/`). */
declare module "*.md" {
  const content: string;
  export default content;
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
