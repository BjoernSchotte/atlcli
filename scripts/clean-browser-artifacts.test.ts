import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import {
  browserArtifactPaths,
  cleanBrowserArtifacts,
} from "./clean-browser-artifacts.js";

let fixtureRoot: string | undefined;

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

function createFixture(): string {
  fixtureRoot = mkdtempSync(join(tmpdir(), "atlcli-browser-artifacts-"));
  for (const path of browserArtifactPaths(fixtureRoot)) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "stale.js"), "stale");
  }
  mkdirSync(join(fixtureRoot, "apps", "extension", "keep"), { recursive: true });
  writeFileSync(join(fixtureRoot, "apps", "extension", "keep", "source.ts"), "keep");
  return fixtureRoot;
}

describe("cleanBrowserArtifacts", () => {
  it("removes only the exact generated extension and harness output roots", () => {
    const root = createFixture();
    cleanBrowserArtifacts(root);

    for (const path of browserArtifactPaths(root)) expect(existsSync(path)).toBe(false);
    expect(existsSync(join(root, "apps", "extension", "keep", "source.ts"))).toBe(true);
  });

  it("can clean one host without touching the other", () => {
    const root = createFixture();
    const [extension, harness] = browserArtifactPaths(root);
    cleanBrowserArtifacts(root, "extension");

    expect(existsSync(extension!)).toBe(false);
    expect(existsSync(harness!)).toBe(true);
  });
});
