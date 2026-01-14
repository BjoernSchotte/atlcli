import { randomUUID } from "node:crypto";

/**
 * Context for generating built-in variables.
 */
export interface BuiltinContext {
  user?: string; // Current user display name
  space?: string; // Current space key
  profile?: string; // Current profile name
  dateFormat?: string; // Date format string (default: YYYY-MM-DD)
  title?: string; // Page title (for page creation)
  parentId?: string; // Parent page ID
  parentTitle?: string; // Parent page title
}

/**
 * Format a date according to the given format string.
 * Supports: YYYY, MM, DD, HH, mm, ss
 */
export function formatDate(date: Date, format: string): string {
  const year = date.getFullYear().toString();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");

  return format
    .replace("YYYY", year)
    .replace("MM", month)
    .replace("DD", day)
    .replace("HH", hours)
    .replace("mm", minutes)
    .replace("ss", seconds);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Get all built-in variables for template rendering.
 * All built-in variables use the @ prefix.
 */
export function getBuiltinVariables(ctx: BuiltinContext): Record<string, unknown> {
  const now = new Date();
  const dateFormat = ctx.dateFormat ?? "YYYY-MM-DD";

  return {
    // Date/time variables
    date: formatDate(now, dateFormat),
    datetime: now.toISOString(),
    time: formatDate(now, "HH:mm"),
    year: now.getFullYear().toString(),
    month: (now.getMonth() + 1).toString().padStart(2, "0"),
    day: now.getDate().toString().padStart(2, "0"),
    weekday: WEEKDAYS[now.getDay()],

    // Context variables
    user: ctx.user ?? "",
    space: ctx.space ?? "",
    profile: ctx.profile ?? "",

    // Page context (for page creation)
    title: ctx.title ?? "",
    parent: {
      id: ctx.parentId ?? "",
      title: ctx.parentTitle ?? "",
    },

    // Utilities
    uuid: randomUUID(),
  };
}

/**
 * List of all built-in variable names (without @ prefix).
 */
export const BUILTIN_VARIABLE_NAMES = [
  "date",
  "datetime",
  "time",
  "year",
  "month",
  "day",
  "weekday",
  "user",
  "space",
  "profile",
  "title",
  "parent",
  "uuid",
] as const;

export type BuiltinVariableName = (typeof BUILTIN_VARIABLE_NAMES)[number];
