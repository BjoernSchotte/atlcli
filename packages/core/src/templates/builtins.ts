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
  now?: Date; // Frozen clock (plans, --now); dates then render in UTC, the same on every machine
  project?: string; // Target Jira project key
  seed?: string; // What makes @uuid differ under one frozen clock (unit, source key)
}

/** Calendar fields of `date`, local or UTC. */
function fields(date: Date, utc: boolean) {
  return utc
    ? { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate(), wd: date.getUTCDay(), h: date.getUTCHours(), min: date.getUTCMinutes(), s: date.getUTCSeconds() }
    : { y: date.getFullYear(), m: date.getMonth(), d: date.getDate(), wd: date.getDay(), h: date.getHours(), min: date.getMinutes(), s: date.getSeconds() };
}

/**
 * Format a date according to the given format string.
 * Supports: YYYY, MM, DD, HH, mm, ss. `utc` reads the UTC calendar.
 */
export function formatDate(date: Date, format: string, utc = false): string {
  const f = fields(date, utc);
  const year = f.y.toString();
  const month = (f.m + 1).toString().padStart(2, "0");
  const day = f.d.toString().padStart(2, "0");
  const hours = f.h.toString().padStart(2, "0");
  const minutes = f.min.toString().padStart(2, "0");
  const seconds = f.s.toString().padStart(2, "0");

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
/** ISO 8601 week number of `d`. */
function isoWeek(d: Date, utc: boolean): number {
  const f = fields(d, utc);
  const t = new Date(Date.UTC(f.y, f.m, f.d));
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
  // A frozen clock must give the same dates wherever the plan is made again.
  const utc = ctx.now !== undefined;
  const f = fields(now, utc);
  const dateFormat = ctx.dateFormat ?? "YYYY-MM-DD";
  const iso = now.toISOString();

  return {
    // Date/time variables; @today is always ISO so it feeds dateAdd
    date: formatDate(now, dateFormat, utc),
    today: formatDate(now, "YYYY-MM-DD", utc),
    datetime: iso,
    now: iso,
    time: formatDate(now, "HH:mm", utc),
    year: f.y.toString(),
    month: (f.m + 1).toString().padStart(2, "0"),
    day: f.d.toString().padStart(2, "0"),
    weekday: WEEKDAYS[f.wd],
    quarter: String(Math.floor(f.m / 3) + 1),
    week: String(isoWeek(now, utc)).padStart(2, "0"),

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
    uuid: uuid(ctx.now ? `${iso}#${ctx.seed ?? ""}` : undefined),
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
