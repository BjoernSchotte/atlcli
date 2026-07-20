/**
 * Standalone smoke entry for the diagram/SVG rasterizer three-run-mode
 * regression guard (spec 006 G4, mirroring spec 008's PDF T3.1 guard). It loads
 * the embedded resvg wasm + diagram fonts through the REAL CLI rasterizer module
 * and rasterizes a trivial SVG, printing `RASTER_OK <byteLength>` on success or
 * `RASTER_FAIL <message>` on failure.
 *
 * `export-rasterizer-build-modes.test.ts` runs this entry as a `bun build
 * --target bun` dist bundle (and, when cheap, a `--compile` binary) from a
 * FOREIGN cwd to prove the `with { type: "file" }` wasm/font imports resolve via
 * `import.meta.dir`, not the process working directory — the bug that made SVG
 * embedding fail in the dist build while working from source.
 */
import { buildDiagramRasterizer } from "./export-rasterizer.js";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#000"/></svg>';

async function main(): Promise<void> {
  let loadError: string | undefined;
  const rasterizer = await buildDiagramRasterizer((message) => {
    loadError = message;
  });
  if (!rasterizer) {
    process.stdout.write(`RASTER_FAIL load ${loadError ?? "unknown"}\n`);
    process.exit(1);
  }
  const png = await rasterizer.rasterize(SVG, { widthPx: 8, heightPx: 8 });
  // A well-formed PNG starts with the 8-byte signature.
  const sigOk =
    png.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => png[i] === b);
  if (!sigOk) {
    process.stdout.write(`RASTER_FAIL not-png ${png.length}\n`);
    process.exit(1);
  }
  process.stdout.write(`RASTER_OK ${png.length}\n`);
}

main().catch((error) => {
  process.stdout.write(`RASTER_FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
