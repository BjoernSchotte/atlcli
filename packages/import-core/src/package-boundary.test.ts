import { describe, expect, it } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");

describe("@atlcli/import-core package boundary", () => {
  it("has only the browser-safe shared core dependency", async () => {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      exports?: Record<string, unknown>;
    };
    expect(manifest.dependencies).toEqual({ "@atlcli/core": "workspace:*" });
    expect(manifest.exports?.["."]).toBeDefined();
  });

  it("keeps production source free of host and source-parser imports", async () => {
    const files = (await readdir(import.meta.dir)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    const source = (await Promise.all(files.map((name) => readFile(resolve(import.meta.dir, name), "utf8")))).join("\n");
    expect(source).not.toMatch(/from ["'](?:node:|bun:|@atlcli\/import-docx|@atlcli\/import-pdf|@atlcli\/confluence|@forge\/|wxt)/);
    expect(source).not.toContain("process.");
    expect(source).not.toContain("Bun.");
  });

  it("exposes the same public surface through the browser entry", async () => {
    const browserEntry = await readFile(resolve(import.meta.dir, "index.browser.ts"), "utf8");
    expect(browserEntry.trim()).toBe('export * from "./index.js";');
  });
});
