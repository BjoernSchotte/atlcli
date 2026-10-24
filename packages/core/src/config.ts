import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";

// Pure types live in types.ts (browser-safe). Re-exported here for back-compat
// so existing `@atlcli/core` / `./config.js` consumers keep working unchanged.
export type { AuthType, DeploymentType, AuthConfig, Profile } from "./types.js";
import type { Profile } from "./types.js";

import type { LogLevel } from "./logger.js";

export type LoggingConfig = {
  /** Log level: off, error, warn, info, debug */
  level: LogLevel;
  /** Enable global logs (~/.atlcli/logs/) */
  global: boolean;
  /** Enable project-level logs (.atlcli/logs/) */
  project: boolean;
};

export type DefaultsConfig = {
  /** Default Jira project key */
  project?: string;
  /** Default Confluence space key */
  space?: string;
  /** Default Jira board ID */
  board?: number;
};

export type FlagValue = boolean | string | number;

/**
 * Storage adapter configuration for sync operations.
 */
export type StorageConfig = {
  /** Adapter type: sqlite (default), postgres, json */
  adapter?: "sqlite" | "postgres" | "json";

  /** SQLite-specific options */
  sqlite?: {
    /** Enable vector support via sqlite-vec extension */
    enableVectors?: boolean;
    /** Custom SQLite library path (macOS only, for sqlite-vec) */
    customSqlitePath?: string;
  };

  /** PostgreSQL-specific options (future) */
  postgres?: {
    /** Connection string */
    connectionString: string;
    /** Schema name (default: 'atlcli') */
    schema?: string;
    /** Enable SSL */
    ssl?: boolean;
    /** Connection pool size (default: 5) */
    poolSize?: number;
  };
};

/**
 * Sync behavior configuration.
 */
export type SyncConfig = {
  /** User status cache TTL in days (default: 7) */
  userStatusTtlDays?: number;
  /** Skip user status checks during pull (default: false) */
  skipUserStatusCheck?: boolean;
  /**
   * Show quick audit summary after pull if audit feature is available (default: false).
   * Only triggers if `flags.audit` is enabled.
   * Shows: orphan count, broken link count, user cache age.
   */
  postPullAuditSummary?: boolean;
};

/**
 * Audit feature configuration.
 */
export type AuditConfig = {
  /** Stale content thresholds in months */
  staleThresholds?: {
    /** High risk threshold (months since last edit) */
    high?: number;
    /** Medium risk threshold (months since last edit) */
    medium?: number;
    /** Low risk threshold (months since last edit) */
    low?: number;
  };
  /** Default checks to run when --all is not specified */
  defaultChecks?: Array<
    | "stale"
    | "orphans"
    | "broken-links"
    | "single-contributor"
    | "inactive-contributors"
    | "external-links"
    | "folders"
  >;
  /** `audit jira` settings. */
  jira?: JiraAuditConfig;
};

/** `audit jira` settings; a profile's values win over the global ones. */
export type JiraAuditConfig = {
  /** Days without an update for the info / warning / error stale levels. Default 30, 60, 90. */
  staleDays?: [number, number, number];
};

/**
 * Flow metrics settings (`jira analyze flow|aging|cfd`, `audit jira`).
 * A profile's `flow.statusMap` wins per key over the global one.
 */
export type FlowConfig = {
  /** Status name or id → flow category, overriding the Jira status category. */
  statusMap?: Record<string, "todo" | "wip" | "done">;
};

/** `atlcli digest` settings; a profile's `projects` replace the global list. */
export type DigestConfig = {
  /** Jira project keys for the project overview, whoever changed the issues. */
  projects?: string[];
};

/** `atlcli tui` settings. */
export type TuiSettings = {
  /** Start area: `jira` (default) or `wiki`. */
  area?: string;
  /** `dark` (default) or `light`. */
  theme?: string;
  /** Keys per command id, replacing its defaults: `{ "jira.transition": ["t", "ctrl+t"] }`. */
  keymap?: Record<string, string[]>;
  /** Issue list columns before the summary: key, type, status, priority, assignee, updated. */
  columns?: string[];
  /** Seconds without a key press before the TUI reloads its list (default 60; 0 = off). */
  refresh?: number;
  /** Lists saved in the TUI (`F`), per profile: JQL for `jira`, CQL for `wiki`. */
  views?: TuiViewSetting[];
};

export type TuiViewSetting = {
  profile: string;
  area: string;
  name: string;
  query: string;
};

/**
 * Registered project configuration for --global audit flag.
 */
export type ProjectConfig = {
  /** Path to the project's .atlcli directory */
  path: string;
  /** Confluence space key */
  space?: string;
  /** Jira project key */
  project?: string;
  /** Optional label to identify this project */
  label?: string;
};

/**
 * Virtual filesystem settings (`atlcli wiki sh`, `atlcli wiki mount`).
 *
 * Every value may be set globally or per profile, with the profile winning.
 * All are optional: the VFS has working defaults for each, and the plan's
 * section 8 documents what they are and why.
 */
export type VfsConfig = {
  /** Root of the body cache. Default `~/.atlcli/vfs/`. */
  cacheDir?: string;
  /** Write posture. Default `ro` — writing is always an explicit choice. */
  mode?: "ro" | "rw";
  /** Spaces to mount when none is named on the command line. */
  spaces?: string[];
  /** Disk cache ceiling in megabytes, attachment blobs included. Default 100. */
  cacheMaxMb?: number;
  /** Hard ceiling on one prefetch. Default 300. */
  prefetchMaxPages?: number;
  /** Allow the CQL shortcut in `grep`. Default true. */
  cqlGrep?: boolean;
};

