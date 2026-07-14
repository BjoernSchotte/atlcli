/**
 * docx-templates (MIT) engine run.
 *
 * A) NATIVE capabilities → out/docx-templates-native.docx
 *    - Native IMAGE command (MIT, no paid module): 3 images embedded.
 *    - Literal-XML injection (||…||) for a callout table + colored code para.
 *      Note the block-level "breakout" balancing needed for run-level literal XML.
 * B) Realistic customer-template path is shared (see run-preprocessor.ts).
 *
 * Run: bun run src/run-docx-templates.ts
 */
import createReport from "docx-templates";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calloutBox, coloredCodeBlock } from "./ooxml";
import { makeDocx } from "./make-docx";

const outDir = join(import.meta.dir, "..", "out");
const fixDir = join(import.meta.dir, "..", "fixtures");

/** Wrap block-level OOXML so it is well-formed when spliced into a run's <w:t>. */
function breakout(blocks: string): string {
  return `||</w:t></w:r></w:p>${blocks}<w:p><w:r><w:t>||`;
}

const template = await makeDocx([
  { text: "docx-templates native capabilities", heading: 1 },
  { text: "Images (native MIT IMAGE command):" },
  { text: "+++IMAGE imgRed()+++" },
  { text: "+++IMAGE imgGreen()+++" },
  { text: "+++IMAGE imgBlue()+++" },
  { text: "Callout (literal XML injection):" },
  { text: "+++INS calloutXml()+++" },
  { text: "Colored code (literal XML injection):" },
  { text: "+++INS codeXml()+++" },
]);

function imageObj(file: string, wCm: number, hCm: number) {
  return () => ({ width: wCm, height: hCm, data: readFileSync(join(fixDir, file)), extension: ".png" as const });
}

const t0 = performance.now();
const buf = await createReport({
  template,
  cmdDelimiter: ["+++", "+++"],
  additionalJsContext: {
    imgRed: imageObj("img-red.png", 3.2, 2.1),
    imgGreen: imageObj("img-green.png", 2.6, 2.6),
    imgBlue: imageObj("img-blue.png", 4.2, 1.6),
    calloutXml: () => breakout(calloutBox("info", "Info", "Injected via docx-templates literal XML (||…||).")),
    codeXml: () =>
      breakout(
        coloredCodeBlock([
          { text: "const", color: "0000FF" },
          { text: " x = ", color: "000000" },
          { text: '"hi"', color: "A31515" },
          { text: ";", color: "000000" },
        ]),
      ),
  },
});
const ms = performance.now() - t0;

const outPath = join(outDir, "docx-templates-native.docx");
writeFileSync(outPath, Buffer.from(buf));
console.log(`docx-templates: wrote ${outPath} (${buf.length} bytes) in ${ms.toFixed(1)} ms`);
