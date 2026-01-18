import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";

export type AuthType = "apiToken" | "oauth";

export type AuthConfig = {
  type: AuthType;
  email?: string;
  token?: string;
  clientId?: string;
};

export type Profile = {
  name: string;
  baseUrl: string;
  auth: AuthConfig;
  cloudId?: string;
  /** Profile-specific Jira project key */
  project?: string;
  /** Profile-specific Confluence space key */
  space?: string;
  /** Profile-specific Jira board ID */
  board?: number;
};

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
  >;
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
  /** Registered projects for --global audit flag */
  projects?: ProjectConfig[];
  /** @deprecated Use 'global' instead. Kept for migration. */
  defaults?: DefaultsConfig;
};

const CONFIG_DIR = join(os.homedir(), ".atlcli");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

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

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  const data = JSON.stringify(config, null, 2);
  await writeFile(CONFIG_PATH, data, "utf8");
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

export function getActiveProfile(config: Config, requested?: string): Profile | undefined {
  if (requested) return config.profiles[requested];
  if (config.currentProfile) return config.profiles[config.currentProfile];
  return undefined;
}

/**
 * Resolve defaults with profile-level overrides.
 * Precedence: profile values > global values
 */
export function resolveDefaults(config: Config, profile?: Profile): DefaultsConfig {
  const globalDefaults = config.global ?? {};
  if (!profile) return globalDefaults;

  return {
    project: profile.project ?? globalDefaults.project,
    space: profile.space ?? globalDefaults.space,
    board: profile.board ?? globalDefaults.board,
  };
}
