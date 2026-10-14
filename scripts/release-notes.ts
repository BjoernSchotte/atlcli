#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { assertCalverVersion } from "./release-version.js";

/** Preserve reviewed migration notes; never substitute a raw commit list. */
export function extractChangelogSection(changelog: string, version: string): string {
  const headings = [...changelog.matchAll(/^## \[([^\]\r\n]+)\][^\r\n]*\r?$/gm)];
  const matches = headings.filter((heading) => heading[1] === version || heading[1] === `v${version}`);
  if (matches.length !== 1) throw new Error(`Expected exactly one CHANGELOG section for ${version}`);
  const heading = matches[0]!;
  const next = headings[headings.indexOf(heading) + 1];
  return changelog.slice(heading.index, next?.index ?? changelog.length).trim();
}

export function renderReleaseNotes(changelog: string, version: string, checksums: string): string {
  assertCalverVersion(version);
  return `${extractChangelogSection(changelog, version)}

## Checksums

\`\`\`
${checksums.trim()}
\`\`\`

## Installation

### Homebrew (macOS/Linux)

\`\`\`bash
brew install bjoernschotte/tap/atlcli
\`\`\`

### Manual Download

Download the appropriate CLI archive or the packaged Chrome MV3 extension.
`;
}

if (import.meta.main) {
  const [version, changelogPath, checksumPath, outputPath] = process.argv.slice(2);
  if (process.argv.length !== 6 || !version || !changelogPath || !checksumPath || !outputPath) {
    throw new Error("Usage: bun scripts/release-notes.ts <version> <changelog> <checksums> <output>");
  }
  const [changelog, checksums] = await Promise.all([
    readFile(changelogPath, "utf8"), readFile(checksumPath, "utf8"),
  ]);
  await writeFile(outputPath, renderReleaseNotes(changelog, version, checksums));
}
