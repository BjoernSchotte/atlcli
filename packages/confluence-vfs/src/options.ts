/**
 * Construction options for the VFS core (WP1.4).
 *
 * Everything the core needs is passed in: it opens no config file, reads no
 * environment variable and creates no client. `apps/cli` resolves all of this
 * from flags and `~/.atlcli/config.json` and hands over a finished object,
 * which is what makes the core testable against a fake client.
 */
import type { VfsClient } from "./client-port.js";

/** Write posture. `ro` is the default everywhere (decision 6). */
export type VfsMode = "ro" | "rw";

/** The logging surface the core uses; `@atlcli/core`'s `Logger` satisfies it. */
export interface VfsLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface VfsOptions {
  /** Profile name, used to partition the cache. Never the token itself. */
  profile: string;
  /**
   * The REST client. Typed as the narrow {@link VfsClient} port rather than
   * `ConfluenceClient` itself so tests can pass a fake; `client-port.test.ts`
   * proves the real client satisfies it.
   */
  client: VfsClient;
  /** Restrict the visible spaces. Undefined means every space the user can see. */
  spaces?: string[];
  mode: VfsMode;
  /** `rm` additionally requires this, even in `rw` mode. */
  allowDelete: boolean;
  /** Root of the cache; the core appends `<profile>/<accountId>/<siteHash>.db`. */
  cacheDir: string;
  /** Read from the cache only, issue no requests. */
  offline: boolean;
  /** Parallel REST requests. Default 8; 429s appear from roughly 20 upward. */
  concurrency?: number;
  /** Per-node tree index TTL in milliseconds. Default 60,000. */
  treeTtlMs?: number;
  /** Hard ceiling on a single prefetch (demand principle, rule 3). Default 300. */
  prefetchMaxPages?: number;
  /** Disk cache ceiling in megabytes, blobs included. Default 100. */
  cacheMaxMb?: number;
  /** Allow the CQL shortcut in `grep`. Default true. */
  cqlGrep?: boolean;
  logger?: VfsLogger;
  /** Injectable clock, so tests do not wait on TTLs. */
  now?: () => number;
}

/** Everything {@link VfsOptions} leaves optional, filled in. */
export type ResolvedVfsOptions = Required<
  Omit<VfsOptions, "spaces" | "logger" | "client">
> & {
  spaces: string[] | undefined;
  logger: VfsLogger;
  client: VfsOptions["client"];
};

export const VFS_DEFAULTS = {
  concurrency: 8,
  treeTtlMs: 60_000,
  prefetchMaxPages: 300,
  cacheMaxMb: 100,
  cqlGrep: true,
} as const;

const silentLogger: VfsLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function resolveVfsOptions(options: VfsOptions): ResolvedVfsOptions {
  return {
    profile: options.profile,
    client: options.client,
    spaces: options.spaces,
    mode: options.mode,
    allowDelete: options.allowDelete,
    cacheDir: options.cacheDir,
    offline: options.offline,
    concurrency: options.concurrency ?? VFS_DEFAULTS.concurrency,
    treeTtlMs: options.treeTtlMs ?? VFS_DEFAULTS.treeTtlMs,
    prefetchMaxPages: options.prefetchMaxPages ?? VFS_DEFAULTS.prefetchMaxPages,
    cacheMaxMb: options.cacheMaxMb ?? VFS_DEFAULTS.cacheMaxMb,
    cqlGrep: options.cqlGrep ?? VFS_DEFAULTS.cqlGrep,
    logger: options.logger ?? silentLogger,
    now: options.now ?? (() => Date.now()),
  };
}
