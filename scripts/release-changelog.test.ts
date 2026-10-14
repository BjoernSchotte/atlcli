import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateChangelog } from "./release.js";
import { extractChangelogSection } from "./release-notes.js";

// Integration with the real git-cliff executable; bunx may need to download it.
// ATLCLI_RELEASE_E2E=1 bun run test scripts/release-changelog.test.ts
describe.skipIf(process.env.ATLCLI_RELEASE_E2E !== "1")("release changelog E2E", () => {
  let directory: string;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function git(...args: string[]): Promise<void> {
    const process = Bun.spawn(["git", ...args], {
      cwd: directory,
      env: { ...Bun.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      stdout: "pipe", stderr: "pipe",
    });
    const stderr = await new Response(process.stderr).text();
    if (await process.exited) throw new Error(stderr);
  }

  test("uses stable ancestry, retains manual history, and shows both breaking forms", async () => {
    directory = await mkdtemp(join(tmpdir(), "atlcli-calver-changelog-"));
    await git("init");
    await git("config", "user.name", "Release Test");
    await git("config", "user.email", "release-test@example.com");
    await copyFile(join(import.meta.dir, "../cliff.toml"), join(directory, "cliff.toml"));
    const history = "# Changelog\n\nAll notable changes to atlcli will be documented in this file.\n\n" +
      "## [Unreleased]\n\n### Migration\n\nUpdate your config before upgrading.\n\n" +
      "## [0.17.2] - 2026-08-01\n\nManual historical migration note.\n";
    const changelogPath = join(directory, "CHANGELOG.md");
    await writeFile(changelogPath, history);
    await git("add", ".");
    await git("commit", "-m", "fix: OLD_RELEASE_ENTRY");
    await git("tag", "v0.17.2");
    await git("commit", "--allow-empty", "-m", "feat(cli)!: rename old flag");
    await git("tag", "dev-20261014.4.1-aaaaaaaa");
    await git("commit", "--allow-empty", "-m", "fix(cli): change a default", "-m",
      "BREAKING CHANGE: Replace --old with --new in every script.");
    await git("commit", "--allow-empty", "-m", "feat: NEW_FEATURE_ENTRY");
    await generateChangelog("2026.10.1", changelogPath, directory);
    const changelog = await readFile(changelogPath, "utf8");
    expect(changelog).toContain("### Breaking changes");
    expect(changelog).toContain("Rename old flag");
    expect(changelog).toContain("Replace --old with --new in every script.");
    expect(changelog.indexOf("### Breaking changes")).toBeLessThan(changelog.indexOf("### Features"));
    expect(changelog).toContain("NEW_FEATURE_ENTRY");
    expect(changelog).not.toContain("OLD_RELEASE_ENTRY");
    expect(changelog).not.toContain("dev-20261014");
    expect(changelog).toContain("## [0.17.2] - 2026-08-01\n\nManual historical migration note.\n");
    expect(changelog).not.toContain("[Unreleased]");
    expect(extractChangelogSection(changelog, "2026.10.1")).toContain("Update your config before upgrading.");
    expect(changelog.match(/^# Changelog$/gm)).toHaveLength(1);
    expect(changelog.match(/## \[2026\.10\.1\]/g)).toHaveLength(1);

    // Exercise the complete read-only preview on a dirty fixture branch.
    await writeFile(changelogPath, history);
    await writeFile(join(directory, "package.json"), '{"version":"0.17.2"}\n');
    const before = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: directory }).stdout.toString();
    const preview = Bun.spawn(["bun", join(import.meta.dir, "release.ts"), "--preview"], {
      cwd: directory, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(preview.stdout).text(), new Response(preview.stderr).text(), preview.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("Update your config before upgrading.");
    expect(stdout).toContain("PREVIEW ONLY");
    expect(await readFile(changelogPath, "utf8")).toBe(history);
    expect(await readFile(join(directory, "package.json"), "utf8")).toBe('{"version":"0.17.2"}\n');
    expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: directory }).stdout.toString()).toBe(before);
  }, 30_000);
});
