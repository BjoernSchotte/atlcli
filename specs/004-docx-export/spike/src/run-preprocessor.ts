/**
 * Realistic product path (ENGINE-AGNOSTIC) on the actual customer template that
 * uses literal `$scroll.*` placeholders → out/customer-preprocessed.docx
 *
 * Demonstrates:
 *   - criterion 3: `$scroll.*` survives the engine's default delimiters (neither
 *     {…} nor {{…}} match `$…`), so a preprocessor must replace them; and it
 *     does so across document/header/footer parts.
 *   - criterion 6: header ($scroll.title/$scroll.exportdate) and footer
 *     ($scroll.exporter.fullName) placeholders are replaced — proven, not assumed.
 *   - full content-zoo body injected at $scroll.content, with 3 images embedded
 *     via the self-built image module.
 *
 * This same output would be produced regardless of which templating engine is
 * chosen, because the `$scroll.*` layer is handled here, not by the engine.
 *
 * Run: bun run src/run-preprocessor.ts
 */
import PizZip from "pizzip";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBodyOoxml } from "./payload";
import { preprocessScroll } from "./preprocess";

const outDir = join(import.meta.dir, "..", "out");
const templatePath = join(import.meta.dir, "..", "fixtures", "fixture-template.docx");

const zip = new PizZip(readFileSync(templatePath));

const t0 = performance.now();
// Body OOXML (adds image media parts + rels into the zip as a side-effect).
const body = buildBodyOoxml(zip);

const report = preprocessScroll(
  zip,
  {
    "$scroll.title": "Q3 Architecture Overview",
    "$scroll.exportdate": "14.07.2026",
    "$scroll.exporter.fullName": "Björn Schotte",
    "$scroll.space.name": "Engineering Docs",
    "$scroll.pagelabels": "architecture, review",
  },
  body,
);
const ms = performance.now() - t0;

const buf = zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
const outPath = join(outDir, "customer-preprocessed.docx");
writeFileSync(outPath, buf);

console.log(`preprocessor: wrote ${outPath} (${buf.length} bytes) in ${ms.toFixed(1)} ms`);
for (const r of report) console.log(`  ${r.part}: replaced ${r.replaced.join(", ")}`);
