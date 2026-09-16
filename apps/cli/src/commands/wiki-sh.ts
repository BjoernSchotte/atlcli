/**
 * `atlcli wiki sh` — Confluence as a shell (WP6.6).
 *
 * Three ways in, in the order the plan asks for:
 *  - `-c '<script>'`, the agent-friendly single command with a real exit code;
 *  - a script on stdin when stdin is not a terminal;
 *  - an interactive prompt when it is.
 *
 * The exit code is the **bash exit code**, not ours, so `grep -q … && …` works
 * from the outside exactly as it does inside.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  ERROR_CODES,
  fail,
  getActiveProfile,
  getFlag,
  hasFlag,
  isInteractive,
  loadConfig,
  output,
  resolveDefaults,
  resolveVfsConfig,
  type OutputOptions,
} from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import { ConfluenceVfsImpl, isVfsError, type VfsMode } from "@atlcli/confluence-vfs";
import { assertCliAuthSupported } from "./session-guard.js";

type Flags = Record<string, string | boolean | string[]>;

export const DEFAULT_CACHE_DIR = join(homedir(), ".atlcli", "vfs");

/** Everything the command needs, resolved from flags, config and the profile. */
export interface ResolvedShellOptions {
  profileName: string;
  spaces: string[];
  mode: VfsMode;
  allowDelete: boolean;
  cacheDir: string;
  offline: boolean;
  cwd: string | undefined;
  timeoutMs: number;
  json: boolean;
  cqlGrep: boolean;
  prefetchMax: number | undefined;
  cacheMaxMb: number | undefined;
  script: string | undefined;
}

