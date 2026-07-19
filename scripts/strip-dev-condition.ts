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
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BACKUP_BASENAME = ".package.json.prepack-backup";

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

function run(mode: string, pkgDir: string): void {
  const manifestPath = join(pkgDir, "package.json");
  const backupPath = join(pkgDir, BACKUP_BASENAME);

  if (mode === "strip") {
    const original = readFileSync(manifestPath, "utf8");
    writeFileSync(backupPath, original);
    const stripped = stripManifest(JSON.parse(original) as Record<string, unknown>);
    writeFileSync(manifestPath, `${JSON.stringify(stripped, null, 2)}\n`);
    console.log(`strip-dev-condition: stripped development conditions from ${manifestPath}`);
    return;
  }

  if (mode === "restore") {
    if (!existsSync(backupPath)) {
      console.error(
        `strip-dev-condition: no backup at ${backupPath} — was 'strip' run first? Nothing restored.`,
      );
      process.exit(1);
    }
    writeFileSync(manifestPath, readFileSync(backupPath, "utf8"));
    rmSync(backupPath);
    console.log(`strip-dev-condition: restored ${manifestPath}`);
    return;
  }

  console.error(`strip-dev-condition: unknown mode "${mode}" (expected "strip" or "restore")`);
  process.exit(1);
}

if (import.meta.main) {
  run(process.argv[2] ?? "", process.cwd());
}
