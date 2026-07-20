/**
 * Standalone smoke entry for the T3.1 three-run-mode regression guard
 * (spec 008). It loads the embedded typst wasm + fonts through the REAL CLI
 * asset module and compiles a minimal bundle, printing `PDF_OK <byteLength>` on
 * success or `PDF_FAIL <message>` on failure.
 *
 * `export-pdf-build-modes.test.ts` runs this entry three ways — `bun run`
 * (source), a `bun build --target bun` dist bundle, and a `bun build --compile`
 * binary — to prove the `with { type: "file" }` wasm/font imports survive every
 * packaging mode the release ships (the riskiest T3.1 assumption). Keeping it a
 * dedicated tiny entry (not the full CLI) keeps the build fast and hermetic.
 */
import { ATLCLI_TYPST_TEMPLATE, type PdfSourceBundle } from "@atlcli/pdf";
import { getPdfCompiler } from "./export-pdf-assets.js";

const bundle: PdfSourceBundle = {
  main: String.raw`#set text(font: "Source Sans 3")
= Build-mode smoke
`,
  template: ATLCLI_TYPST_TEMPLATE,
  assets: [],
  sourceMap: [],
  notes: [],
};

async function main(): Promise<void> {
  const compiler = await getPdfCompiler();
  const result = await compiler.compile(bundle);
  const pdf = result.pdf;
  if (!pdf || new TextDecoder("latin1").decode(pdf.subarray(0, 5)) !== "%PDF-") {
    const detail = result.diagnostics.map((d) => `${d.severity}: ${d.message}`).join("; ");
    process.stdout.write(`PDF_FAIL no-pdf ${detail}\n`);
    process.exit(1);
  }
  process.stdout.write(`PDF_OK ${pdf.byteLength}\n`);
}

main().catch((error) => {
  process.stdout.write(`PDF_FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
