import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";
import type { FlagValue } from "./config.js";

export type FlagEntry = {
  name: string;
  value: FlagValue;
  source: "env" | "project" | "global";
};

const CONFIG_DIR = join(os.homedir(), ".atlcli");
const GLOBAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
const PROJECT_CONFIG_NAME = ".atlcli/config.json";

/**
 * Convert flag name to env var name.
 * flag.uno.service → FLAG_UNO_SERVICE
 */
export function flagNameToEnvVar(name: string): string {
  return "FLAG_" + name.toUpperCase().replace(/\./g, "_");
}

/**
 * Convert env var name to flag name.
 * FLAG_UNO_SERVICE → uno.service
 */
export function envVarToFlagName(envVar: string): string {
  return envVar.slice(5).toLowerCase().replace(/_/g, ".");
}

/**
 * Coerce string value to appropriate type.
 */
function coerceValue(value: string): FlagValue {
  if (value === "true") return true;
  if (value === "false") return false;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== "") return num;
  return value;
}

/**
 * Find project config by walking up from cwd.
 */
export function findProjectConfigPath(startDir?: string): string | undefined {
  let dir = startDir ?? process.cwd();

  while (true) {
    const configPath = join(dir, PROJECT_CONFIG_NAME);
    if (existsSync(configPath)) {
      return configPath;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // Reached filesystem root
    dir = parent;
  }

  return undefined;
}

/**
 * Load flags from a config file.
 */
async function loadFlagsFromFile(
  path: string
): Promise<Record<string, FlagValue>> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.flags ?? {};
  } catch {
    return {};
  }
}

/**
 * Load all flags with precedence: env > project > global.
 */
export async function loadFlags(): Promise<Record<string, FlagValue>> {
  const flags: Record<string, FlagValue> = {};

  // 1. Global config (lowest precedence)
  const globalFlags = await loadFlagsFromFile(GLOBAL_CONFIG_PATH);
  Object.assign(flags, globalFlags);

  // 2. Project config
  const projectConfigPath = findProjectConfigPath();
  if (projectConfigPath) {
    const projectFlags = await loadFlagsFromFile(projectConfigPath);
    Object.assign(flags, projectFlags);
  }

  // 3. Environment variables (highest precedence)
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("FLAG_") && value !== undefined) {
      const flagName = envVarToFlagName(key);
      flags[flagName] = coerceValue(value);
    }
  }

  return flags;
}

/**
 * Get a single flag value.
 */
export async function getFlagValue<T extends FlagValue>(
  name: string,
  defaultValue?: T
): Promise<T | undefined> {
  // Check env first (highest precedence)
  const envVar = flagNameToEnvVar(name);
  const envValue = process.env[envVar];
  if (envValue !== undefined) {
    return coerceValue(envValue) as T;
  }

  // Check project config
  const projectConfigPath = findProjectConfigPath();
  if (projectConfigPath) {
    const projectFlags = await loadFlagsFromFile(projectConfigPath);
    if (name in projectFlags) {
      return projectFlags[name] as T;
    }
  }

  // Check global config
  const globalFlags = await loadFlagsFromFile(GLOBAL_CONFIG_PATH);
  if (name in globalFlags) {
    return globalFlags[name] as T;
  }

  return defaultValue;
}

/**
 * List all flags with their sources.
 */
export async function listFlags(): Promise<FlagEntry[]> {
  const entries: FlagEntry[] = [];
  const seen = new Set<string>();

  // 1. Environment variables (highest precedence)
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("FLAG_") && value !== undefined) {
      const flagName = envVarToFlagName(key);
      entries.push({
        name: flagName,
        value: coerceValue(value),
        source: "env",
      });
      seen.add(flagName);
    }
  }

  // 2. Project config
  const projectConfigPath = findProjectConfigPath();
  if (projectConfigPath) {
    const projectFlags = await loadFlagsFromFile(projectConfigPath);
    for (const [name, value] of Object.entries(projectFlags)) {
      if (!seen.has(name)) {
        entries.push({ name, value, source: "project" });
        seen.add(name);
      }
    }
  }

  // 3. Global config (lowest precedence)
  const globalFlags = await loadFlagsFromFile(GLOBAL_CONFIG_PATH);
  for (const [name, value] of Object.entries(globalFlags)) {
    if (!seen.has(name)) {
      entries.push({ name, value, source: "global" });
      seen.add(name);
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Save flags to a config file.
 */
async function saveFlagsToFile(
  path: string,
  flags: Record<string, FlagValue>
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, "utf8");
      config = JSON.parse(raw);
    } catch {
      // Start fresh if parse fails
    }
  }

  config.flags = flags;
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
}

/**
 * Set a flag in global config.
 */
export async function setGlobalFlag(
  name: string,
  value: FlagValue
): Promise<void> {
  const flags = await loadFlagsFromFile(GLOBAL_CONFIG_PATH);
  flags[name] = value;
  await saveFlagsToFile(GLOBAL_CONFIG_PATH, flags);
}

/**
 * Set a flag in project config.
 */
export async function setProjectFlag(
  name: string,
  value: FlagValue
): Promise<void> {
  const projectConfigPath =
    findProjectConfigPath() ?? join(process.cwd(), PROJECT_CONFIG_NAME);
  const flags = await loadFlagsFromFile(projectConfigPath);
  flags[name] = value;
  await saveFlagsToFile(projectConfigPath, flags);
}

/**
 * Unset a flag from config.
 */
export async function unsetFlag(
  name: string,
  scope: "global" | "project"
): Promise<boolean> {
  const path =
    scope === "global"
      ? GLOBAL_CONFIG_PATH
      : findProjectConfigPath() ?? join(process.cwd(), PROJECT_CONFIG_NAME);

  const flags = await loadFlagsFromFile(path);
  if (!(name in flags)) {
    return false;
  }

  delete flags[name];
  await saveFlagsToFile(path, flags);
  return true;
}
