import { expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("is a Starlight-free Astro render-kit package with only the normalized block-model dependency", async () => {
  const packageRoot = resolve(import.meta.dir, "..");
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    atlcli?: { publish?: string };
    exports?: Record<string, unknown>;
  };
  expect(manifest.atlcli?.publish).toBe("public-0.x");
  expect(manifest.peerDependencies?.astro).toBe(">=7.1.6 <8");
  expect(manifest.dependencies).toEqual({ "@atlcli/export-blocks": "workspace:*" });
  expect(manifest.exports).toMatchObject({ "./fixtures": { default: "./dist/fixtures.js" } });
  const source = await readFile(resolve(packageRoot, "src/index.ts"), "utf8");
  expect(source).not.toContain("starlight");
  expect(source).not.toContain("@atlcli/confluence");
  expect(source).not.toContain("@atlcli/web-publish");
  await expect(access(resolve(packageRoot, "src/components/ExportDocument.astro"))).resolves.toBeNull();
  await expect(access(resolve(packageRoot, "src/styles.css"))).resolves.toBeNull();
});
