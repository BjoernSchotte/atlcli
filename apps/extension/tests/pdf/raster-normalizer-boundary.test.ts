import { describe, expect, it } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const extensionRoot = resolve(import.meta.dir, "../..");

async function productionSources(): Promise<string> {
  const roots = ["entrypoints", "utils", "workers"];
  const files = (await Promise.all(roots.map(async (root) => {
    const names = await readdir(resolve(extensionRoot, root), { recursive: true });
    return names
      .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
      .map((name) => resolve(extensionRoot, root, name));
  }))).flat();
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

describe("productive raster normalizer boundary", () => {
  it("keeps the closed Pica and WebCodecs lanes inside the dated benchmark only", async () => {
    const source = await productionSources();
    expect(source).not.toMatch(/from\s+["']pica(?:\/|["'])/u);
    expect(source).not.toContain("ImageDecoder");
    expect(source).not.toContain('"webcodecs"');
  });

  it("keeps the productive pure worker free of network, host permissions, and nested workers", async () => {
    const source = await readFile(
      resolve(extensionRoot, "workers", "raster-normalizer.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/(?:node:|bun:|@forge\/|fetch\(|XMLHttpRequest|WebSocket)/u);
    expect(source).not.toMatch(/\b(?:chrome|browser)\./u);
    expect(source).not.toContain("new Worker");
    expect(source).not.toContain("importScripts");
    expect(source).not.toContain("Blob(");
  });
});
