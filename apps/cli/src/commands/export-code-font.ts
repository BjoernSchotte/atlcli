/**
 * Compiled-CLI bridge for the DOCX embedded code font.
 *
 * `@atlcli/docx` can load its package-relative font in ordinary Node/Bun and
 * browser-bundler runs. A single-file Bun executable has no package-relative
 * filesystem, so this host imports the same committed TTF as a Bun file asset
 * and passes its bytes explicitly to the isomorphic engine.
 */
import { assetFilePath } from "./asset-file-path.js";
import codeFontFile from "@atlcli/docx/fonts/JetBrainsMono-Regular.ttf" with { type: "file" };
import { readFile } from "node:fs/promises";


export async function loadDocxCodeFont(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(assetFilePath(codeFontFile)));
}
