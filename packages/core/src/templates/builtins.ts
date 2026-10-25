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
  now?: Date; // Frozen clock (plans, --now); defaults to the current time
  project?: string; // Target Jira project key
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
/** ISO 8601 week number of `d` (local calendar). */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/**
 * RFC 4122 v4 layout. Derived from `seed` (FNV-1a) when one is given, so a
 * re-plan with the same --now repeats it; random otherwise.
 */
function uuid(seed?: string): string {
  if (seed === undefined) return globalThis.crypto.randomUUID();
  let hex = "";
  let h = 0x811c9dc5;
  for (let round = 0; hex.length < 32; round++) {
    for (const ch of `${seed}#${round}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    hex += h.toString(16).padStart(8, "0");
  }
  const s = hex.slice(0, 32).split("");
  s[12] = "4";
  s[16] = "89ab"[parseInt(s[16]!, 16) & 3]!;
  const j = s.join("");
  return `${j.slice(0, 8)}-${j.slice(8, 12)}-${j.slice(12, 16)}-${j.slice(16, 20)}-${j.slice(20)}`;
}

/**
 * Get all built-in variables for template rendering.
 * All built-in variables use the @ prefix.
 */
export function getBuiltinVariables(ctx: BuiltinContext): Record<string, unknown> {
  const now = ctx.now ?? new Date();
  const dateFormat = ctx.dateFormat ?? "YYYY-MM-DD";
  const iso = now.toISOString();

  return {
    // Date/time variables; @today is always ISO so it feeds dateAdd
    date: formatDate(now, dateFormat),
    today: formatDate(now, "YYYY-MM-DD"),
    datetime: iso,
    now: iso,
    time: formatDate(now, "HH:mm"),
    year: now.getFullYear().toString(),
    month: (now.getMonth() + 1).toString().padStart(2, "0"),
    day: now.getDate().toString().padStart(2, "0"),
    weekday: WEEKDAYS[now.getDay()],
    quarter: String(Math.floor(now.getMonth() / 3) + 1),
    week: String(isoWeek(now)).padStart(2, "0"),

    // Context variables
    user: ctx.user ?? "",
    space: ctx.space ?? "",
    profile: ctx.profile ?? "",
    project: ctx.project ?? "",

    // Page context (for page creation)
    title: ctx.title ?? "",
    parent: {
      id: ctx.parentId ?? "",
      title: ctx.parentTitle ?? "",
    },

    // Utilities
    uuid: uuid(ctx.now ? iso : undefined),
  };
}

/**
 * List of all built-in variable names (without @ prefix).
 */
export const BUILTIN_VARIABLE_NAMES = [
  "date",
  "today",
  "datetime",
  "now",
  "time",
  "year",
  "month",
  "day",
  "weekday",
  "quarter",
  "week",
  "user",
  "space",
  "profile",
  "project",
  "title",
  "parent",
  "uuid",
] as const;

export type BuiltinVariableName = (typeof BUILTIN_VARIABLE_NAMES)[number];
