import { isAbsolute, resolve } from "node:path";

/**
 * Resolve a `with { type: "file" }` import path to something `readFile` can open
 * from any CWD. In source runs and `bun build --compile` binaries the path is
 * already absolute (a `node_modules` path or a `$bunfs` path). In a plain
 * `bun build --target bun` dist bundle the import yields a path RELATIVE to the
 * emitted bundle directory; anchoring relative paths to `import.meta.dir` (the
 * bundle's own directory) makes all three modes work (spec 008 T3.1).
 */
export function assetFilePath(imported: string): string {
  return isAbsolute(imported) ? imported : resolve(import.meta.dir, imported);
}
