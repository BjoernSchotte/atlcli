import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(ROOT, "dist");
const BROWSER_DIST = resolve(ROOT, "dist-browser");

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
await rm(BROWSER_DIST, { recursive: true, force: true });
await mkdir(BROWSER_DIST, { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(ROOT, "src/probe.ts")],
  outdir: DIST,
  target: "node",
  format: "esm",
  packages: "external",
  sourcemap: "external",
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await copyFile(
  fileURLToPath(new URL(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm"))),
  resolve(DIST, "pdfium.wasm"),
);

for (const [entrypoint, outfile] of [["browser-entry.ts", "entry.js"], ["browser-worker.ts", "worker.js"]] as const) {
  const browserResult = await Bun.build({
    entrypoints: [resolve(ROOT, "src", entrypoint)],
    outdir: BROWSER_DIST,
    naming: outfile,
    target: "browser",
    format: "esm",
    minify: false,
  });
  if (!browserResult.success) {
    for (const log of browserResult.logs) console.error(log);
    process.exit(1);
  }
}

await Promise.all([
  copyFile(resolve(ROOT, "browser/index.html"), resolve(BROWSER_DIST, "index.html")),
  copyFile(fileURLToPath(new URL(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm"))), resolve(BROWSER_DIST, "pdfium.wasm")),
  copyFile(resolve(ROOT, "../fixtures/simple-untagged.pdf"), resolve(BROWSER_DIST, "simple-untagged.pdf")),
  copyFile(resolve(ROOT, "../fixtures/heading-rich-100.pdf"), resolve(BROWSER_DIST, "heading-rich-100.pdf")),
]);

console.log(`built ${result.outputs.length} probe files with local PDFium WASM`);
