#!/usr/bin/env bun
/**
 * Strip / restore the workspace-only `development` export condition (spec 009).
 *
 * The `development` condition points every `@atlcli/*` export at `./src/*.ts`
 * for in-repo DX (Bun tests, Vite dev, tsc via `customConditions`). Published
 * tarballs ship only `dist/` (see each package's `files` allowlist), so a
 * manifest that still carries `development` would contain exports targets that
 * can never resolve for an installed consumer.
 *
 * Wired as `prepack`/`postpack` in every publishable package:
 *
 *   "prepack":  "bun ../../scripts/strip-dev-condition.ts strip"
 *   "postpack": "bun ../../scripts/strip-dev-condition.ts restore"
 *
 * `strip` backs up `package.json` to `.package.json.prepack-backup`
 * (gitignored) and writes the manifest without any `development` condition;
 * `restore` puts the byte-identical original back and removes the backup, so
 * the working tree ends clean after a successful pack.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BACKUP_BASENAME = ".package.json.prepack-backup";

/**
 * Write `contents` to `path` atomically: write a uniquely-named temp file in
 * the same directory, then `rename` it over the target. `rename` within a
 * filesystem is atomic, so a concurrent reader (e.g. `bun pm pack` snapshotting
 * the manifest) always sees either the old or the new complete file — never a
 * truncated or half-written one. The backup basename stays stable (prepack and
 * postpack run as SEPARATE processes and must agree on it), so the atomicity —
 * not a per-pid name — is what prevents torn reads.
 */
function writeFileAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

/**
 * Recursively remove every `development` condition from an `exports`-shaped
 * value. Returns a new value; never mutates the input.
 */
export function stripDevelopmentConditions(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "development") continue;
    out[key] = stripDevelopmentConditions(entry);
  }
  return out;
}

/** Strip the `development` conditions from a parsed package.json manifest. */
export function stripManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...manifest };
  if (out.exports !== undefined) out.exports = stripDevelopmentConditions(out.exports);
  return out;
}

export interface StripDevConditionResult {
  /** What actually happened — restore is tolerant when there is no backup. */
  action: "stripped" | "restored" | "no-backup";
  /** True when `strip` found (and overwrote) a stale backup from an earlier failed pack. */
  staleBackupReplaced?: boolean;
}

/**
 * The real file-IO entrypoint (also used by tests). `strip` backs up and
 * strips; `restore` puts the backup back and is **idempotent** — if a pack
 * failed between prepack and postpack (so postpack never ran) a later manual
 * `restore` recovers, and a `restore` without any backup is a warning-only
 * no-op instead of an error, so recovery can never make things worse.
 */
export function runStripDevCondition(
  mode: "strip" | "restore",
  pkgDir: string,
  log: (message: string) => void = console.log,
): StripDevConditionResult {
  const manifestPath = join(pkgDir, "package.json");
  const backupPath = join(pkgDir, BACKUP_BASENAME);

  if (mode === "strip") {
    const staleBackupReplaced = existsSync(backupPath);
    if (staleBackupReplaced) {
      log(
        `strip-dev-condition: WARNING — stale backup at ${backupPath} (an earlier pack likely ` +
          `failed before postpack); overwriting it with a fresh backup of the current manifest.`,
      );
    }
    const original = readFileSync(manifestPath, "utf8");
    writeFileAtomic(backupPath, original);
    const stripped = stripManifest(JSON.parse(original) as Record<string, unknown>);
    writeFileAtomic(manifestPath, `${JSON.stringify(stripped, null, 2)}\n`);
    log(`strip-dev-condition: stripped development conditions from ${manifestPath}`);
    return { action: "stripped", staleBackupReplaced };
  }

  if (!existsSync(backupPath)) {
    log(
      `strip-dev-condition: no backup at ${backupPath} — nothing to restore (already restored?). No-op.`,
    );
    return { action: "no-backup" };
  }
  writeFileAtomic(manifestPath, readFileSync(backupPath, "utf8"));
  rmSync(backupPath);
  log(`strip-dev-condition: restored ${manifestPath}`);
  return { action: "restored" };
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "";
  if (mode !== "strip" && mode !== "restore") {
    console.error(`strip-dev-condition: unknown mode "${mode}" (expected "strip" or "restore")`);
    process.exit(1);
  }
  runStripDevCondition(mode, process.cwd());
}
