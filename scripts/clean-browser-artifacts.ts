import { rmSync } from "node:fs";
import { join, resolve } from "node:path";

export type BrowserArtifactTarget = "all" | "extension" | "harness";

export function browserArtifactPaths(
  repositoryRoot: string,
  target: BrowserArtifactTarget = "all"
): string[] {
  const root = resolve(repositoryRoot);
  const paths = {
    extension: join(root, "apps", "extension", ".output"),
    harness: join(root, "apps", "browser-export-harness", "dist"),
  };
  return target === "all" ? [paths.extension, paths.harness] : [paths[target]];
}

export function cleanBrowserArtifacts(
  repositoryRoot: string,
  target: BrowserArtifactTarget = "all"
): void {
  for (const path of browserArtifactPaths(repositoryRoot, target)) {
    rmSync(path, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const rawTarget = process.argv[2] ?? "all";
  if (rawTarget !== "all" && rawTarget !== "extension" && rawTarget !== "harness") {
    throw new Error(`Unknown browser artifact target: ${rawTarget}`);
  }
  cleanBrowserArtifacts(join(import.meta.dir, ".."), rawTarget);
  console.log(`Cleaned generated browser artifacts (${rawTarget}).`);
}
