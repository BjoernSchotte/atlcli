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
