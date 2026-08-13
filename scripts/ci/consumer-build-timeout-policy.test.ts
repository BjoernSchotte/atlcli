import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const files = [
  "packages/web-publish-starlight/src/starlight-renderer.test.ts",
  "packages/web-publish-astro/src/astro-consumer.test.ts",
];

test("real Astro consumer builds have bounded runner headroom", async () => {
  for (const file of files) {
    const source = await readFile(resolve(import.meta.dir, "../..", file), "utf8");
    expect(source).toContain("const CONSUMER_BUILD_TIMEOUT_MS = 60_000;");
    expect(source).not.toContain("}, 30_000);");
    expect(source).toContain("}, CONSUMER_BUILD_TIMEOUT_MS);");
  }
});
