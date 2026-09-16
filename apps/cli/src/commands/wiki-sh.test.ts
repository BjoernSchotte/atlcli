/**
 * Flag and config resolution for `atlcli wiki sh` (WP6.6, WP6.7).
 *
 * `resolveShellOptions` is pure, so this is a unit test — deliberately, because
 * the thing worth pinning is the *precedence*, and precedence bugs are exactly
 * what an end-to-end test would hide behind a working happy path.
 */
import { describe, expect, it } from "bun:test";
import type { Config, Profile } from "@atlcli/core";
import { DEFAULT_CACHE_DIR, resolveShellOptions, wikiShHelp } from "./wiki-sh.js";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: "mayflower",
    baseUrl: "https://example.atlassian.net/wiki",
    auth: { type: "apiToken", email: "a@b.c", token: "t" },
    ...overrides,
  };
}

function config(overrides: Partial<Config> = {}): Config {
  return { profiles: { mayflower: profile() }, currentProfile: "mayflower", ...overrides };
}

function resolve(
  flags: Record<string, string | boolean | string[]>,
  overrides: { config?: Config; profile?: Profile } = {},
) {
  const cfg = overrides.config ?? config();
  const prof = overrides.profile ?? profile();
  return resolveShellOptions([], flags, { config: cfg, profile: prof, profileName: prof.name });
}

describe("mode", () => {
  it("defaults to ro, so writing is always a choice", () => {
    expect(resolve({}).mode).toBe("ro");
  });

  it("takes rw from the flag", () => {
    expect(resolve({ mode: "rw" }).mode).toBe("rw");
  });

  it("takes rw from the profile config", () => {
    expect(resolve({}, { profile: profile({ vfs: { mode: "rw" } }) }).mode).toBe("rw");
  });

  it("lets an explicit --mode ro override a config that says rw", () => {
    expect(
      resolve({ mode: "ro" }, { profile: profile({ vfs: { mode: "rw" } }) }).mode,
    ).toBe("ro");
  });

  it("ignores a mode value it does not recognise rather than guessing", () => {
    expect(resolve({ mode: "readwrite" }).mode).toBe("ro");
  });

  it("never enables delete implicitly", () => {
    expect(resolve({ mode: "rw" }).allowDelete).toBe(false);
    expect(resolve({ mode: "rw", "allow-delete": true }).allowDelete).toBe(true);
  });
});

describe("spaces", () => {
  it("splits a comma-separated flag", () => {
    expect(resolve({ space: "DOCSY, TEAM ,OPS" }).spaces).toEqual(["DOCSY", "TEAM", "OPS"]);
  });

  it("falls back to the configured vfs spaces", () => {
    expect(resolve({}, { profile: profile({ vfs: { spaces: ["A", "B"] } }) }).spaces).toEqual([
      "A",
      "B",
    ]);
  });

  it("falls back to the profile's default space", () => {
    expect(resolve({}, { profile: profile({ space: "DOCSY" }) }).spaces).toEqual(["DOCSY"]);
  });

  it("ends up empty when nothing names a space, so the command can say so", () => {
    expect(resolve({}).spaces).toEqual([]);
  });
});

describe("cache and budgets", () => {
  it("defaults the cache directory", () => {
    expect(resolve({}).cacheDir).toBe(DEFAULT_CACHE_DIR);
  });

  it("prefers the flag, then the profile, then the global config", () => {
    expect(resolve({ "cache-dir": "/flag" }).cacheDir).toBe("/flag");
    expect(resolve({}, { profile: profile({ vfs: { cacheDir: "/profile" } }) }).cacheDir).toBe(
      "/profile",
    );
    expect(
      resolve({}, { config: config({ vfs: { cacheDir: "/global" } }) }).cacheDir,
    ).toBe("/global");
    // A profile value wins over a global one.
    expect(
      resolve(
        {},
        {
          config: config({ vfs: { cacheDir: "/global" } }),
          profile: profile({ vfs: { cacheDir: "/profile" } }),
        },
      ).cacheDir,
    ).toBe("/profile");
  });

  it("reads the numeric budgets, ignoring nonsense", () => {
    expect(resolve({ "prefetch-max": "500" }).prefetchMax).toBe(500);
    expect(resolve({ "cache-max-mb": "250" }).cacheMaxMb).toBe(250);
    expect(resolve({ "prefetch-max": "nope" }).prefetchMax).toBeUndefined();
    expect(resolve({ "prefetch-max": "-5" }).prefetchMax).toBeUndefined();
  });

  it("lets a global config set the budgets", () => {
    const resolved = resolve(
      {},
      { config: config({ vfs: { prefetchMaxPages: 42, cacheMaxMb: 7 } }) },
    );
    expect(resolved.prefetchMax).toBe(42);
    expect(resolved.cacheMaxMb).toBe(7);
  });
});

describe("the CQL shortcut switch", () => {
  it("is on by default and off behind --no-cql", () => {
    expect(resolve({}).cqlGrep).toBe(true);
    expect(resolve({ "no-cql": true }).cqlGrep).toBe(false);
  });

  it("can be turned off in the config", () => {
    expect(resolve({}, { profile: profile({ vfs: { cqlGrep: false } }) }).cqlGrep).toBe(false);
  });
});

describe("script selection", () => {
  it("takes -c", () => {
    expect(resolve({ c: "ls -R" }).script).toBe("ls -R");
  });

  it("takes positional arguments when -c is absent", () => {
    const resolved = resolveShellOptions(["ls", "-R"], {}, {
      config: config(),
      profile: profile(),
      profileName: "mayflower",
    });
    expect(resolved.script).toBe("ls -R");
  });
});

describe("help", () => {
  it("names the flags the plan requires", () => {
    const help = wikiShHelp();
    for (const flag of [
      "--space",
      "-c ",
      "--mode ro|rw",
      "--allow-delete",
      "--cache-dir",
      "--offline",
      "--cwd",
      "--timeout",
      "--prefetch-max",
      "--no-cql",
      "--json",
    ]) {
      expect(help).toContain(flag);
    }
  });

  it("says writing is off by default and explains bounded grep", () => {
    const help = wikiShHelp();
    expect(help).toContain("Writing is off by default");
    expect(help).toContain("bounded bulk prefetch");
    expect(help).toContain("CQL narrowing is disabled");
  });

  it("lists the extra commands", () => {
    const help = wikiShHelp();
    for (const command of ["cql ", "page-id", "page-url", "vfs-status"]) {
      expect(help).toContain(command);
    }
  });
});
