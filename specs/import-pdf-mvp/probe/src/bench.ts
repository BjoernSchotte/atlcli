import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { semanticDigest } from "./canonical.ts";
import { analyzeWithPdfium } from "./pdfium.ts";
import { analyzeWithPdfjs } from "./pdfjs.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = resolve(ROOT, "../fixtures");
const fixtures = ["simple-untagged.pdf", "complex-tagged.pdf", "scan.pdf", "heading-rich-100.pdf"];
const engines = ["pdfium", "pdfjs"] as const;

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

const rows = [];
for (const fixture of fixtures) {
  const bytes = new Uint8Array(await readFile(resolve(FIXTURES, fixture)));
  for (const engine of engines) {
    const samples = [];
    const digests = [];
    for (let index = 0; index < 5; index += 1) {
      const rssBefore = process.memoryUsage.rss();
      const started = performance.now();
      const facts = engine === "pdfium" ? await analyzeWithPdfium(bytes) : await analyzeWithPdfjs(bytes);
      samples.push(Math.round((performance.now() - started) * 1000) / 1000);
      digests.push(semanticDigest(facts));
      const rssAfter = process.memoryUsage.rss();
      if (index === 4) {
        rows.push({
          engine,
          fixture,
          coldMs: samples[0],
          warmP50Ms: percentile(samples.slice(1), 0.5),
          warmP95Ms: percentile(samples.slice(1), 0.95),
          inProcessRssDeltaBytes: rssAfter - rssBefore,
          semanticDigest: digests[0],
          repeatDigestsEqual: new Set(digests).size === 1,
        });
      }
    }
  }
}

if (rows.some((row) => !row.repeatDigestsEqual)) throw new Error("semantic digest changed across repeated runs");
await Bun.write(resolve(ROOT, "../../../.tmp/import-pdf-probe/benchmark.json"), JSON.stringify(rows, null, 2) + "\n");
console.log(JSON.stringify(rows, null, 2));
