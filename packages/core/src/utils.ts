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
} as const;

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
      const [keyRaw, valueRaw] = token.slice(2).split("=", 2);
      const key = keyRaw.trim();
      if (!key) continue;
      if (valueRaw !== undefined) {
        addFlag(key, valueRaw);
        continue;
      }
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        addFlag(key, next);
        i += 1;
      } else {
        addFlag(key, true);
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

export function output(data: unknown, opts: OutputOptions): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  if (typeof data === "string") {
    process.stdout.write(`${data}\n`);
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
    process.stderr.write(`${message}\n`);
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
