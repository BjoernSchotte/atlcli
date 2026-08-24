import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { AtlcliPlugin, CommandContext } from "@atlcli/plugin-api";
import { renderDrawioPreviews, renderDrawioPreview, type PreviewOptions, type PreviewResult } from "./preview.js";

function optionsFrom(context: CommandContext): PreviewOptions {
  return {
    executable: typeof context.flags.executable === "string" ? context.flags.executable : undefined,
    force: context.flags.force === true,
  };
}

export function directoryFrom(context: CommandContext): string {
  return typeof context.args[0] === "string" ? context.args[0] : process.cwd();
}

/** The docs directory targeted by `wiki docs push`, derived from its positional args. */
export function pushDirectoryFrom(context: CommandContext): string {
  // The beforeCommand hook receives the top-level context where `args` still
  // contains the full subcommand path (e.g. ["docs", "push", "./docs"]), so
  // args[0] is the literal "docs" subcommand, not the target directory. The
  // real target is the 4th element of the command path: ["wiki","docs","push",<target>].
  const positional = context.command.slice(3)[0];
  const flagDirectory = typeof context.flags.dir === "string" ? context.flags.dir : undefined;
  const target = positional ?? flagDirectory ?? process.cwd();

  // `--page-id` resolves a file from .atlcli state later in the command. The
  // hook deliberately avoids duplicating that state contract; scanning the
  // initialized root is conservative and guarantees the selected page is in
  // scope even when the command starts in a nested directory.
  if (typeof context.flags["page-id"] === "string") {
    let current = resolve(extname(target).toLowerCase() === ".md" ? dirname(target) : target);
    while (true) {
      if (existsSync(join(current, ".atlcli"))) return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return extname(target).toLowerCase() === ".md" ? dirname(target) : target;
}

function writeResults(context: CommandContext, results: PreviewResult[]): void {
  const summary = {
    rendered: results.filter((result) => result.status === "rendered").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };

  if (context.output.json) {
    console.log(JSON.stringify(summary));
    return;
  }

  for (const result of results) {
    const detail = result.message ? `: ${result.message}` : "";
    console.log(`${result.status}: ${result.source}${detail}`);
  }
  console.log(`Draw.io previews: ${summary.rendered} rendered, ${summary.skipped} current, ${summary.failed} failed`);
}

async function previewHandler(context: CommandContext): Promise<void> {
  const results = await renderDrawioPreviews(directoryFrom(context), optionsFrom(context));
  writeResults(context, results);
  if (context.flags.check === true && results.some((result) => result.status !== "skipped")) {
    process.exitCode = 1;
  }
}

type WatchFactory = (directory: string, options: { recursive: true }) => FSWatcher;

export function watchSourcePath(directory: string, filename: string): string {
  return join(resolve(directory), filename);
}

export async function watchHandler(
  context: CommandContext,
  watchFactory: WatchFactory = watch as WatchFactory,
): Promise<void> {
  const directory = resolve(directoryFrom(context));
  const options = optionsFrom(context);
  writeResults(context, await renderDrawioPreviews(directory, options));
  if (!context.output.json) console.log(`Watching Draw.io files in ${directory}`);

  const watcher = watchFactory(directory, { recursive: true });
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const flushPending = () => {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  };

  // fs.watch emits "rename" for newly created files and "change" for edits.
  // Handle both so a brand-new .drawio file triggers a preview immediately.
  watcher.on("change", (_event, filename) => {
    if (!filename || !filename.toString().toLowerCase().endsWith(".drawio")) return;
    const source = watchSourcePath(directory, filename.toString());
    const existing = pending.get(source);
    if (existing) clearTimeout(existing);
    pending.set(source, setTimeout(async () => {
      pending.delete(source);
      writeResults(context, [await renderDrawioPreview(source, options)]);
    }, 150));
  });

  // Handle SIGINT/SIGTERM/SIGHUP so `kill <pid>` and container shutdown exit
  // cleanly instead of leaking the watcher.
  await new Promise<void>((resolveDone) => {
    let settled = false;
    const onSignal = () => shutdown();
    const shutdown = () => {
      if (settled) return;
      settled = true;
      flushPending();
      watcher.close();
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      resolveDone();
    };

    watcher.on("error", (error) => {
      console.error(`Draw.io watch error: ${error.message}`);
      shutdown();
    });
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    process.once("SIGHUP", onSignal);
  });
}

const plugin: AtlcliPlugin = {
  name: "drawio",
  version: "0.1.0",
  description: "Generate Draw.io preview PNGs for Confluence sync",
  commands: [{
    name: "drawio",
    description: "Generate and watch Draw.io previews",
    subcommands: [
      {
        name: "preview",
        description: "Generate stale Draw.io preview PNGs",
        flags: [
          { name: "force", alias: "f", description: "Regenerate current previews" },
          { name: "check", description: "Fail when a preview is stale or missing" },
          { name: "executable", description: "Draw.io executable", hasValue: true },
        ],
        handler: previewHandler,
      },
      {
        name: "watch",
        description: "Regenerate previews when Draw.io sources change",
        flags: [
          { name: "force", alias: "f", description: "Regenerate current previews" },
          { name: "executable", description: "Draw.io executable", hasValue: true },
        ],
        handler: watchHandler,
      },
    ],
  }],
  hooks: {
    beforeCommand: async (context) => {
      const [cmd, sub, action] = context.command;
      if (cmd !== "wiki" || sub !== "docs" || action !== "push") return;
      const results = await renderDrawioPreviews(pushDirectoryFrom(context), optionsFrom(context));
      const failures = results.filter((result) => result.status === "failed");
      if (failures.length > 0) {
        // Aggregate all failure messages so the user can fix every broken
        // diagram in one pass instead of one push per failure.
        const details = failures
          .map((failure) => `${failure.source}: ${failure.message ?? "unknown error"}`)
          .join("\n");
        throw new Error(`Could not render ${failures.length} Draw.io preview(s):\n${details}`);
      }
    },
  },
};

export default plugin;
