import { compareVersions } from "../packages/core/src/update.js";
import { parseRootVersion } from "./release-artifacts.js";

/** Product policy only: library versions and historical artifacts retain SemVer. */
export function assertCalverVersion(version: string): string {
  if (!/^[1-9]\d{3}\.(?:[1-9]|1[0-2])\.[1-9]\d*$/.test(version)) {
    throw new Error(`Product version must be YYYY.M.N (UTC month 1..12, counter >= 1, no padding): ${version}`);
  }
  parseRootVersion(version);
  return version;
}

function stableVersion(tag: string): string | null {
  if (!tag.startsWith("v")) return null;
  const version = tag.slice(1);
  try {
    const [major] = parseRootVersion(version);
    // Pre-CalVer product tags remain valid changelog boundaries.
    if (major >= 1000) assertCalverVersion(version);
    return version;
  } catch {
    return null;
  }
}

/** Caller supplies reachable tags for a changelog, all reserved tags for allocation. */
export function previousStableTag(tags: string[]): string | null {
  const versions = tags.map(stableVersion).filter((version): version is string => version !== null);
  versions.sort(compareVersions);
  return versions.length ? `v${versions.at(-1)!}` : null;
}

export function nextCalverVersion(current: string, tags: string[], now: Date): string {
  const [major] = parseRootVersion(current);
  if (major >= 1000) assertCalverVersion(current);
  if (Number.isNaN(now.getTime())) throw new Error("Release time must be a valid instant");
  const prefix = `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}`;
  const counters = tags.map(stableVersion)
    .filter((version): version is string => version !== null && version.startsWith(`${prefix}.`))
    .map((version) => Number(version.split(".")[2]));
  const next = assertCalverVersion(`${prefix}.${counters.reduce((max, counter) => Math.max(max, counter), 0) + 1}`);
  const latestTag = previousStableTag(tags);
  for (const prior of [current, ...(latestTag ? [latestTag.slice(1)] : [])]) {
    if (compareVersions(next, prior) <= 0) {
      throw new Error(`Candidate ${next} must be newer than ${prior}; check the clock and reserved tags`);
    }
  }
  return next;
}
