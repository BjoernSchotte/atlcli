import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { analyzeFixture, canonicalJson } from "../../fixture-analysis.js";

const fixturesDirectory = resolve(import.meta.dir, "..");
const goldensDirectory = resolve(fixturesDirectory, "goldens");
const fixtures = [
  "neutral-generated-python-docx-1.2.0.docx",
  "neutral-word-16.111.1.docx",
  "neutral-libreoffice-7.1.1.2.docx",
] as const;

for (const fixture of fixtures) {
  const bytes = readFileSync(resolve(fixturesDirectory, fixture));
  const analysis = analyzeFixture(fixture, bytes);
  const goldenName = `${basename(fixture, ".docx")}.analysis.json`;
  writeFileSync(resolve(goldensDirectory, goldenName), canonicalJson(analysis));
}
