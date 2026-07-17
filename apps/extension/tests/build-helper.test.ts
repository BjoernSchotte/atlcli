import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_INPUTS, collectMtimes, isBuildStale } from "./build-helper.js";

/**
 * Regression (finding 7): ensureExtensionBuilt reused any existing `.output`
 * without a staleness check. The decision is now a pure mtime comparison —
 * tested here so a stale build is never silently reused.
 */
describe("isBuildStale", () => {
  it("tracks the DOCX package that supplies the browser runtime", () => {
    expect(BUILD_INPUTS).toContain("../../packages/docx/src");
    expect(BUILD_INPUTS).toContain("../../packages/docx/package.json");
  });

  it("is stale when no build exists (manifest mtime null)", () => {
    expect(isBuildStale(null, [])).toBe(true);
    expect(isBuildStale(null, [100, 200])).toBe(true);
  });

  it("is fresh when every source is older than the manifest", () => {
    expect(isBuildStale(1000, [100, 500, 999])).toBe(false);
  });

  it("is fresh when there are no sources", () => {
    expect(isBuildStale(1000, [])).toBe(false);
  });

  it("is stale when any source is newer than the manifest", () => {
    expect(isBuildStale(1000, [100, 1001])).toBe(true);
    expect(isBuildStale(1000, [2000])).toBe(true);
  });

  it("treats an equal mtime as fresh (strictly newer only)", () => {
    expect(isBuildStale(1000, [1000])).toBe(false);
  });
});

describe("collectMtimes + isBuildStale (mtime fixtures)", () => {
  let dir: string;

  it("detects a source edited after the build", () => {
    dir = mkdtempSync(join(tmpdir(), "atlcli-stale-"));
    try {
      const manifest = join(dir, "manifest.json");
      const srcDir = join(dir, "src");
      mkdirSync(srcDir);
      const src = join(srcDir, "a.ts");

      // Source built first, manifest emitted after → fresh.
      writeFileSync(src, "old");
      writeFileSync(manifest, "{}");
      const t0 = 1_000_000; // seconds
      utimesSync(src, t0, t0);
      utimesSync(manifest, t0 + 10, t0 + 10);

      const manifestMtime = collectMtimes(manifest)[0]!;
      expect(isBuildStale(manifestMtime, collectMtimes(srcDir))).toBe(false);

      // Now touch the source AFTER the manifest → stale.
      utimesSync(src, t0 + 20, t0 + 20);
      expect(isBuildStale(manifestMtime, collectMtimes(srcDir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
