import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeWithPdfjs } from "./pdfjs.ts";

const input = process.argv[2];
if (!input) throw new Error("The isolated PDF.js probe requires one fixture path.");

const facts = await analyzeWithPdfjs(new Uint8Array(await readFile(resolve(input))));
process.stdout.write(`${JSON.stringify(facts)}\n`);
