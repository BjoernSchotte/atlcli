/**
 * Context for generating built-in variables.
 */
export interface BuiltinContext {
  user?: string; // Current user display name
  space?: string; // Current space key
  profile?: string; // Current profile name
  dateFormat?: string; // Date format string (default: YYYY-MM-DD)
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

    // Context variables
    user: ctx.user ?? "",
    space: ctx.space ?? "",
    profile: ctx.profile ?? "",
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
  "user",
  "space",
  "profile",
] as const;

export type BuiltinVariableName = (typeof BUILTIN_VARIABLE_NAMES)[number];
