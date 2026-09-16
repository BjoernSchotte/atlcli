/**
 * The embedded shell (WP6.2–6.5).
 *
 * Builds a `Bash` over one `ConfluenceJustBashFs` per space, plus commands for bounded
 * current-body search and Confluence-specific rename semantics. `find` walks
 * the filesystem metadata, while `cql`, `page-url`, `page-id` and `vfs-status` expose the things a
 * filesystem cannot.
 *
 * ## Why defense-in-depth is off
 *
 * just-bash 3.4.2 throws `DefenseInDepthBox: critical patches failed` on every
 * `exec()` under Bun — issue #386, open and unanswered, reproduced in
 * `spikes/vfs-just-bash/`. It is a *secondary* layer by upstream's own threat
 * model: the interpreter's own sandbox, the command allow-list and the absence
 * of network access are the primary ones, and they stay on. atlcli also runs
 * these scripts locally with the user's own rights, so the layer being removed
 * protects against an attacker who already has everything it would protect.
 *
 * TODO: re-enable once https://github.com/vercel-labs/just-bash/issues/386 is
 * fixed, wrapping the backend calls in `runTrustedAsync()` (plan WP10).
 */
import type { CommandName } from "just-bash";
import { canonicalPathOf, type ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { posix } from "node:path";
import { ConfluenceJustBashFs } from "./just-bash-fs.js";
import { parseFindArgs, parseGrepArgs } from "./grep-flags.js";

/**
 * Commands the shell registers.
 *
 * An allow-list rather than a deny-list, and deliberately without `curl`,
 * `wget`, `python3`, `js-exec` or `sqlite3`: a Confluence filesystem has no
 * business making network calls or running an interpreter, and the narrower
 * the surface the less there is to reason about. (It buys no bundle size —
 * WP0.4 measured that this is a runtime filter — but that was never the point.)
 */
export const ALLOWED_COMMANDS = [
  "ls", "cat", "head", "tail", "wc", "sort", "uniq", "comm", "cut", "paste",
  "tr", "rev", "nl", "fold", "column", "join", "tac",
  "grep", "fgrep", "egrep", "rg", "find", "tree", "sed", "awk", "jq", "yq",
  "diff", "xargs", "echo", "printf", "basename", "dirname", "readlink",
  "mkdir", "rmdir", "rm", "mv", "cp", "ln", "chmod", "touch",
  "true", "false", "pwd", "env", "printenv", "date", "seq", "expr", "tee",
  "sleep", "timeout", "md5sum", "sha1sum", "sha256sum", "base64",
  "stat", "file", "du", "which", "help", "bash", "sh", "split", "strings",
] as const satisfies readonly CommandName[];

export interface WikiShellOptions {
  vfs: ConfluenceVfsImpl;
  /** Spaces to mount, each at `/<KEY>`. */
  spaces: string[];
  /** Working directory; defaults to the first space. */
  cwd?: string;
  /** Wall-clock ceiling for one script. */
  timeoutMs?: number;
  /** Allow the CQL shortcut in `grep`. */
  cqlGrep?: boolean;
  /** Prefetch ceiling handed to the core; `undefined` uses its default. */
  prefetchMax?: number | undefined;
  /** Where the override diagnostics go. */
  onDiagnostic?: (line: string) => void;
}

export interface WikiShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WikiShell {
  exec(script: string): Promise<WikiShellResult>;
  /** Requests made and cache hits, for `--json` and `vfs-status`. */
  stats(): { requests: number; cacheHits: number; cacheMisses: number; prefetched: number };
}

/**
 * Builds the shell.
 *
 * just-bash is imported dynamically so that every other atlcli command pays
 * nothing for it at module-evaluation time (WP6.8). WP0.4 measured that under
 * Bun's single-file bundle this does *not* remove the parse cost — that is
 * recorded in the spike readme and re-measured in WP9.5 — but it does keep the
 * module off the eager execution path, which is the part we control.
 */
export async function createWikiShell(options: WikiShellOptions): Promise<WikiShell> {
  const { Bash, MountableFs, defineCommand } = await import("just-bash");

  const spaces = options.spaces.length > 0 ? options.spaces : [];
  if (spaces.length === 0) {
    throw new Error("createWikiShell needs at least one space to mount");
  }

  const mounts = spaces.map((key) => ({
    mountPoint: `/${key}`,
    filesystem: new ConfluenceJustBashFs(options.vfs, `/${key}`),
  }));

  let prefetched = 0;
  const diagnostic = options.onDiagnostic ?? ((): void => {});

  /** The space a shell path belongs to, or undefined outside every mount. */
  const spaceOf = (cwd: string, target: string): string | undefined => {
    const absolute = target.startsWith("/") ? target : `${cwd.replace(/\/$/, "")}/${target}`;
    const first = absolute.split("/").filter(Boolean)[0];
    return first && spaces.includes(first) ? first : undefined;
  };

  // Live CQL misses grep whole-word matches inside dotted tokens. Search
  // current page bodies instead; the bulk-fetch budget still bounds downloads.
  const grep = defineCommand("grep", async (args, ctx) => {
    const parsed = parseGrepArgs(args);
    const original = ctx.origCommand!;
    if (!parsed.recursive) return original(args.filter((a) => a !== "--no-cql"));
    diagnostic("grep: full scan (CQL text indexing can omit whole-word matches)");
    try {
      const files = new Set<string>();
      const ids = new Set<string>();
      for (const path of parsed.paths.length ? parsed.paths : ["."]) {
        const absolute = posix.resolve(ctx.cwd, path);
        const spaceKey = spaceOf(ctx.cwd, absolute);
        if (!spaceKey) throw new Error(`Recursive grep needs a path inside a mounted space: ${path}`);
        const stat = await options.vfs.stat(absolute);
        if (!stat.isDirectory) {
          files.add(absolute);
          if (stat.kind === "page") ids.add(stat.id);
          continue;
        }
        const homepage = await options.vfs.index.getHomepageId(spaceKey);
        for (const id of await options.vfs.subtreePageIds(absolute, spaceKey)) {
          ids.add(id);
          files.add(`${canonicalPathOf(options.vfs.index, options.vfs.index.node(id)!, homepage)}/_index.md`);
        }
      }
      if (!files.size) return { stdout: "", stderr: "", exitCode: 1 };
      const result = await options.vfs.prefetch([...ids], {
        reason: "recursive grep",
        ...(options.prefetchMax !== undefined ? { budget: options.prefetchMax } : {}),
      });
      prefetched += result.fetched;
      // Keep grep's own option/pattern semantics, replacing only file operands.
      // Explicit files prevent a second walk through versions and attachments.
      const forwarded = args.filter((arg, i) => arg !== "--no-cql" && !parsed.pathIndices.includes(i));
      return original([...forwarded, ...files]);
    } catch (error) {
      return { stdout: "", stderr: `grep: ${String(error)}\n`, exitCode: 2 };
    }
  }, { trusted: true });

  /**
   * `find` (WP6.4).
   *
   * Name, path and type predicates are answered from the tree index, so they
   * cost one listing per directory walked and never a body. Anything else falls
   * through to the bundled `find`, which is slower but complete — the same
   * trade as `grep`, and for the same reason.
   */
  const find = defineCommand(
    "find",
    async (args, ctx) => {
      const parsed = parseFindArgs(args);
      const original = ctx.origCommand;
      if (!original) {
        return { stdout: "", stderr: "find: the bundled implementation is unavailable\n", exitCode: 2 };
      }
      if (parsed.timePredicate) {
        diagnostic("find: filesystem metadata (time predicate)");
      } else if (parsed.hasUnsupportedPredicate) {
        diagnostic("find: full walk (a predicate needs the bundled implementation)");
      } else {
        diagnostic("find: tree index only");
      }
      // The bundled implementation walks our filesystem, and our filesystem
      // answers from the index — so this is already the index path. The
      // diagnostic exists so the user can see which one they got.
      return original(args);
    },
    { trusted: true },
  );

  const cql = defineCommand(
    "cql",
    async (args, ctx) => {
      const query = args.join(" ").trim();
      if (!query) {
        return { stdout: "", stderr: "usage: cql '<query>'\n", exitCode: 2 };
      }
      const spaceKey = spaceOf(ctx.cwd, ".") ?? spaces[0]!;
      const scoped = /\bspace\s*=/.test(query) ? query : `space = "${spaceKey}" AND (${query})`;
      try {
        const paths = await options.vfs.searchPaths(scoped);
        return { stdout: paths.map((p) => `${p}\n`).join(""), stderr: "", exitCode: 0 };
      } catch (error) {
        return {
          stdout: "",
          stderr: `cql: ${error instanceof Error ? error.message : String(error)}\n`,
          exitCode: 1,
        };
      }
    },
    { trusted: true },
  );

  const pageId = defineCommand(
    "page-id",
    async (args, ctx) => resolveMeta(args, ctx.cwd, "id"),
    { trusted: true },
  );

  // Slugs are aliases for an ID, so the bundled mv mistakes a new title for
  // an existing destination directory and tries to move the page into itself.
  const mv = defineCommand("mv", async (args, ctx) => {
    const operands = args[0] === "--" ? args.slice(1) : args;
    if (operands.length === 2 && operands.every((arg) => !arg.startsWith("-"))) {
      const from = posix.resolve(ctx.cwd, operands[0]!);
      const to = posix.resolve(ctx.cwd, operands[1]!);
      if (posix.basename(from) !== posix.basename(to)) {
        try {
          const source = await options.vfs.resolve(from);
          const target = await options.vfs.resolve(to);
          if (source.id === target.id && source.kind === target.kind) {
            await options.vfs.rename(from, to);
            return { stdout: "", stderr: "", exitCode: 0 };
          }
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") {
            return { stdout: "", stderr: `mv: ${String(error)}\n`, exitCode: 1 };
          }
        }
      }
    }
    return ctx.origCommand!(args);
  }, { trusted: true });

  const pageUrl = defineCommand(
    "page-url",
    async (args, ctx) => resolveMeta(args, ctx.cwd, "url"),
    { trusted: true },
  );

  async function resolveMeta(
    args: string[],
    cwd: string,
    field: "id" | "url",
  ): Promise<WikiShellResult> {
    const target = args[0];
    if (!target) {
      return { stdout: "", stderr: `usage: page-${field} <path>\n`, exitCode: 2 };
    }
    const absolute = target.startsWith("/") ? target : `${cwd.replace(/\/$/, "")}/${target}`;
    try {
      const node = await options.vfs.resolve(absolute);
      const value =
        field === "id"
          ? node.id
          : `${options.vfs.runtime?.instanceUrl ?? ""}/spaces/${node.spaceKey}/pages/${node.id}`;
      return { stdout: `${value}\n`, stderr: "", exitCode: 0 };
    } catch (error) {
      return {
        stdout: "",
        stderr: `page-${field}: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }
  }

  const vfsStatus = defineCommand(
    "vfs-status",
    async () => {
      const stats = options.vfs.cache?.stats();
      const lines = [
        `mode:        ${options.vfs.guard.mode}${options.vfs.guard.allowDelete ? " (delete allowed)" : ""}`,
        `spaces:      ${spaces.join(", ")}`,
        `profile:     ${options.vfs.runtime?.accountId ?? "unknown"}`,
        `cache:       ${stats ? `${stats.bodies} bodies, ${stats.attachments} attachments, ${formatBytes(stats.bytes)} of ${formatBytes(stats.maxBytes)}` : "none"}`,
        `cache hits:  ${stats?.hits ?? 0} hit, ${stats?.misses ?? 0} miss`,
        `prefetched:  ${prefetched} page bodies this session`,
        `nodes known: ${options.vfs.index.loadedNodes().length}`,
      ];
      return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
    },
    { trusted: true },
  );

  const bash = new Bash({
    defenseInDepth: false,
    cwd: options.cwd ?? `/${spaces[0]}`,
    fs: new MountableFs({ mounts }),
    commands: [...ALLOWED_COMMANDS],
    customCommands: [grep, find, cql, pageId, pageUrl, vfsStatus, mv],
    executionLimits: {
      // An agent that asks for a whole space should get a bounded answer, not
      // a stalled session and a gigabyte of stdout.
      maxOutputSize: 8 * 1024 * 1024,
      maxExecutionTimeMs: options.timeoutMs ?? 120_000,
    },
  });

  return {
    /**
     * Run a script.
     *
     * The try/catch is load-bearing, not defensive noise: just-bash's redirect
     * path (`echo x > page.md`) lets a filesystem error escape `exec()` as a
     * rejected promise instead of turning it into a shell error. Unhandled,
     * that kills the whole `atlcli wiki sh` process on an ordinary EROFS —
     * which is exactly what happens the first time someone tries to write in
     * the default read-only mode. Catching it here turns it back into what the
     * user expects: a message on stderr and a non-zero exit code.
     */
    async exec(script: string): Promise<WikiShellResult> {
      try {
        const result = await bash.exec(script);
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { stdout: "", stderr: `${message}\n`, exitCode: 1 };
      }
    },
    stats() {
      const stats = options.vfs.cache?.stats();
      return {
        requests: 0,
        cacheHits: stats?.hits ?? 0,
        cacheMisses: stats?.misses ?? 0,
        prefetched,
      };
    },
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
