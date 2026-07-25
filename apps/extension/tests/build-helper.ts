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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const EXTENSION_ROOT = join(import.meta.dir, "..");
export const OUTPUT_DIR = join(EXTENSION_ROOT, ".output", "chrome-mv3");
export const MANIFEST_PATH = join(OUTPUT_DIR, "manifest.json");
const BUILD_LOCK_DIR = join(
  tmpdir(),
  `atlcli-extension-build-${createHash("sha256").update(EXTENSION_ROOT).digest("hex").slice(0, 16)}`
);
const BUILD_LOCK_OWNER = join(BUILD_LOCK_DIR, "owner");
const BUILD_WAIT_TIMEOUT_MS = 180_000;
const BUILD_WAIT_INTERVAL_MS = 100;
const BUILD_LOCK_INITIALIZATION_GRACE_MS = 5_000;

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

function outputIsStale(): boolean {
  const manifestMtime = existsSync(MANIFEST_PATH)
    ? statSync(MANIFEST_PATH).mtimeMs
    : null;
  const sourceMtimes = BUILD_INPUTS.flatMap((p) =>
    collectMtimes(join(EXTENSION_ROOT, p))
  );
  return isBuildStale(manifestMtime, sourceMtimes);
}

function ownerIsAlive(): boolean {
  try {
    const pid = Number.parseInt(readFileSync(BUILD_LOCK_OWNER, "utf8"), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    // mkdir and writing the owner file are separate syscalls. Treat a brand-new
    // ownerless lock as active so a contender cannot delete it in that gap.
    try {
      return Date.now() - statSync(BUILD_LOCK_DIR).mtimeMs < BUILD_LOCK_INITIALIZATION_GRACE_MS;
    } catch {
      return false;
    }
  }
}

function acquireBuildLock(): void {
  const deadline = Date.now() + BUILD_WAIT_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(BUILD_LOCK_DIR);
      writeFileSync(BUILD_LOCK_OWNER, String(process.pid));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    // Another test file may have completed the shared build while this file
    // waited. Re-check the real output instead of starting a redundant build.
    if (!outputIsStale()) return;

    // A timed-out test process cannot clean up its lock. Reclaim it when its
    // recorded owner no longer exists, so the next run does not hang.
    if (!ownerIsAlive()) {
      rmSync(BUILD_LOCK_DIR, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting ${BUILD_WAIT_TIMEOUT_MS}ms for extension build lock`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BUILD_WAIT_INTERVAL_MS);
  }
}

export function formatBuildFailure(status: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `wxt build was killed by ${signal}`;
  return `wxt build failed (exit ${status ?? "unknown"})`;
}

/** Build the extension if the output is missing or stale. */
export function ensureExtensionBuilt(): void {
  if (!outputIsStale()) return;

  acquireBuildLock();
  // A waiter returns from acquireBuildLock without owning the lock when the
  // other file has already produced fresh output.
  if (!existsSync(BUILD_LOCK_OWNER) || readFileSync(BUILD_LOCK_OWNER, "utf8") !== String(process.pid)) {
    return;
  }

  try {
    // Sources or output may have changed between the first check and lock
    // acquisition. Only the lock owner is allowed to launch WXT.
    if (!outputIsStale()) return;
    const res = spawnSync("bun", ["run", "build"], {
      cwd: EXTENSION_ROOT,
      stdio: "inherit",
    });
    if (res.status !== 0) {
      throw new Error(formatBuildFailure(res.status, res.signal));
    }
  } finally {
    rmSync(BUILD_LOCK_DIR, { recursive: true, force: true });
  }
}
