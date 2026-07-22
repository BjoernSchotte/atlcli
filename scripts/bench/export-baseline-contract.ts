import type { LargeExportCorpus } from "@atlcli/export-fixtures";

export const EXPORT_BASELINE_SCHEMA = "atlcli.pre-queue-export-baseline/1" as const;
export const EXPORT_BASELINE_DEFAULT_SEED = 0x9e37_79b9;

export type ExportBaselineFormat = "docx" | "pdf";
export type ExportBaselinePages = 50 | 500;

export interface ExportBaselineCliOptions {
  pages: ExportBaselinePages[];
  formats: ExportBaselineFormat[];
  repeat: number;
  seed: number;
  out?: string;
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function parseList<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  label: string,
): T[] {
  const values = (raw ?? allowed.join(",")).split(",").filter(Boolean);
  if (values.length === 0 || values.some((value) => !allowed.includes(value as T))) {
    throw new Error(`${label} must be ${allowed.join(", ")} (comma-separated).`);
  }
  return values as T[];
}

export function parseExportBaselineArgs(args: readonly string[]): ExportBaselineCliOptions {
  const pages = parseList(valueAfter(args, "--pages"), ["50", "500"] as const, "--pages").map(
    Number,
  ) as ExportBaselinePages[];
  const formats = parseList(
    valueAfter(args, "--formats"),
    ["docx", "pdf"] as const,
    "--formats",
  );
  const repeat = Number(valueAfter(args, "--repeat") ?? "3");
  const seed = Number(valueAfter(args, "--seed") ?? EXPORT_BASELINE_DEFAULT_SEED);
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20) {
    throw new Error("--repeat must be an integer from 1 to 20.");
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("--seed must be an unsigned 32-bit integer.");
  }
  return {
    pages,
    formats,
    repeat,
    seed: seed >>> 0,
    ...(valueAfter(args, "--out") ? { out: valueAfter(args, "--out") } : {}),
  };
}

/** Exact logical bytes presented to a future durable queue, not storage-engine overhead. */
export function logicalCorpusBytes(corpus: LargeExportCorpus): number {
  return (
    new TextEncoder().encode(JSON.stringify(corpus.nodes)).byteLength +
    corpus.assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0)
  );
}
