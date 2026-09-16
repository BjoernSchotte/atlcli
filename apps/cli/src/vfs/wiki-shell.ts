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
import type { CommandContext, CommandName } from "just-bash";
import { canonicalPathOf, type ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { posix } from "node:path";
import { ConfluenceJustBashFs } from "./just-bash-fs.js";
import { matchesGrepFile, skipsGrepDirectory, parseFindArgs, parseGrepArgs } from "./grep-flags.js";
import { runIndexedFind } from "./find-cql.js";
import { planGrepCql } from "./grep-cql.js";

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
  /** Interactive frontends only; absent means the explicit CLI gates suffice. */
  confirmMutation?: (message: string) => Promise<boolean>;
  vfs: ConfluenceVfsImpl;
  /** Spaces to mount, each at `/<KEY>`. */
  spaces: string[];
  /** Working directory; defaults to the first space. */
  cwd?: string;
  /** Wall-clock ceiling for one script. */
  timeoutMs?: number;
  /** Use CQL candidate selection for recursive `grep`. */
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
  /** readline candidates and the unquoted/escaped word being completed. */
  complete(line: string): Promise<[string[], string]>;
  /** Requests made and cache hits, for `--json` and `vfs-status`. */
  stats(): { requests: number | null; rateLimits: number | null; cacheHits: number; cacheMisses: number; prefetched: number };
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

  // Default recursive search uses Confluence's index to select pages, then
  // verifies matching Markdown locally. --no-cql requests exhaustive search.
  const runGrep = async (args: string[], ctx: CommandContext) => {
    const parsed = parseGrepArgs(args);
    const original = ctx.origCommand!;
    if (parsed.hasUnsupportedOptions) {
      return { stdout: "", stderr: "grep: unsupported option, missing pattern, or invalid option value; no pages downloaded\n", exitCode: 2 };
    }
    if (!parsed.recursive) return original(parsed.normalizedArgs);
    const forwarded = parsed.normalizedArgs.filter((_, i) => !parsed.normalizedPathIndices.includes(i));
    try {
      // Compile patterns and validate pattern files before traversing or prefetching.
      const validation = await original([...forwarded, "/dev/null"]);
      if (validation.exitCode > 1) return validation;
      const plan = planGrepCql(parsed);
      const enabled = options.cqlGrep !== false && ctx.env.get("ATLCLI_VFS_NO_CQL") !== "1";
      if (enabled && "query" in plan && !parsed.includes.length && !parsed.excludes.length && !parsed.excludeDirs.length) {
        const scopes: string[] = [];
        const explicit = new Map<string, string | undefined>();
        let supported = true;
        for (const path of parsed.paths.length ? parsed.paths : ["."]) {
          const absolute = posix.resolve(ctx.cwd, path);
          const space = spaceOf(ctx.cwd, absolute);
          if (!space) { supported = false; break; }
          const stat = await options.vfs.stat(absolute);
          if (!stat.isDirectory) {
            explicit.set(absolute, stat.kind === "page" || stat.kind === "symlink" ? stat.id : undefined);
            continue;
          }
          if (!["space", "page", "folder"].includes(stat.kind)) { supported = false; break; }
          const root = stat.kind === "space" ? await options.vfs.index.getHomepageId(space) : stat.id;
          if (!root || !/^\d+$/.test(root)) { supported = false; break; }
          scopes.push(`(id = ${root} OR ancestor = ${root})`);
        }
        // Explicit files are already a precise scope and need no search index.
        if (supported && scopes.length && scopes.length <= 100) {
          let found: Awaited<ReturnType<typeof options.vfs.searchExcerpts>> | undefined;
          try {
            found = await options.vfs.searchExcerpts(`(${plan.query}) AND (${scopes.join(" OR ")})`, { maxResults: 1000, spaces });
          } catch {
            diagnostic("grep: CQL unavailable; falling back to exhaustive Markdown search");
          }
          if (found) {
            diagnostic(`grep: CQL-indexed search; ${found.results.length} candidate pages; index gaps and indexing delay may omit matches. Use --no-cql for exhaustive search.`);
            if (found.truncated && !parsed.quiet) {
              return { stdout: "", stderr: "grep: indexed candidates exceed the search limit; narrow the path or pattern (no bodies downloaded)\n", exitCode: 2 };
            }
            const selected = new Map(explicit);
            for (const row of found.results) {
              const known = options.vfs.index.node(row.id);
              if (!known || (row.version !== undefined && row.version > (known.version ?? 0))) {
                options.vfs.index.upsert({ id: row.id, title: row.title, type: "page", spaceKey: row.spaceKey,
                  version: row.version ?? 0, metaCheckedAt: 0 });
              }
              if (![...explicit.values()].includes(row.id)) selected.set(row.path, row.id);
            }
            const ids = [...new Set([...selected.values()].filter((id): id is string => id !== undefined))];
            await options.vfs.index.revalidatePages(ids);
            const budget = options.prefetchMax ?? options.vfs.prefetchMaxPages;
            if (!selected.size) return { stdout: "", stderr: "", exitCode: 1 };
            if (parsed.quiet) {
              let fetched = 0;
              for (const [file, id] of selected) {
                if (id) {
                  const warmed = await options.vfs.prefetch([id], { budget: budget - fetched, reason: "indexed grep" });
                  fetched += warmed.fetched;
                  prefetched += warmed.fetched;
                }
                const result = await original([...forwarded, file]);
                if (result.exitCode !== 1) return result;
              }
              return { stdout: "", stderr: found.truncated ? "grep: indexed candidates truncated; no-match is inconclusive\n" : "", exitCode: found.truncated ? 2 : 1 };
            }
            const warmed = await options.vfs.prefetch(ids, { budget, reason: "indexed grep" });
            prefetched += warmed.fetched;
            diagnostic(`grep: ${warmed.fetched} bodies fetched, ${warmed.fromCache} cached; verifying indexed candidates`);
            return original([...forwarded, ...selected.keys()]);
          }
        }
      } else if (enabled && !parsed.noCql) {
        diagnostic(`grep: exhaustive fallback (${ "reason" in plan ? plan.reason : "path filters require the filesystem hierarchy" })`);
      }
      const files = new Map<string, string | undefined>();
      for (const path of parsed.paths.length ? parsed.paths : ["."]) {
        const absolute = posix.resolve(ctx.cwd, path);
        const spaceKey = spaceOf(ctx.cwd, absolute);
        if (!spaceKey) throw new Error(`Recursive grep needs a path inside a mounted space: ${path}`);
        const stat = await options.vfs.stat(absolute);
        if (!stat.isDirectory) {
          const pageId = stat.kind === "page" || stat.kind === "symlink" ? stat.id : undefined;
          if (matchesGrepFile(parsed, absolute)) files.set(absolute, pageId);
          continue;
        }
        // Implicit recursive search visits current page bodies only.
        if (!matchesGrepFile(parsed, "_index.md") || skipsGrepDirectory(parsed, posix.basename(absolute))) continue;
        const homepage = await options.vfs.index.getHomepageId(spaceKey);
        const ids = await options.vfs.subtreePageIds(absolute, spaceKey, {
          shouldVisit: (node) => !skipsGrepDirectory(parsed, posix.basename(canonicalPathOf(options.vfs.index, node, homepage))),
        });
        for (const id of ids) {
          files.set(`${canonicalPathOf(options.vfs.index, options.vfs.index.node(id)!, homepage)}/_index.md`, id);
        }
      }
      if (!files.size) return { stdout: "", stderr: "", exitCode: 1 };
      await options.vfs.index.revalidatePages([...files.values()].filter((id): id is string => id !== undefined));
      const budget = options.prefetchMax ?? options.vfs.prefetchMaxPages;
      if (parsed.quiet && !parsed.invertMatch && !parsed.patternFiles.length) {
        // Exhaustive -q needs only one verified match. Check cache hits first.
        let entries = [...files];
        const cached = new Set(entries.filter(([, id]) => {
          const version = id ? options.vfs.index.node(id)?.version : undefined;
          return id && version !== undefined && options.vfs.cache?.getBody(id, version);
        }).map(([path]) => path));
        let fromCache = 0;
        for (const [file] of entries.filter(([path]) => cached.has(path))) {
          fromCache++;
          const result = await original([...forwarded, file]);
          if (result.exitCode !== 1) {
            diagnostic(`grep: exact quiet search; 0 bodies fetched, ${fromCache} cached; ${result.exitCode === 0 ? "verified match" : "error"}`);
            return result;
          }
        }
        entries = entries.filter(([path]) => !cached.has(path));
        let fetched = 0;
        for (const [file, id] of entries) {
          if (id) {
            const warmed = await options.vfs.prefetch([id], { budget: budget - fetched, reason: "recursive grep" });
            fetched += warmed.fetched;
            fromCache += warmed.fromCache;
            prefetched += warmed.fetched;
          }
          const result = await original([...forwarded, file]);
          if (result.exitCode !== 1) {
            diagnostic(`grep: exact quiet search; ${fetched} bodies fetched, ${fromCache} cached; ${result.exitCode === 0 ? "verified match" : "error"}`);
            return result;
          }
        }
        diagnostic(`grep: exact quiet search; ${fetched} bodies fetched, ${fromCache} cached; complete, no match`);
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      diagnostic("grep: full scan (CQL text indexing can omit whole-word matches)");
      const result = await options.vfs.prefetch([...new Set([...files.values()].filter((id): id is string => id !== undefined))], {
        reason: "recursive grep", budget,
      });
      prefetched += result.fetched;
      diagnostic(`grep: exact search; ${files.size} files, ${result.fetched} bodies fetched, ${result.fromCache} cached`);
      return original([...forwarded, ...files.keys()]);
    } catch (error) {
      return { stdout: "", stderr: `grep: ${String(error)}\nNarrow the path or pattern, or raise --prefetch-max.\n`, exitCode: 2 };
    }
  };
  const boundedGrep = (args: string[], ctx: CommandContext) => options.vfs.withBodyBudget(
    options.prefetchMax ?? options.vfs.prefetchMaxPages, () => runGrep(args, ctx),
  );
  const grep = defineCommand("grep", boundedGrep, { trusted: true });
  const fgrep = defineCommand("fgrep", (args, ctx) => boundedGrep(["-F", ...args], ctx), { trusted: true });
  const egrep = defineCommand("egrep", (args, ctx) => boundedGrep(["-E", ...args], ctx), { trusted: true });

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
      if (options.cqlGrep !== false && ctx.env.get("ATLCLI_VFS_NO_CQL") !== "1") {
        const indexed = await runIndexedFind(args, { vfs: options.vfs, cwd: ctx.cwd, spaces, diagnostic });
        if (indexed) return indexed;
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
      let excerpt = false;
      let json = false;
      let maxResults = 100;
      let index = 0;
      for (; index < args.length && args[index]!.startsWith("--"); index++) {
        const arg = args[index]!;
        if (arg === "--") { index++; break; }
        if (arg === "--excerpt") excerpt = true;
        else if (arg === "--json") json = true;
        else if (arg === "--limit") maxResults = Number(args[++index]);
        else return { stdout: "", stderr: `cql: unknown option ${arg}\n`, exitCode: 2 };
      }
      const query = args.slice(index).join(" ").trim();
      if (!query) {
        return { stdout: "", stderr: "usage: cql [--excerpt|--json] [--limit 1..1000] '<query>'\n", exitCode: 2 };
      }
      const spaceKey = spaceOf(ctx.cwd, ".") ?? spaces[0]!;
      const scoped = /\bspace\s*=/.test(query) ? query : `space = "${spaceKey}" AND (${query})`;
      try {
        if (excerpt || json) {
          const result = await options.vfs.searchExcerpts(query, { maxResults, spaces: [spaceKey] });
          diagnostic(`cql: indexed search; ${result.results.length} results; ${result.truncated ? "TRUNCATED — raise --limit or narrow the query" : "complete index response"}; 0 page bodies`);
          return {
            stdout: json ? `${JSON.stringify({ source: "confluence-index", ...result })}\n`
              : result.results.map((row) => `${row.path}\t${row.title.replace(/[\r\n\t]/g, " ")}\n  ${row.excerpt.replace(/[\r\n]/g, " ")}\n`).join(""),
            stderr: "", exitCode: 0,
          };
        }
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
  // Bundled rm/mv accept only boolean options. Preserve operands after --.
  const mutationOperands = (args: string[]) => {
    const end = args.indexOf("--");
    return end < 0 ? args.filter((arg) => !arg.startsWith("-"))
      : [...args.slice(0, end).filter((arg) => !arg.startsWith("-")), ...args.slice(end + 1)];
  };
  const declined = (command: string) => ({ stdout: "", stderr: `${command}: cancelled\n`, exitCode: 1 });
  const rm = defineCommand("rm", async (args, ctx) => {
    const paths = mutationOperands(args);
    if (!args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--")).includes("--help") && paths.length && options.confirmMutation &&
        options.vfs.guard.mode === "rw" && options.vfs.guard.allowDelete &&
        !await options.confirmMutation(`Move to Confluence trash: ${paths.map((p) => JSON.stringify(p)).join(", ")}?`)) {
      return declined("rm");
    }
    return ctx.origCommand!(args);
  }, { trusted: true });
  const mv = defineCommand("mv", async (args, ctx) => {
    const paths = mutationOperands(args);
    if (!args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--")).includes("--help") && paths.length >= 2 && options.confirmMutation && options.vfs.guard.mode === "rw") {
      const destination = spaceOf(ctx.cwd, posix.resolve(ctx.cwd, paths.at(-1)!));
      if (paths.slice(0, -1).some((path) => spaceOf(ctx.cwd, posix.resolve(ctx.cwd, path)) !== destination) &&
          !await options.confirmMutation(`Move across Confluence spaces: ${paths.map((p) => JSON.stringify(p)).join(", ")}?`)) {
        return declined("mv");
      }
    }
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
        `requests:    ${options.vfs.getRequestStats()?.requests ?? "unavailable"}`,
        `rate limits: ${options.vfs.getRequestStats()?.rateLimits ?? "unavailable"}`,
      ];
      return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
    },
    { trusted: true },
  );

  const customCommands = [grep, fgrep, egrep, find, cql, pageId, pageUrl, vfsStatus, mv, rm];
  const bash = new Bash({
    defenseInDepth: false,
    cwd: options.cwd ?? `/${spaces[0]}`,
    fs: new MountableFs({ mounts }),
    commands: [...ALLOWED_COMMANDS],
    customCommands,
    executionLimits: {
      // An agent that asks for a whole space should get a bounded answer, not
      // a stalled session and a gigabyte of stdout.
      maxOutputSize: 8 * 1024 * 1024,
      maxExecutionTimeMs: options.timeoutMs ?? 120_000,
    },
  });

  let cwd = options.cwd ?? `/${spaces[0]}`;
  let env = bash.getEnv();
  // compgen's command discovery relies on /bin, absent in our mounted FS.
  const builtins = await bash.exec("compgen -A builtin");
  const commandNames = [...ALLOWED_COMMANDS, ...customCommands.map((command) => command.name), ...builtins.stdout.trim().split("\n"), "exit", "quit"];

  return {
    async complete(line: string): Promise<[string[], string]> {
      const word = /(?:^|[\s|;&<>])((?:\\.|[^\s\\|;&<>])*)$/.exec(line)?.[1] ?? "";
      // Completion never evaluates the user's line, substitutions or quotes.
      if (/["'`$()]/.test(word)) return [[], word];
      const prefix = word.replace(/\\(.)/g, "$1");
      const before = line.slice(0, line.length - word.length).trimEnd();
      const candidates = new Set<string>();
      if ((!before || /[|;&]$/.test(before)) && !prefix.includes("/")) {
        for (const name of commandNames) {
          if (name && name.startsWith(prefix)) candidates.add(name);
        }
      }
      const slash = prefix.lastIndexOf("/");
      const parent = prefix.slice(0, slash + 1);
      const name = prefix.slice(slash + 1);
      try {
        const entries = await options.vfs.readdir(posix.resolve(cwd, parent || "."));
        for (const entry of entries) {
          if (!entry.name.startsWith(name) || (entry.name.startsWith(".") && !name.startsWith("."))) continue;
          const path = `${parent}${entry.name}${entry.isDirectory ? "/" : ""}`;
          candidates.add(path.replace(/[^A-Za-z0-9_./:-]/gu, "\\$&"));
        }
      } catch {
        // A missing/inaccessible prefix has no completions; leave the line intact.
      }
      return [[...candidates].sort(), word];
    },
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
        const result = await bash.exec(script, { cwd, env, replaceEnv: true });
        env = result.env;
        cwd = result.env.PWD ?? cwd;
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { stdout: "", stderr: `${message}\n`, exitCode: 1 };
      }
    },
    stats() {
      const stats = options.vfs.cache?.stats();
      return {
        requests: options.vfs.getRequestStats()?.requests ?? null,
        rateLimits: options.vfs.getRequestStats()?.rateLimits ?? null,
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
