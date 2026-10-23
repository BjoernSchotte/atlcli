import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ParsedArgs = {
  _: string[];
  flags: Record<string, string | boolean | string[]>;
};

export type OutputOptions = {
  json: boolean;
};

export const ERROR_CODES = {
  USAGE: "ATLCLI_ERR_USAGE",
  AUTH: "ATLCLI_ERR_AUTH",
  API: "ATLCLI_ERR_API",
  IO: "ATLCLI_ERR_IO",
  CONFIG: "ATLCLI_ERR_CONFIG",
  VALIDATION: "ATLCLI_ERR_VALIDATION",
  FORBIDDEN: "ATLCLI_ERR_FORBIDDEN",
  NOT_FOUND: "ATLCLI_ERR_NOT_FOUND",
  RATE_LIMIT: "ATLCLI_ERR_RATE_LIMIT",
} as const;

const HTTP_ERROR_CODES: Record<number, string> = {
  401: ERROR_CODES.AUTH,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.NOT_FOUND,
  429: ERROR_CODES.RATE_LIMIT,
};

/**
 * An uncaught error as the `--json` error object: an API error's HTTP status
 * (its `status`, or "API error (403)" in the message) picks the code.
 */
export function describeError(err: unknown): { code: string; message: string; details: Record<string, unknown> } {
  const message = err instanceof Error ? err.message : String(err);
  const own = (err as { status?: unknown } | null)?.status;
  const status = typeof own === "number" ? own : Number(/API error \((\d{3})\)/.exec(message)?.[1]) || undefined;
  if (status === undefined) return { code: ERROR_CODES.API, message, details: {} };
  return { code: HTTP_ERROR_CODES[status] ?? ERROR_CODES.API, message, details: { status } };
}

/**
 * Long flags that never take a value, so `--json PROJ-1` keeps `PROJ-1` as a
 * positional. Only flags that every command reads as a switch belong here.
 */
const SWITCHES = new Set([
  "all", "all-projects", "all-results", "confirm", "csv", "debug", "delete-folders", "details", "dry-run", "edit",
  "force", "help", "history", "internal", "json", "markdown", "no-color", "no-headers", "no-log", "plain", "quiet",
  "refresh-users", "skip-user-check", "system", "validate", "verbose", "watching", "yes",
]);

/** A token that starts a new flag; anything else after a flag is its value ("- item", "-5", "-"). */
function isFlagToken(token: string): boolean {
  return /^(--|-[A-Za-z])/.test(token);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  const addFlag = (key: string, value: string | boolean) => {
    const existing = flags[key];
    if (existing === undefined) {
      flags[key] = value;
    } else if (Array.isArray(existing)) {
      if (typeof value === "string") {
        existing.push(value);
      }
    } else if (typeof existing === "string" && typeof value === "string") {
      flags[key] = [existing, value];
    }
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (token.startsWith("--")) {
      // Long flag: --key or --key=value; the value is everything after the first "=".
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const key = (eq === -1 ? body : body.slice(0, eq)).trim();
      if (!key) continue;
      if (eq !== -1) {
        addFlag(key, body.slice(eq + 1));
        continue;
      }
      const next = argv[i + 1];
      if (!SWITCHES.has(key) && next !== undefined && next !== "" && !isFlagToken(next)) {
        addFlag(key, next);
        i += 1;
      } else {
        addFlag(key, true);
      }
    } else if (token.startsWith("-") && token.length > 1 && !token.startsWith("--")) {
      // Short flag: -x or -x value or -xyz (multiple boolean flags)
      const flags_part = token.slice(1);
      // Check if it's a single letter followed by =
      if (flags_part.includes("=")) {
        const eq = flags_part.indexOf("=");
        addFlag(flags_part.slice(0, eq), flags_part.slice(eq + 1));
        continue;
      }
      // Check if single letter with next arg as value
      if (flags_part.length === 1) {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          addFlag(flags_part, next);
          i += 1;
        } else {
          addFlag(flags_part, true);
        }
      } else {
        // Multiple flags like -abc → a=true, b=true, c=true
        for (const char of flags_part) {
          addFlag(char, true);
        }
      }
    } else {
      positional.push(token);
    }
  }

  return { _: positional, flags };
}

export function getFlag(flags: Record<string, string | boolean | string[]>, key: string): string | undefined {
  const value = flags[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

export function getFlags(flags: Record<string, string | boolean | string[]>, key: string): string[] {
  const value = flags[key];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  return [];
}

export function hasFlag(flags: Record<string, string | boolean | string[]>, key: string): boolean {
  const value = flags[key];
  return value === true || typeof value === "string" || (Array.isArray(value) && value.length > 0);
}

/**
 * Drops C0/C1 control characters except tab, newline and SGR color sequences
 * (`ESC[…m`, which renderers such as the page diff emit), so server-provided
 * text cannot move the cursor, rewrite earlier lines or set the window title.
 */
export function stripControlChars(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (match) => (match.length > 1 ? match : ""));
}

export function output(data: unknown, opts: OutputOptions): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  if (typeof data === "string") {
    process.stdout.write(`${stripControlChars(data)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function fail(
  opts: OutputOptions,
  code: number,
  errCode: string,
  message: string,
  details?: Record<string, unknown>
): never {
  if (opts.json) {
    output(
      {
        error: {
          code: errCode,
          message,
          details: details ?? {},
        },
      },
      opts
    );
  } else {
    process.stderr.write(`${stripControlChars(message)}\n`);
  }
  process.exit(code);
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, contents, "utf8");
}

/**
 * Check if running in an interactive terminal (not CI/CD, not piped).
 */
export function isInteractive(): boolean {
  const ciEnvVars = [
    "CI",
    "CONTINUOUS_INTEGRATION",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "CIRCLECI",
    "JENKINS",
    "TRAVIS",
    "BUILDKITE",
  ];
  const isCI = ciEnvVars.some((v) => process.env[v]);
  return Boolean(process.stdout.isTTY) && !isCI;
}
