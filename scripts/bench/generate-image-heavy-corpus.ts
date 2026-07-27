/**
 * Generate the deterministic image-heavy corpus (issue #118 Phase 0) and
 * print its manifest statistics; optionally materialize the assets to disk
 * for browser-harness consumption.
 *
 *   bun scripts/bench/generate-image-heavy-corpus.ts [--scale 1] [--seed N] [--out DIR]
 *
 * Nothing is committed: the corpus is reproduced from (seed, scale) and its
 * manifest hash pins the recipe.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateImageHeavyCorpus } from "@atlcli/export-fixtures";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const scale = Number(argValue("--scale") ?? "1");
const seedArg = argValue("--seed");
const outDir = argValue("--out");

const startedAt = performance.now();
const corpus = generateImageHeavyCorpus({
  scale,
  ...(seedArg === undefined ? {} : { seed: Number(seedArg) }),
});
const generationMs = Math.round(performance.now() - startedAt);

const MIB = 1024 * 1024;
const byRole = new Map<string, { assets: number; bytes: number; pixels: number }>();
for (const entry of corpus.manifest) {
  const bucket = byRole.get(entry.role) ?? { assets: 0, bytes: 0, pixels: 0 };
  bucket.assets += 1;
  bucket.bytes += entry.byteLength;
  bucket.pixels += entry.width * entry.height;
  byRole.set(entry.role, bucket);
}

const report = {
  schema: corpus.schema,
  seed: corpus.seed,
  scale: corpus.scale,
  generationMs,
  manifestSha256: corpus.manifestSha256,
  minAggregateBytes: corpus.minAggregateBytes,
  counts: corpus.counts,
  aggregateMiB: Number((corpus.counts.uniqueAssetBytes / MIB).toFixed(2)),
  roles: Object.fromEntries(
    [...byRole.entries()].map(([role, bucket]) => [
      role,
      {
        assets: bucket.assets,
        mib: Number((bucket.bytes / MIB).toFixed(2)),
        bytesPerPixel: Number((bucket.bytes / bucket.pixels).toFixed(3)),
      },
    ])
  ),
};
console.log(`ATLCLI_IMAGE_HEAVY_CORPUS\n${JSON.stringify(report, null, 2)}`);

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const asset of corpus.assets) {
    writeFileSync(join(outDir, asset.filename), asset.bytes);
  }
  writeFileSync(
    join(outDir, "manifest.json"),
    `${JSON.stringify({ schema: corpus.schema, seed: corpus.seed, scale: corpus.scale, manifestSha256: corpus.manifestSha256, minAggregateBytes: corpus.minAggregateBytes, counts: corpus.counts, manifest: corpus.manifest }, null, 2)}\n`
  );
  // The block tree is JSON-serializable ExportBlock[]; browser harnesses fetch
  // it alongside the assets instead of regenerating 100 MiB in-page.
  writeFileSync(join(outDir, "blocks.json"), `${JSON.stringify(corpus.blocks)}\n`);
  console.log(`Materialized ${corpus.assets.length} assets to ${outDir}`);
}
