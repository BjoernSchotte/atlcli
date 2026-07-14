/**
 * Test helper: ensure the extension has been built before build-output
 * assertions run. In CI the `bun test` step can run before the `build` step,
 * so tests that inspect `.output/chrome-mv3` build on-demand (idempotent).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const EXTENSION_ROOT = join(import.meta.dir, "..");
export const OUTPUT_DIR = join(EXTENSION_ROOT, ".output", "chrome-mv3");
export const MANIFEST_PATH = join(OUTPUT_DIR, "manifest.json");

/** Build the extension if the output artifacts are missing. */
export function ensureExtensionBuilt(): void {
  if (existsSync(MANIFEST_PATH)) return;
  const res = spawnSync("bun", ["run", "build"], {
    cwd: EXTENSION_ROOT,
    stdio: "inherit",
  });
  if (res.status !== 0) {
    throw new Error(`wxt build failed (exit ${res.status})`);
  }
}
