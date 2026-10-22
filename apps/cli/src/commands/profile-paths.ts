import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * `~/.atlcli/profiles/<profile>/<file>`. A profile name that is not a plain
 * path segment is percent-encoded, so `../x` cannot leave the profiles
 * directory. `homedir()` is read at call time.
 */
export function profileFilePath(profile: string, file: string): string {
  const safe = /^[A-Za-z0-9._-]+$/.test(profile) && profile !== "." && profile !== ".."
    ? profile
    : encodeURIComponent(profile).replace(/\./g, "%2E");
  return join(homedir(), ".atlcli", "profiles", safe, file);
}

/** JSON to a temporary file in the same directory, then rename (as `writeResearchMarkdownAtomic`). */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
