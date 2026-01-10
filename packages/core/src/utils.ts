import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ParsedArgs = {
  _: string[];
  flags: Record<string, string | boolean>;
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
} as const;

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (token.startsWith("--")) {
      const [keyRaw, valueRaw] = token.slice(2).split("=", 2);
      const key = keyRaw.trim();
      if (!key) continue;
      if (valueRaw !== undefined) {
        flags[key] = valueRaw;
        continue;
      }
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }

  return { _: positional, flags };
}

export function getFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  if (typeof value === "string") return value;
  return undefined;
}

export function hasFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || typeof flags[key] === "string";
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
