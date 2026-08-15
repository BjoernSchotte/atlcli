/**
 * Compiled-CLI bridge for the DOCX embedded code font.
 *
 * `@atlcli/docx` can load its package-relative font in ordinary Node/Bun and
 * browser-bundler runs. A single-file Bun executable has no package-relative
 * filesystem, so this host imports the same committed TTF as a Bun file asset
 * and passes its bytes explicitly to the isomorphic engine.
 */
import codeFontFile from "@atlcli/docx/fonts/JetBrainsMono-Regular.ttf" with { type: "file" };
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

function assetFilePath(imported: string): string {
  return isAbsolute(imported) ? imported : resolve(import.meta.dir, imported);
}

export async function loadDocxCodeFont(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(assetFilePath(codeFontFile)));
}
