/**
 * Test helper: ensure the extension has been built (and is up to date) before
 * build-output assertions run. In CI the `bun test` step can run before the
 * `build` step, so tests that inspect `.output/chrome-mv3` build on-demand.
 *
 * The build is reused only when it is NOT stale: a rebuild is forced when any
 * build input (extension sources plus every consumed workspace source and
 * runtime asset) is newer than the emitted manifest — otherwise a stale `.output`
 * from an earlier source revision would be asserted against.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const EXTENSION_ROOT = join(import.meta.dir, "..");
export const OUTPUT_DIR = join(EXTENSION_ROOT, ".output", "chrome-mv3");
export const MANIFEST_PATH = join(OUTPUT_DIR, "manifest.json");

/** Build inputs (relative to the extension root) that invalidate the output. */
export const BUILD_INPUTS = [
  "wxt.config.ts",
  "package.json",
  // Spec 010 Phase 0 added a components tree and a Tailwind stylesheet. Without
  // them here, editing only a component would leave a stale `.output` for every
  // build-output assertion to pass against.
  "postcss.config.mjs",
  "components",
  "assets",
  "entrypoints",
  "utils",
  "workers",
  "types",
  "../../packages/core/src",
  "../../packages/confluence/src",
  "../../packages/diagram/src",
  "../../packages/docx/src",
  "../../packages/docx/package.json",
  "../../packages/export-jobs/src",
  "../../packages/export-jobs/package.json",
  "../../packages/pdf/src",
  "../../packages/pdf-compiler-browser/src",
  "../../packages/pdf/scripts/ensure-fonts.ts",
  "../../packages/pdf/.fonts",
  "../../packages/pdf/licenses",
  "../../LICENSE",
];

/**
 * Pure decision: is the built output stale relative to its sources?
 * `manifestMtimeMs === null` means no build exists yet (always stale). A build
 * is stale iff any source mtime is strictly newer than the manifest's.
 */
export function isBuildStale(
  manifestMtimeMs: number | null,
  sourceMtimesMs: number[]
): boolean {
  if (manifestMtimeMs === null) return true;
  return sourceMtimesMs.some((m) => m > manifestMtimeMs);
}

/** Collect mtimes of `path` recursively (file → [mtime], dir → all descendants). */
export function collectMtimes(path: string): number[] {
  if (!existsSync(path)) return [];
  const st = statSync(path);
  if (st.isDirectory()) {
    return readdirSync(path).flatMap((name) => collectMtimes(join(path, name)));
  }
  return [st.mtimeMs];
}

/** Build the extension if the output is missing or stale. */
export function ensureExtensionBuilt(): void {
  const manifestMtime = existsSync(MANIFEST_PATH)
    ? statSync(MANIFEST_PATH).mtimeMs
    : null;
  const sourceMtimes = BUILD_INPUTS.flatMap((p) =>
    collectMtimes(join(EXTENSION_ROOT, p))
  );

  if (!isBuildStale(manifestMtime, sourceMtimes)) return;

  const res = spawnSync("bun", ["run", "build"], {
    cwd: EXTENSION_ROOT,
    stdio: "inherit",
  });
  if (res.status !== 0) {
    throw new Error(`wxt build failed (exit ${res.status})`);
  }
}
