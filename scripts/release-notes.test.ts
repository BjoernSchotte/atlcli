import { describe, expect, test } from "bun:test";
import { extractChangelogSection, renderReleaseNotes } from "./release-notes.js";

const CHANGELOG = `# Changelog

## [unreleased]
Future work.

## [2026.10.1] - 2026-10-14
### Breaking changes
- Rename --old to --new. Migrate your scripts.

### Thanks
- @contributor

## [0.17.2] - 2026-08-01
Previous release.
`;

describe("stable release notes", () => {
  test("keeps exactly the requested changelog entry and its migration notes", () => {
    const section = extractChangelogSection(CHANGELOG, "2026.10.1");
    expect(section).toStartWith("## [2026.10.1]");
    expect(section).toContain("Migrate your scripts.");
    expect(section).toContain("@contributor");
    expect(section).not.toContain("Future work");
    expect(section).not.toContain("Previous release");
    expect(extractChangelogSection("## [v2026.10.1]\r\nHello\r\n", "2026.10.1")).toContain("Hello");
  });

  test("fails closed for absent or duplicate version sections", () => {
    expect(() => extractChangelogSection(CHANGELOG, "2026.10.2")).toThrow("exactly one");
    expect(() => extractChangelogSection(`${CHANGELOG}\n## [2026.10.1]\nDuplicate`, "2026.10.1"))
      .toThrow("exactly one");
  });

  test("adds checksums and installation instructions to the reviewed notes", () => {
    const notes = renderReleaseNotes(CHANGELOG, "2026.10.1", "abc  atlcli-linux-x64.tar.gz\n");
    expect(notes).toContain("### Breaking changes");
    expect(notes).toContain("## Checksums\n\n```\nabc  atlcli-linux-x64.tar.gz\n```");
    expect(notes).toContain("brew install bjoernschotte/tap/atlcli");
    expect(notes).toContain("Chrome MV3 extension");
    expect(() => renderReleaseNotes(CHANGELOG, "2026.13.1", "checksum")).toThrow();
  });
});
