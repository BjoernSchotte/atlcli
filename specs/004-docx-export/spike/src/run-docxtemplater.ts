/**
 * docxtemplater (free tier) engine run → out/docxtemplater-native.docx
 *
 *  - Raw OOXML injection via the built-in FREE `rawxml` module ({@tag}); it
 *    replaces the whole paragraph, so block content (callout table, code para)
 *    splices in cleanly — no breakout balancing needed.
 *  - Image embedding WITHOUT the paid Image module: a *self-built* OOXML image
 *    module (src/ooxml.ts addImageRel + imageDrawing) adds media parts,
 *    relationships and the png content-type by hand, then references the rIds
 *    from a {@rawXml} drawing. This is the concrete free-tier image effort.
 *
 * Run: bun run src/run-docxtemplater.ts
 */
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addImageRel, calloutBox, coloredCodeBlock, imageDrawing } from "./ooxml";
import { makeDocx } from "./make-docx";

const outDir = join(import.meta.dir, "..", "out");
const fixDir = join(import.meta.dir, "..", "fixtures");

const template = await makeDocx([
  { text: "docxtemplater free-tier capabilities", heading: 1 },
  { text: "Callout via built-in free rawxml:" },
  { text: "{@calloutXml}" },
  { text: "Colored code via built-in free rawxml:" },
  { text: "{@codeXml}" },
  { text: "Images via self-built OOXML image module, no paid module:" },
  { text: "{@imagesXml}" },
]);

const zip = new PizZip(template);

// --- self-built image module: reserve rels + media parts BEFORE render ---
const imgSpecs = [
  ["img-red.png", 120, 80, "Red"],
  ["img-green.png", 100, 100, "Green"],
  ["img-blue.png", 160, 60, "Blue"],
] as const;
const imagesXml = imgSpecs
  .map(([file, w, h, name], i) => {
    const relId = addImageRel(zip, readFileSync(join(fixDir, file)));
    return imageDrawing(relId, w, h, name, 2000 + i);
  })
  .join("");

const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
const t0 = performance.now();
doc.render({
  calloutXml: calloutBox("warning", "Warning", "Injected via docxtemplater free rawxml ({@…})."),
  codeXml: coloredCodeBlock([
    { text: "let", color: "0000FF" },
    { text: " y = ", color: "000000" },
    { text: "42", color: "098658" },
    { text: ";", color: "000000" },
  ]),
  imagesXml,
});
const ms = performance.now() - t0;

const buf = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
const outPath = join(outDir, "docxtemplater-native.docx");
writeFileSync(outPath, buf);
console.log(`docxtemplater: wrote ${outPath} (${buf.length} bytes) in ${ms.toFixed(1)} ms`);
