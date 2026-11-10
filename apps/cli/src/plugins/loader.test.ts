import { describe, expect, test } from "bun:test";
import { UsageError } from "@atlcli/core";
import type { CommandDefinition } from "@atlcli/plugin-api";
import { getBuiltinPlugin, pluginCommandHelp, resolvePluginInvocation } from "./loader.js";

const handler = async () => {};
const cmd: CommandDefinition = {
  name: "demo",
  description: "Demo command",
  flags: [{ name: "verbose", alias: "v", description: "Verbose" }],
  subcommands: [
    {
      name: "run",
      description: "Run it",
      flags: [
        { name: "check", alias: "c", description: "Check only" },
        { name: "out", alias: "o", description: "Output file", hasValue: true, default: "out.txt" },
        { name: "token", description: "Token", hasValue: true, required: true },
      ],
      handler,
    },
  ],
};

describe("resolvePluginInvocation", () => {
  test("a switch does not swallow the positional after it, in either spelling", () => {
    for (const flag of ["--check", "-c"]) {
      const result = resolvePluginInvocation(cmd, ["demo", "run", flag, "docs", "--token", "t", "more"]);
      expect(result.subcommand?.name).toBe("run");
      expect(result.args).toEqual(["docs", "more"]);
      expect(result.flags.check).toBe(true);
    }
  });

  test("a switch before the subcommand does not hide the subcommand", () => {
    const result = resolvePluginInvocation(cmd, ["demo", "--verbose", "run", "--token", "t"]);
    expect(result.subcommand?.name).toBe("run");
    expect(result.flags.verbose).toBe(true);
  });

  test("an alias sets the named flag and a default fills an absent one", () => {
    const aliased = resolvePluginInvocation(cmd, ["demo", "run", "-o", "a.txt", "--token", "t"]);
    expect(aliased.flags.out).toBe("a.txt");
    expect(resolvePluginInvocation(cmd, ["demo", "run", "--token", "t"]).flags.out).toBe("out.txt");
  });

  test("a missing required flag and a value flag without a value are usage errors", () => {
    expect(() => resolvePluginInvocation(cmd, ["demo", "run"])).toThrow(UsageError);
    expect(() => resolvePluginInvocation(cmd, ["demo", "run", "--token"])).toThrow("--token needs a value");
  });

  test("without a matching subcommand every argument stays positional", () => {
    const result = resolvePluginInvocation(cmd, ["demo", "other", "x"]);
    expect(result.subcommand).toBeUndefined();
    expect(result.args).toEqual(["other", "x"]);
  });

  test("the bundled git plugin reads -f as --force and keeps the directory", () => {
    const git = getBuiltinPlugin("git")!.commands![0]!;
    const result = resolvePluginInvocation(git, ["git", "hook", "install", "-f", "docs"]);
    expect(result.args).toEqual(["install", "docs"]);
    expect(result.flags.force).toBe(true);
  });
});

test("pluginCommandHelp lists subcommand and command flags", () => {
  const help = pluginCommandHelp(cmd);
  expect(help).toContain("atlcli demo <subcommand>");
  expect(help).toContain("--out, -o <value>");
  expect(help).toContain("(default: out.txt)");
  expect(help).toContain("--token <value>");
  expect(help).toContain("(required)");
  expect(help).toContain("--verbose, -v");
});

test("bundled plugin versions match their package.json", async () => {
  for (const name of ["git", "drawio"]) {
    const manifest = await Bun.file(new URL(`../../../../plugins/plugin-${name}/package.json`, import.meta.url)).json();
    expect(getBuiltinPlugin(name)!.version).toBe(manifest.version);
  }
});