function numberFlag(flags: Flags, name: string): number | undefined {
  const raw = getFlag(flags, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Flag and config resolution, split out so it is testable without a tenant.
 *
 * Precedence is the repo's usual one: an explicit flag beats the profile's
 * config, which beats the global config, which beats the built-in default.
 * The **mode is the exception worth stating**: nothing may raise it implicitly
 * except a config the user wrote themselves, and the built-in default is always
 * `ro`.
 */
export function resolveShellOptions(
  args: string[],
  flags: Flags,
  context: {
    config: Parameters<typeof resolveVfsConfig>[0];
    profile: Parameters<typeof resolveVfsConfig>[1];
    profileName: string;
  },
): ResolvedShellOptions {
  const vfsConfig = resolveVfsConfig(context.config, context.profile);
  const defaults = resolveDefaults(context.config, context.profile);

  const spaceFlag = getFlag(flags, "space");
  const spaces = spaceFlag
    ? spaceFlag.split(",").map((key) => key.trim()).filter(Boolean)
    : (vfsConfig.spaces ?? (defaults.space ? [defaults.space] : []));

  const modeFlag = getFlag(flags, "mode");
  const mode: VfsMode = modeFlag === "rw" ? "rw" : modeFlag === "ro" ? "ro" : (vfsConfig.mode ?? "ro");

  return {
    profileName: context.profileName,
    spaces,
    mode,
    allowDelete: hasFlag(flags, "allow-delete"),
    cacheDir: getFlag(flags, "cache-dir") ?? vfsConfig.cacheDir ?? DEFAULT_CACHE_DIR,
    offline: hasFlag(flags, "offline"),
    cwd: getFlag(flags, "cwd"),
    timeoutMs: numberFlag(flags, "timeout") ?? 120_000,
    json: hasFlag(flags, "json"),
    cqlGrep: hasFlag(flags, "no-cql") ? false : (vfsConfig.cqlGrep ?? true),
    prefetchMax: numberFlag(flags, "prefetch-max") ?? vfsConfig.prefetchMaxPages,
    cacheMaxMb: numberFlag(flags, "cache-max-mb") ?? vfsConfig.cacheMaxMb,
    script: getFlag(flags, "c") ?? args.join(" ") ?? undefined,
  };
}

export async function handleWikiSh(
  args: string[],
  flags: Flags,
  opts: OutputOptions,
): Promise<void> {
  if (hasFlag(flags, "help") || hasFlag(flags, "h")) {
    output(wikiShHelp(), opts);
    return;
  }

  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", {
      profile: profileName,
    });
    return;
  }
  assertCliAuthSupported(profile, opts);

  const resolved = resolveShellOptions(args, flags, {
    config,
    profile,
    profileName: profile.name,
  });

  if (resolved.spaces.length === 0) {
    fail(
      opts,
      2,
      ERROR_CODES.VALIDATION,
      "No space to mount. Pass --space <KEY[,KEY]>, set a default space, or set vfs.spaces in the config.",
      {},
    );
    return;
  }

  const vfs = await ConfluenceVfsImpl.open({
    profile: profile.name,
    client: new ConfluenceClient(profile),
    spaces: resolved.spaces,
    mode: resolved.mode,
    allowDelete: resolved.allowDelete,
    cacheDir: resolved.cacheDir,
    offline: resolved.offline,
    ...(resolved.prefetchMax !== undefined ? { prefetchMaxPages: resolved.prefetchMax } : {}),
    ...(resolved.cacheMaxMb !== undefined ? { cacheMaxMb: resolved.cacheMaxMb } : {}),
    cqlGrep: resolved.cqlGrep,
  });

  const diagnostics: string[] = [];
  try {
    // Dynamic import so every other atlcli command stays off just-bash's path
    // (WP6.8; the measured effect is in spikes/vfs-just-bash/README.md).
    const { createWikiShell } = await import("../vfs/wiki-shell.js");
    const shell = await createWikiShell({
      vfs,
      spaces: resolved.spaces,
      ...(resolved.cwd !== undefined ? { cwd: resolved.cwd } : {}),
      timeoutMs: resolved.timeoutMs,
      cqlGrep: resolved.cqlGrep,
      prefetchMax: resolved.prefetchMax,
      onDiagnostic: (line) => {
        diagnostics.push(line);
        // The chosen path is *always* named, so a user can see why a search was
        // slow or why it was fast (decision 12's transparency requirement).
        if (!resolved.json) process.stderr.write(`${line}\n`);
      },
    });

    const script = resolved.script?.trim()
      ? resolved.script
      : isInteractive()
        ? undefined
        : await readStdin();

    if (script === undefined) {
      await runInteractive(shell, resolved);
      return;
    }

    const result = await shell.exec(script);
    if (resolved.json) {
      const stats = shell.stats();
      output(
        {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          diagnostics,
          cacheHits: stats.cacheHits,
          cacheMisses: stats.cacheMisses,
          prefetched: stats.prefetched,
        },
        opts,
      );
    } else {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    // The bash exit code is the command's exit code.
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  } finally {
    await vfs.close();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function runInteractive(
  shell: { exec(script: string): Promise<{ stdout: string; stderr: string; exitCode: number }> },
  resolved: ResolvedShellOptions,
): Promise<void> {
  const prompt = `${resolved.spaces[0]} ${resolved.mode === "rw" ? "#" : "$"} `;
  process.stderr.write(
    `atlcli wiki sh — ${resolved.spaces.join(", ")} (${resolved.mode}${resolved.allowDelete ? ", delete allowed" : ""})\n` +
      `Type 'vfs-status' for cache and mode, 'exit' to leave.\n`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt });
  rl.prompt();
  for await (const line of rl) {
    const script = line.trim();
    if (script === "exit" || script === "quit") break;
    if (script) {
      try {
        const result = await shell.exec(script);
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      } catch (error) {
        process.stderr.write(`${describe(error)}\n`);
      }
    }
    rl.prompt();
  }
  rl.close();
}

function describe(error: unknown): string {
  if (isVfsError(error)) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function wikiShHelp(): string {
  return `atlcli wiki sh [script...]

Confluence as a filesystem, in an embedded shell. Every space you can see is a
directory; every page is a directory whose body is _index.md.

Usage:
  atlcli wiki sh --space DOCSY -c 'grep -rlw kubernetes . | head'
  atlcli wiki sh --space DOCSY                       # interactive
  cat script.sh | atlcli wiki sh --space DOCSY       # from stdin

Options:
  --space <KEY[,KEY]>  Spaces to mount (default: the profile's space)
  -c <script>          Run one script and exit with its exit code
  --mode ro|rw         Write posture (default: ro)
  --allow-delete       Additionally allow rm, which moves pages to the trash
  --cache-dir <path>   Cache root (default: ~/.atlcli/vfs)
  --offline            Read only from the cache; issue no requests
  --cwd <path>         Start in this directory
  --timeout <ms>       Wall-clock limit for the script (default: 120000)
  --prefetch-max <n>   Ceiling on one prefetch (default: 300)
  --cache-max-mb <n>   Disk cache ceiling (default: 100)
  --no-cql             Compatibility flag; CQL narrowing is disabled
  --json               Emit stdout, stderr, exit code and counters as JSON
  --profile <name>     Use a specific auth profile

Notes:
  Writing is off by default. --mode rw enables create, update, rename and move;
  rm additionally needs --allow-delete, and only ever moves a page to the trash.

  Recursive grep searches current page bodies with bounded bulk prefetch.
  CQL narrowing is disabled because the index can omit whole-word matches.
  Use cql explicitly for indexed search; --no-cql remains accepted.

Extra commands inside the shell:
  cql '<query>'    Run a CQL query and print paths
  page-id <path>   Print a page's Confluence id
  page-url <path>  Print a page's URL
  vfs-status       Print mode, cache state and counters
`;
}
