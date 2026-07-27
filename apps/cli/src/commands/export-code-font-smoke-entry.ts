/**
 * Standalone smoke entry for the DOCX code-font asset bridge. The source run,
 * Bun bundle, and compiled executable must all receive the same committed sfnt
 * bytes even when launched from a foreign working directory.
 */
import { prepareDocxExportRuntime } from "@atlcli/docx";
import { configureBundledCodeFontLoader } from "@atlcli/docx/internal";
import { loadDocxCodeFont } from "./export-code-font.js";

async function main(): Promise<void> {
  let loads = 0;
  configureBundledCodeFontLoader(async () => {
    loads += 1;
    return loadDocxCodeFont();
  });
  const [first, second] = await Promise.all([
    prepareDocxExportRuntime([]),
    prepareDocxExportRuntime([]),
  ]);
  const warm = await prepareDocxExportRuntime([]);
  const bytes = await loadDocxCodeFont();
  const sfnt =
    first.codeFontBytes === bytes.byteLength &&
    second.codeFontBytes === bytes.byteLength &&
    warm.codeFontBytes === bytes.byteLength &&
    loads === 1 &&
    bytes.byteLength > 250_000 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00;
  if (!sfnt) {
    process.stdout.write(`CODE_FONT_FAIL ${bytes.byteLength}\n`);
    process.exit(1);
  }
  process.stdout.write(`CODE_FONT_OK ${bytes.byteLength}\n`);
}

main().catch((error) => {
  process.stdout.write(
    `CODE_FONT_FAIL ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
