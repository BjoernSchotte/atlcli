import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packagePrebuiltExtension } from "./package-release";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const ENVIRONMENT = {
  ATLCLI_RELEASE_CHANNEL: "dev",
  ATLCLI_SOURCE_SHA: SHA,
  ATLCLI_BUILD_ID: "dev-20260812.418.2-01234567",
  ATLCLI_EXTENSION_VERSION: "0.17.2.418",
  ATLCLI_EXTENSION_VERSION_NAME: "0.17.2-dev.20260812.418.2-01234567",
};

describe("prebuilt extension release packaging", () => {
  test("normalizes the WXT output deterministically without rebuilding it", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlcli-extension-package-"));
    const input = join(root, "chrome-mv3");
    const output = join(root, "artifacts");
    try {
      await Bun.write(
        join(input, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          version: ENVIRONMENT.ATLCLI_EXTENSION_VERSION,
          version_name: ENVIRONMENT.ATLCLI_EXTENSION_VERSION_NAME,
        }),
      );
      await Bun.write(join(input, "nested", "worker.js"), "export default 42;\n");

      const first = await packagePrebuiltExtension({
        inputDirectory: input,
        outputDirectory: output,
        environment: ENVIRONMENT,
      });
      const inputBefore = readFileSync(join(input, "nested", "worker.js"));
      const firstBytes = readFileSync(first.artifactPath);
      const second = await packagePrebuiltExtension({
        inputDirectory: input,
        outputDirectory: output,
        environment: ENVIRONMENT,
      });

      expect(readFileSync(join(input, "nested", "worker.js"))).toEqual(inputBefore);
      expect(readFileSync(second.artifactPath)).toEqual(firstBytes);
      expect(second.artifactSha256).toBe(first.artifactSha256);
      expect(second.contentTreeSha256).toBe(first.contentTreeSha256);
      expect(second.fileCount).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects manifest and WXT artifact-name drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlcli-extension-package-drift-"));
    try {
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({ version: "0.17.2.419", version_name: "wrong" }),
      );
      await expect(
        packagePrebuiltExtension({
          inputDirectory: root,
          outputDirectory: join(root, "artifacts"),
          environment: ENVIRONMENT,
        }),
      ).rejects.toThrow("manifest identity mismatch");

      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({
          version: ENVIRONMENT.ATLCLI_EXTENSION_VERSION,
          version_name: ENVIRONMENT.ATLCLI_EXTENSION_VERSION_NAME,
        }),
      );
      await expect(
        packagePrebuiltExtension({
          inputDirectory: root,
          artifactPath: join(root, "wrong-name.zip"),
          environment: ENVIRONMENT,
        }),
      ).rejects.toThrow("artifact name mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
