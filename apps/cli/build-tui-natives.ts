/**
 * OpenTUI loads its native library from one optional package per platform
 * (`@opentui/core-linux-x64`, `…-musl`, `…-win32-x64`, …), chosen at run
 * time. A bundle must resolve every one it references, but an install only
 * holds its own platform's. So builds mark the missing ones external: what is
 * installed is embedded, the rest would only fail inside `atlcli tui` on that
 * platform. Release builds check that their target's package is there.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The platform packages `@opentui/core` can load, from its optional dependencies. */
export function opentuiNativePackages(root = REPO_ROOT): string[] {
  const manifest = join(root, "node_modules/@opentui/core/package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { optionalDependencies?: Record<string, string> };
  return Object.keys(pkg.optionalDependencies ?? {}).filter((name) => name.startsWith("@opentui/core-"));
}

export const isInstalled = (name: string, root = REPO_ROOT) => existsSync(join(root, "node_modules", name, "package.json"));

/** `--external` flags for the platform packages this install does not hold. */
export function missingNativeExternals(root = REPO_ROOT): string[] {
  return opentuiNativePackages(root)
    .filter((name) => !isInstalled(name, root))
    .flatMap((name) => ["--external", name]);
}

/** The package a release target needs embedded (`windows-x64` → `@opentui/core-win32-x64`). */
export function nativePackageFor(target: string): string {
  return `@opentui/core-${target.replace(/^windows-/, "win32-")}`;
}

/** Fails a release build whose target would ship a TUI without its native library. */
export function assertNativeFor(target: string, root = REPO_ROOT): void {
  const name = nativePackageFor(target);
  if (!isInstalled(name, root)) {
    throw new Error(`${name} is not installed, so the ${target} binary would ship a TUI that cannot start. Run: bun install --frozen-lockfile --os='*' --cpu='*'`);
  }
}
