import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareReleaseOutputDirectory,
  runReleaseArtifactBuildCli,
  withRestoredFileMode,
} from "./build-release-artifacts";

describe("release artifact builder safety", () => {
  test("never cleans an unowned output directory", () => {
    const root = mkdtempSync(join(tmpdir(), "atlcli-release-output-"));
    const keep = join(root, "keep.txt");
    try {
      writeFileSync(keep, "must survive");
      expect(() => prepareReleaseOutputDirectory(root)).toThrow("unowned");
      expect(readFileSync(keep, "utf8")).toBe("must survive");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reuses only a directory carrying its ownership marker", () => {
    const parent = mkdtempSync(join(tmpdir(), "atlcli-release-output-parent-"));
    const output = join(parent, "release");
    try {
      prepareReleaseOutputDirectory(output);
      writeFileSync(join(output, "old-artifact.zip"), "old");
      prepareReleaseOutputDirectory(output);
      expect(existsSync(join(output, "old-artifact.zip"))).toBe(false);
      expect(existsSync(join(output, ".atlcli-release-artifacts-v1"))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("restores a file mode even when a tool mutates it", async () => {
    const parent = mkdtempSync(join(tmpdir(), "atlcli-release-mode-"));
    const entryPoint = join(parent, "entry.ts");
    try {
      writeFileSync(entryPoint, "fixture");
      chmodSync(entryPoint, 0o644);
      await withRestoredFileMode(entryPoint, () => {
        chmodSync(entryPoint, 0o755);
        expect(statSync(entryPoint).mode & 0o777).toBe(0o755);
      });
      expect(statSync(entryPoint).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects an unknown target instead of silently building a different matrix", async () => {
    await expect(
      runReleaseArtifactBuildCli([
        "--channel",
        "dev",
        "--dry-run",
        "--target",
        "linux-riscv64",
      ]),
    ).rejects.toThrow("unsupported release target");
  });

  test("never accepts a build that skips every product artifact", async () => {
    await expect(
      runReleaseArtifactBuildCli([
        "--channel",
        "dev",
        "--dry-run",
        "--skip-cli",
        "--skip-extension",
      ]),
    ).rejects.toThrow("cannot skip both");
  });
});
