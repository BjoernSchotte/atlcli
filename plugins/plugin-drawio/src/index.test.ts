import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandContext } from "@atlcli/plugin-api";
import { pushDirectoryFrom, directoryFrom, watchHandler, watchSourcePath } from "./index.js";

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
function hookContext(
  command: string[],
  args: string[],
  flags: CommandContext["flags"] = {},
): CommandContext {
  return {
    command,
    args,
    flags,
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

  test("resolves --dir when no positional push target was supplied", () => {
    const ctx = hookContext(["wiki", "docs", "push"], ["docs", "push"], { dir: "./docs" });
    expect(pushDirectoryFrom(ctx)).toBe("./docs");
  });

  test("uses the initialized root for --page-id from a nested directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-drawio-hook-"));
    try {
      const nested = join(root, "nested");
      await mkdir(join(root, ".atlcli"));
      await mkdir(nested);
      const ctx = hookContext(["wiki", "docs", "push"], ["docs", "push"], { "page-id": "123", dir: nested });
      expect(pushDirectoryFrom(ctx)).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  test("watch events resolve relative directories exactly once", () => {
    expect(watchSourcePath("./docs", "nested/a.drawio")).toBe(resolve("./docs/nested/a.drawio"));
  });

  test("watch resolves and closes when the watcher emits an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-drawio-watch-"));
    try {
      const emitter = new EventEmitter() as EventEmitter & { close: () => void };
      let closed = false;
      emitter.close = () => { closed = true; };
      const ctx = hookContext(["drawio", "watch"], [root]);
      const run = watchHandler(ctx, (() => {
        setTimeout(() => emitter.emit("error", new Error("watch failed")), 0);
        return emitter as unknown as FSWatcher;
      }));
      await run;
      expect(closed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
