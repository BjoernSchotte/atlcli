import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanText, scanOutputDir } from "../scripts/check-output-build.js";
import { ensureExtensionBuilt, OUTPUT_DIR } from "./build-helper.js";

/**
 * Extension output isomorphism gate (spec 002 Task 6).
 *
 * Positive: the real built bundle is clean.
 * Negative: a seeded `node:os` import (and a remote script origin) are caught
 * and named — same spirit as the spec-001 seeded-`node:os` fixture.
 */
describe("scanText classification", () => {
  it("flags node:/bun: specifiers", () => {
    expect(scanText(`import x from "node:os";`)).toContain("node:os");
    expect(scanText(`require('bun:sqlite')`)).toContain("bun:sqlite");
  });

  it("flags remote script origins", () => {
    const hits = scanText(`import a from "https://evil.example/x.js";`);
    expect(hits.some((h) => h.includes("https://evil.example"))).toBe(true);
    const scriptHits = scanText(`<script src="http://cdn.example/lib.js"></script>`);
    expect(scriptHits.some((h) => h.includes("http://cdn.example"))).toBe(true);
  });

  it("does not flag ordinary local imports or http string data", () => {
    expect(scanText(`import a from "./local.js";`)).toEqual([]);
    // A bare URL string (not an import/script) is not a remote SCRIPT origin.
    expect(scanText(`const url = "https://api.atlassian.net/rest";`)).toEqual([]);
  });
});

describe("scanOutputDir negative fixture", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "atlcli-scan-"));
    writeFileSync(join(dir, "clean.js"), `export const x = 1;\n`);
    writeFileSync(
      join(dir, "leaky.js"),
      `import { platform } from "node:os";\nexport const p = platform();\n`
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("catches the seeded node:os import and names the file", () => {
    const leaks = scanOutputDir(dir);
    expect(leaks.length).toBe(1);
    expect(leaks[0]!.file).toBe("leaky.js");
    expect(leaks[0]!.findings).toContain("node:os");
  });
});

describe("scanOutputDir on the real build", () => {
  beforeAll(() => ensureExtensionBuilt());

  it("finds zero leaks in .output/chrome-mv3", () => {
    expect(scanOutputDir(OUTPUT_DIR)).toEqual([]);
  });
});
