import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTestInventory,
  discoverTestFiles,
  normalizeRepositoryTestPath,
  repositoryRelativePath,
} from "./test-inventory.js";

describe("test inventory", () => {
  test("includes every Bun naming family with stable full-path ordering", () => {
    expect(
      buildTestInventory([
        "z/same.test.ts",
        "a/same.test.ts",
        "pkg/alpha_test.jsx",
        "pkg/bravo.spec.js",
        "pkg/charlie_spec.tsx",
        "pkg/not-a-test.ts",
        "./pkg/bravo.spec.js",
      ]),
    ).toEqual([
      "a/same.test.ts",
      "pkg/alpha_test.jsx",
      "pkg/bravo.spec.js",
      "pkg/charlie_spec.tsx",
      "z/same.test.ts",
    ]);
  });

  test("excludes hidden, dependency, generated, output, and Playwright artifact directories", () => {
    expect(
      buildTestInventory([
        ".hidden/secret.test.ts",
        ".turbo/cache.test.ts",
        "node_modules/pkg/index.test.ts",
        "packages/x/dist/index.test.js",
        "packages/x/build/index.spec.js",
        "packages/x/generated/schema_test.ts",
        "coverage/report.test.ts",
        "playwright-report/output.test.ts",
        "test-results/retry.spec.ts",
        "packages/x/src/index.test.ts",
      ]),
    ).toEqual(["packages/x/src/index.test.ts"]);
  });

  test("normalizes separators and rejects absolute or escaping paths", () => {
    expect(buildTestInventory(["packages\\x\\src\\index.test.ts"])).toEqual([
      "packages/x/src/index.test.ts",
    ]);
    expect(() => normalizeRepositoryTestPath("../outside.test.ts")).toThrow("escapes");
    expect(() => normalizeRepositoryTestPath("/tmp/outside.test.ts")).toThrow(
      "repository-relative",
    );
  });

  test("discovers a synthetic tree without following symlinks outside it", () => {
    const root = mkdtempSync(join(tmpdir(), "atlcli-test-inventory-"));
    const outside = mkdtempSync(join(tmpdir(), "atlcli-test-inventory-outside-"));
    try {
      mkdirSync(join(root, "pkg", "nested"), { recursive: true });
      mkdirSync(join(root, "node_modules", "ignored"), { recursive: true });
      writeFileSync(join(root, "pkg", "nested", "b.test.ts"), "");
      writeFileSync(join(root, "pkg", "a_spec.js"), "");
      writeFileSync(join(root, "node_modules", "ignored", "bad.test.ts"), "");
      writeFileSync(join(outside, "outside.test.ts"), "");
      symlinkSync(outside, join(root, "outside-link"));

      expect(discoverTestFiles(root)).toEqual([
        "pkg/a_spec.js",
        "pkg/nested/b.test.ts",
      ]);
      expect(repositoryRelativePath(root, join(root, "pkg", "a_spec.js"))).toBe(
        "pkg/a_spec.js",
      );
      expect(() => repositoryRelativePath(root, join(outside, "outside.test.ts"))).toThrow(
        "outside repository",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
