/**
 * Materialize the image-heavy corpus (issue #118 Phase 0) into this harness's
 * `public/` dir so the Chrome benchmark page can fetch it like attachment
 * downloads instead of regenerating 100 MiB inside the browser.
 *
 * Runs in the `prebench:memory-chrome` chain. `ATLCLI_MEMORY_CORPUS_SCALE`
 * overrides the scale for quick local runs (default 1 = the ≥100 MiB
 * acceptance corpus); a matching cached manifest short-circuits regeneration.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateImageHeavyCorpus,
  IMAGE_HEAVY_CORPUS_DEFAULT_SEED,
  IMAGE_HEAVY_CORPUS_SCHEMA,
} from "@atlcli/export-fixtures";

const outDir = fileURLToPath(new URL("./public/image-heavy", import.meta.url));
const scale = Number(process.env.ATLCLI_MEMORY_CORPUS_SCALE ?? "1");
const manifestPath = join(outDir, "manifest.json");

if (process.env.ATLCLI_MEMORY_CORPUS_FORCE !== "1" && existsSync(manifestPath)) {
  try {
    const cached = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      schema?: string;
      seed?: number;
      scale?: number;
      manifestSha256?: string;
    };
    if (
      cached.schema === IMAGE_HEAVY_CORPUS_SCHEMA &&
      cached.seed === IMAGE_HEAVY_CORPUS_DEFAULT_SEED &&
      cached.scale === scale
    ) {
      console.log(
        `image-heavy corpus cached (scale ${scale}, manifest ${cached.manifestSha256?.slice(0, 12)}…)`
      );
      process.exit(0);
    }
  } catch {
    // Unreadable cache: fall through and regenerate.
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const startedAt = performance.now();
const corpus = generateImageHeavyCorpus({ scale });
for (const asset of corpus.assets) {
  writeFileSync(join(outDir, asset.filename), asset.bytes);
}
writeFileSync(
  manifestPath,
  `${JSON.stringify({ schema: corpus.schema, seed: corpus.seed, scale: corpus.scale, manifestSha256: corpus.manifestSha256, minAggregateBytes: corpus.minAggregateBytes, counts: corpus.counts, manifest: corpus.manifest }, null, 2)}\n`
);
writeFileSync(join(outDir, "blocks.json"), `${JSON.stringify(corpus.blocks)}\n`);
console.log(
  `image-heavy corpus generated: scale ${scale}, ${corpus.counts.uniqueAssets} assets, ` +
    `${(corpus.counts.uniqueAssetBytes / 1048576).toFixed(2)} MiB, ` +
    `manifest ${corpus.manifestSha256.slice(0, 12)}… ` +
    `[${Math.round(performance.now() - startedAt)}ms]`
);
