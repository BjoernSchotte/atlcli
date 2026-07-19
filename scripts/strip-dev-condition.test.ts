import { describe, expect, it } from "bun:test";
import { stripDevelopmentConditions, stripManifest } from "./strip-dev-condition.js";

describe("strip-dev-condition (spec 009)", () => {
  it("removes development conditions at every nesting level, preserving order", () => {
    const exports = {
      ".": {
        development: { browser: "./src/index.browser.ts", default: "./src/index.ts" },
        browser: { types: "./dist/index.browser.d.ts", default: "./dist/index.browser.js" },
        default: { types: "./dist/index.d.ts", default: "./dist/index.js" },
      },
      "./browser": {
        development: "./src/index.browser.ts",
        types: "./dist/index.browser.d.ts",
        default: "./dist/index.browser.js",
      },
      "./fonts/*": "./fonts/*",
    };

    const stripped = stripDevelopmentConditions(exports) as Record<string, unknown>;

    expect(stripped).toEqual({
      ".": {
        browser: { types: "./dist/index.browser.d.ts", default: "./dist/index.browser.js" },
        default: { types: "./dist/index.d.ts", default: "./dist/index.js" },
      },
      "./browser": {
        types: "./dist/index.browser.d.ts",
        default: "./dist/index.browser.js",
      },
      "./fonts/*": "./fonts/*",
    });
    expect(JSON.stringify(stripped)).not.toContain("development");
    expect(JSON.stringify(stripped)).not.toContain("./src/");
    // Condition order is load-bearing in exports maps — must be preserved.
    expect(Object.keys((stripped as Record<string, Record<string, unknown>>)["."]!)).toEqual([
      "browser",
      "default",
    ]);
    // Input is not mutated.
    expect(Object.keys(exports["."])).toContain("development");
  });

  it("strips a full manifest's exports and leaves everything else untouched", () => {
    const manifest = {
      name: "@atlcli/example",
      version: "0.6.0",
      files: ["dist"],
      exports: { ".": { development: "./src/index.ts", default: "./dist/index.js" } },
    };

    const stripped = stripManifest(manifest);

    expect(stripped.name).toBe("@atlcli/example");
    expect(stripped.files).toEqual(["dist"]);
    expect(stripped.exports).toEqual({ ".": { default: "./dist/index.js" } });
  });

  it("every publishable package's real manifest strips to a src-free exports map", async () => {
    const { Glob } = await import("bun");
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

    const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      workspaces?: string[];
    };
    let checked = 0;
    for (const pattern of rootPkg.workspaces ?? []) {
      for (const rel of new Glob(`${pattern}/package.json`).scanSync({ cwd: repoRoot })) {
        const manifest = JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as Record<
          string,
          unknown
        > & { atlcli?: { publish?: string } };
        if (!manifest.atlcli?.publish) continue;
        checked += 1;
        const stripped = stripManifest(manifest);
        const flat = JSON.stringify(stripped.exports);
        expect(flat, `${rel}: stripped exports still reference src/`).not.toContain("./src/");
        expect(flat, `${rel}: development survived the strip`).not.toContain("development");
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });
});
