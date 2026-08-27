#!/usr/bin/env bun
/** Generates exactly the three known-truth PDFs used by the oracle spike. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateCoreFixtures } from "../../../specs/pdf-import-quality/fixtures/generate-core.js";

const OUTPUTS = [
  "independent-fragmented-tagged.pdf",
  "independent-structures-tagged.pdf",
  "independent-fragmented-untagged.pdf",
] as const;

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--output");
  const output = flag >= 0 ? process.argv[flag + 1] : undefined;
  if (!output) throw new Error("usage: generate-synthetic-spike.ts --output <directory>");
  const directory = resolve(output);
  await mkdir(directory, { recursive: true });
  const generated = generateCoreFixtures();
  for (const name of OUTPUTS) await writeFile(resolve(directory, name), generated[name]);
  process.stdout.write(`generated ${OUTPUTS.length} neutral known-truth PDFs\n`);
}

await main();
