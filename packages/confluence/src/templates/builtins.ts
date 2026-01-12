/**
 * Built-in variables for templates.
 */

import { randomUUID } from "node:crypto";
import type { BuiltinVariables } from "./types.js";

/**
 * Generate a random alphanumeric string.
 */
function randomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Create built-in variables for template rendering.
 */
export function createBuiltins(options: {
  title: string;
  spaceKey: string;
  spaceName?: string;
  parentId?: string | null;
  parentTitle?: string | null;
  user?: {
    email: string;
    displayName: string;
    accountId: string;
  };
}): BuiltinVariables {
  const now = new Date();
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  return {
    NOW: now.toISOString(),
    TODAY: now.toISOString().split("T")[0],
    YEAR: String(now.getFullYear()),
    MONTH: String(now.getMonth() + 1).padStart(2, "0"),
    DAY: String(now.getDate()).padStart(2, "0"),
    TIME: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    WEEKDAY: days[now.getDay()],
    USER: options.user ?? {
      email: "",
      displayName: "",
      accountId: "",
    },
    SPACE: {
      key: options.spaceKey,
      name: options.spaceName ?? options.spaceKey,
    },
    PARENT: {
      id: options.parentId ?? null,
      title: options.parentTitle ?? null,
    },
    TITLE: options.title,
    UUID: randomUUID(),
    ENV: Object.fromEntries(
      Object.entries(process.env)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, v as string])
    ),
  };
}

/**
 * Resolve a built-in variable path like "USER.displayName" or "ENV.HOME".
 */
export function resolveBuiltin(builtins: BuiltinVariables, path: string): unknown {
  const parts = path.split(".");

  // Handle RANDOM:N syntax
  if (parts[0].startsWith("RANDOM:")) {
    const length = parseInt(parts[0].slice(7), 10);
    return randomString(isNaN(length) ? 6 : length);
  }

  let current: unknown = builtins;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Check if a variable name is a built-in variable.
 */
export function isBuiltinVariable(name: string): boolean {
  const builtinPrefixes = [
    "NOW",
    "TODAY",
    "YEAR",
    "MONTH",
    "DAY",
    "TIME",
    "WEEKDAY",
    "USER",
    "SPACE",
    "PARENT",
    "TITLE",
    "UUID",
    "ENV",
    "RANDOM",
  ];

  const firstPart = name.split(".")[0];
  // Handle RANDOM:N syntax
  if (firstPart.startsWith("RANDOM:")) return true;
  return builtinPrefixes.includes(firstPart);
}
