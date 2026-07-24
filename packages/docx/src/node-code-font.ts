/**
 * Node-only host adapter for the package-relative DOCX code font.
 *
 * This module is imported only by `index.ts`. Keeping the builtin here prevents
 * browser entry points from acquiring a Node dependency while ordinary
 * Node/Bun package consumers can still call `exportDocx()` without wiring an
 * asset loader themselves.
 */
import { readFile } from "node:fs/promises";
import { configureBundledCodeFontLoader } from "./font-embedding.js";

configureBundledCodeFontLoader(async () =>
  new Uint8Array(
    await readFile(new URL("../fonts/JetBrainsMono-Regular.ttf", import.meta.url)),
  ),
);