export type Config = {
  currentProfile?: string;
  profiles: Record<string, Profile>;
  /** Logging configuration */
  logging?: LoggingConfig;
  /** Global default values for commands */
  global?: DefaultsConfig;
  /** Feature flags */
  flags?: Record<string, FlagValue>;
  /** Storage adapter configuration */
  storage?: StorageConfig;
  /** Sync behavior configuration */
  sync?: SyncConfig;
  /** Audit feature configuration */
  audit?: AuditConfig;
  /** Virtual filesystem configuration */
  vfs?: VfsConfig;
  /** Flow metrics configuration */
  flow?: FlowConfig;
  /** Digest configuration */
  digest?: DigestConfig;
  /** `atlcli tui` configuration */
  tui?: TuiSettings;
  /** Registered projects for --global audit flag */
  projects?: ProjectConfig[];
  /** @deprecated Use 'global' instead. Kept for migration. */
  defaults?: DefaultsConfig;
};

const CONFIG_DIR = join(os.homedir(), ".atlcli");
/** `ATLCLI_CONFIG` points at another config file (#282). */
const CONFIG_PATH = process.env.ATLCLI_CONFIG?.trim() || join(CONFIG_DIR, "config.json");

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export async function loadConfig(): Promise<Config> {
  if (!existsSync(CONFIG_PATH)) {
    return { profiles: {} };
  }
  const raw = await readFile(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as Config;
  if (!parsed.profiles) parsed.profiles = {};

  // Migration: defaults → global
  if (parsed.defaults && !parsed.global) {
    parsed.global = parsed.defaults;
    delete parsed.defaults;
    await saveConfig(parsed);
  }

  return parsed;
}

/**
 * Writes the config atomically (a temp file, then a rename), readable by the
 * owner only: it holds every profile and maybe tokens, and a crash or a second
 * writer (the TUI saves views while the CLI runs) must not leave it cut off.
 */
export async function saveConfig(config: Config): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  const data = JSON.stringify(config, null, 2);
  // A symlinked config (dotfiles) stays a symlink: replace the file it points to.
  const target = await realpath(CONFIG_PATH).catch(() => CONFIG_PATH);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, data, { encoding: "utf8", mode: 0o600 });
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

export function getProfile(config: Config, name: string): Profile | undefined {
  return config.profiles[name];
}

export function setProfile(config: Config, profile: Profile): void {
  config.profiles[profile.name] = profile;
}

export function removeProfile(config: Config, name: string): void {
  delete config.profiles[name];
  if (config.currentProfile === name) {
    config.currentProfile = undefined;
  }
}

export function clearProfileAuth(config: Config, name: string): boolean {
  const profile = config.profiles[name];
  if (!profile) return false;
  profile.auth = { type: profile.auth.type };
  return true;
}

export function renameProfile(config: Config, oldName: string, newName: string): boolean {
  const profile = config.profiles[oldName];
  if (!profile) return false;
  if (config.profiles[newName]) return false; // Target name already exists

  profile.name = newName;
  config.profiles[newName] = profile;
  delete config.profiles[oldName];

  if (config.currentProfile === oldName) {
    config.currentProfile = newName;
  }
  return true;
}

export function setCurrentProfile(config: Config, name: string): void {
  config.currentProfile = name;
}

/**
 * The profile a command uses: `--profile`, else `ATLCLI_PROFILE`, else the
 * config's current profile (#282).
 */
export function getActiveProfile(config: Config, requested?: string): Profile | undefined {
  const fromEnv = typeof process === "undefined" ? undefined : process.env.ATLCLI_PROFILE?.trim();
  const name = requested || fromEnv;
  if (name) return config.profiles[name];
  if (config.currentProfile) return config.profiles[config.currentProfile];
  return undefined;
}

/**
 * Resolve defaults with profile-level overrides.
 * Precedence: profile values > global values
 */
/**
 * VFS settings with the profile's values layered over the global ones.
 *
 * Per-key rather than whole-object, so setting `vfs.mode` on one profile does
 * not silently drop a globally configured `vfs.cacheDir`.
 */
export function resolveVfsConfig(config: Config, profile?: Profile): VfsConfig {
  const globalVfs = config.vfs ?? {};
  const profileVfs = profile?.vfs ?? {};
  return {
    cacheDir: profileVfs.cacheDir ?? globalVfs.cacheDir,
    mode: profileVfs.mode ?? globalVfs.mode,
    spaces: profileVfs.spaces ?? globalVfs.spaces,
    cacheMaxMb: profileVfs.cacheMaxMb ?? globalVfs.cacheMaxMb,
    prefetchMaxPages: profileVfs.prefetchMaxPages ?? globalVfs.prefetchMaxPages,
    cqlGrep: profileVfs.cqlGrep ?? globalVfs.cqlGrep,
  };
}

export function resolveDefaults(config: Config, profile?: Profile): DefaultsConfig {
  const globalDefaults = config.global ?? {};
  if (!profile) return globalDefaults;

  return {
    project: profile.project ?? globalDefaults.project,
    space: profile.space ?? globalDefaults.space,
    board: profile.board ?? globalDefaults.board,
  };
}
