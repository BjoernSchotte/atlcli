import { describe, expect, test } from "bun:test";
import type { CommandContext } from "@atlcli/plugin-api";
import { pushDirectoryFrom, directoryFrom } from "./index.js";

/**
 * Build a CommandContext the way apps/cli/src/index.ts does for beforeCommand
 * hooks. For `atlcli wiki docs push ./docs` the top-level context is built as:
 *
 *   command: ["wiki", "docs", "push", "./docs"]
 *   args:    ["docs", "push", "./docs"]   // full rest, NOT sliced
 *
 * (see apps/cli/src/index.ts:104-114). The plugin-command path slices the
 * subcommand off, but the hook path does not.
 */
function hookContext(command: string[], args: string[]): CommandContext {
  return {
    command,
    args,
    flags: {},
    output: { json: false },
  };
}

describe("drawio plugin wiki docs push hook", () => {
  test("resolves the real push target directory, not the literal 'docs' subcommand", () => {
    // `atlcli wiki docs push ./docs`
    const ctx = hookContext(["wiki", "docs", "push", "./docs"], ["docs", "push", "./docs"]);

    // BUG: pushDirectoryFrom reads context.args[0] which is the literal "docs"
    // subcommand, not the real target directory "./docs".
    expect(pushDirectoryFrom(ctx)).toBe("./docs");
  });

  test("resolves a custom push target directory", () => {
    // `atlcli wiki docs push .`
    const ctx = hookContext(["wiki", "docs", "push", "."], ["docs", "push", "."]);

    expect(pushDirectoryFrom(ctx)).toBe(".");
  });

  test("resolves the parent directory when the target is a single .md file", () => {
    // `atlcli wiki docs push ./guide/readme.md`
    const ctx = hookContext(
      ["wiki", "docs", "push", "./guide/readme.md"],
      ["docs", "push", "./guide/readme.md"],
    );

    expect(pushDirectoryFrom(ctx)).toBe("./guide");
  });

  test("directoryFrom reads the first positional arg for drawio preview/watch", () => {
    // `atlcli drawio preview ./diagrams`
    const ctx = hookContext(["drawio", "preview"], ["./diagrams"]);

    expect(directoryFrom(ctx)).toBe("./diagrams");
  });
});