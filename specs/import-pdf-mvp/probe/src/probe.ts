import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { semanticDigest, semanticSummary } from "./canonical.ts";
import { analyzeWithPdfium } from "./pdfium.ts";
import { analyzeWithPdfjs } from "./pdfjs.ts";
import type { PdfFacts } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "../../fixtures");
const OUTPUT = resolve(HERE, "../../../../.tmp/import-pdf-probe");

const DEFAULT_FIXTURES = [
  "simple-untagged.pdf",
  "complex-untagged.pdf",
  "complex-tagged.pdf",
  "scan.pdf",
  "mixed.pdf",
  "table-positive.pdf",
  "table-negative.pdf",
  "figure.pdf",
  "adversarial-actions.pdf",
  "encrypted.pdf",
];

async function run(engine: "pdfium" | "pdfjs", fixturePath: string): Promise<PdfFacts> {
  const bytes = await readFile(fixturePath);
  return engine === "pdfium" ? analyzeWithPdfium(bytes) : analyzeWithPdfjs(bytes);
}

async function main(): Promise<void> {
  const requestedEngine = process.argv.find((argument) => argument.startsWith("--engine="))?.split("=")[1];
  const requestedFixture = process.argv.find((argument) => argument.startsWith("--fixture="))?.split("=")[1];
  const requestedFixturePath = process.argv.find((argument) => argument.startsWith("--fixture-path="))?.slice("--fixture-path=".length);
  const engines: Array<"pdfium" | "pdfjs"> = requestedEngine === "pdfium" || requestedEngine === "pdfjs" ? [requestedEngine] : ["pdfium", "pdfjs"];
  const fixtures = requestedFixturePath
    ? [{ name: basename(requestedFixturePath), path: resolve(requestedFixturePath) }]
    : (requestedFixture ? [basename(requestedFixture)] : DEFAULT_FIXTURES).map((name) => ({ name, path: resolve(FIXTURES, name) }));
  await mkdir(OUTPUT, { recursive: true });
  const receipt: Array<{ engine: string; fixture: string; digest: string; summary: object; timingsMs: Record<string, number> }> = [];
  for (const fixture of fixtures) {
    for (const engine of engines) {
      const facts = await run(engine, fixture.path);
      const outputPath = resolve(OUTPUT, `${fixture.name}.${engine}.json`);
      await writeFile(outputPath, JSON.stringify(facts, null, 2) + "\n", "utf8");
      receipt.push({ engine, fixture: fixture.name, digest: semanticDigest(facts), summary: semanticSummary(facts), timingsMs: facts.timingsMs });
    }
  }
  await writeFile(resolve(OUTPUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(receipt, null, 2));
}

await main();
