import pdfiumWasm from "@atlcli/import-pdf/wasm" with { type: "file" };
import { basename, isAbsolute, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  ERROR_CODES,
  fail,
  getActiveProfile,
  getFlag,
  hasFlag,
  loadConfig,
  output,
  resolveDeploymentType,
  sha256Hex,
  type OutputOptions,
} from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import {
  buildPdfImportReview,
  createPdfiumFactsAdapter,
  isPdfImportError,
  parsePdfImportOverrides,
  parsePdfSplitPolicy,
  pdfImportReviewReport,
  renderPdfImportReview,
  type ParsedPdfImportOverridesV1,
  type PdfReadingOrderModeV1,
  type PdfReviewTargetV1,
  type PdfScanPolicyV1,
} from "@atlcli/import-pdf";
import { assertCliAuthSupported } from "./session-guard.js";

const DOCX_ONLY_FLAGS = [
  "map-style",
  "revisions",
  "comments",
  "recipe",
  "recipe-id",
  "manifest",
  "update-page",
  "expect-version",
  "skip-existing",
] as const;

const VALUE_FLAGS = [
  "format",
  "from-page",
  "attachment",
  "space",
  "title",
  "parent",
  "split",
  "max-wiki-pages",
  "scan-policy",
  "reading-order",
  "unsupported",
  "overrides",
  "title-conflict",
  "profile",
] as const;

function assetFilePath(imported: string): string {
  return isAbsolute(imported) ? imported : resolve(import.meta.dir, imported);
}

async function readStdin(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
  }
  const byteLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function validateChoice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
  fallback: T,
  opts: OutputOptions,
): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `${flag} must be ${allowed.join("|")}.`, {});
  }
  return value as T;
}

function rejectDocxOnlyFlags(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
): void {
  const found = DOCX_ONLY_FLAGS.filter((flag) => hasFlag(flags, flag));
  if (found.length > 0) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `DOCX-only option(s) cannot be used with PDF: ${found.map((flag) => `--${flag}`).join(", ")}.`, {
      flags: found,
    });
  }
}

async function loadOverrides(
  path: string | undefined,
  sourceSha256: string,
  opts: OutputOptions,
): Promise<ParsedPdfImportOverridesV1 | undefined> {
  if (!path) return undefined;
  try {
    return await parsePdfImportOverrides(await readFile(path, "utf8"), sourceSha256);
  } catch (error) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `Invalid PDF override file: ${(error as Error).message}`, { file: path });
  }
}

export async function handlePdfWikiImport(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
): Promise<void> {
  rejectDocxOnlyFlags(flags, opts);
  for (const flag of VALUE_FLAGS) {
    if (hasFlag(flags, flag) && getFlag(flags, flag) === undefined) {
      fail(opts, 1, ERROR_CODES.VALIDATION, `--${flag} requires a value.`, {});
    }
  }
  const [file] = args;
  const fromPage = getFlag(flags, "from-page");
  const attachmentName = getFlag(flags, "attachment");
  if (args.length > 1) fail(opts, 1, ERROR_CODES.VALIDATION, "PDF batch import is deferred; provide exactly one PDF.", {});
  if (file && fromPage) fail(opts, 1, ERROR_CODES.VALIDATION, "Give either a local PDF OR --from-page, not both.", {});
  if (!file && !fromPage) fail(opts, 1, ERROR_CODES.VALIDATION, "Provide a local PDF or --from-page with --attachment.", {});
  if (fromPage && !attachmentName) fail(opts, 1, ERROR_CODES.VALIDATION, "--from-page requires --attachment <name.pdf>.", {});
  if (hasFlag(flags, "confirm") && hasFlag(flags, "dry-run")) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "--confirm and --dry-run are mutually exclusive.", {});
  }
  const splitPolicy = (() => {
    try {
      return parsePdfSplitPolicy(getFlag(flags, "split"), getFlag(flags, "max-wiki-pages"));
    } catch (error) {
      fail(opts, 1, ERROR_CODES.VALIDATION, (error as Error).message, {});
    }
  })();
  const readingOrder = validateChoice(
    getFlag(flags, "reading-order"),
    ["auto", "tags", "geometry"] as const,
    "--reading-order",
    "auto",
    opts,
  ) as PdfReadingOrderModeV1;
  const scanPolicy = validateChoice(
    getFlag(flags, "scan-policy"),
    ["fail", "page-image", "report"] as const,
    "--scan-policy",
    "fail",
    opts,
  ) as PdfScanPolicyV1;
  const unsupported = validateChoice(
    getFlag(flags, "unsupported"),
    ["report", "fail"] as const,
    "--unsupported",
    "report",
    opts,
  );
  const titleConflict = validateChoice(
    getFlag(flags, "title-conflict"),
    ["fail", "rename"] as const,
    "--title-conflict",
    "fail",
    opts,
  );
  const spaceFlag = getFlag(flags, "space");
  const confirm = hasFlag(flags, "confirm");
  let profile: Awaited<ReturnType<typeof getActiveProfile>> | undefined;
  if (confirm || fromPage || !spaceFlag) {
    const config = await loadConfig();
    profile = getActiveProfile(config, getFlag(flags, "profile"));
    if (!profile) fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", {});
    assertCliAuthSupported(profile, opts);
  }
  let bytes: Uint8Array;
  if (fromPage) {
    const client = new ConfluenceClient(profile!);
    const attachments = await client.listAttachments(fromPage);
    const attachment = attachments.find((candidate) => candidate.filename === attachmentName);
    if (!attachment) {
      fail(opts, 1, ERROR_CODES.API, `Attachment ${JSON.stringify(attachmentName)} was not found on the source page.`, {
        available: attachments.map((candidate) => candidate.filename).slice(0, 20),
      });
    }
    bytes = await client.downloadAttachment(attachment);
  } else if (file === "-") {
    if (getFlag(flags, "format") !== "pdf") fail(opts, 1, ERROR_CODES.VALIDATION, "stdin import requires --format pdf.", {});
    bytes = await readStdin();
  } else {
    try {
      bytes = new Uint8Array(await readFile(file!));
    } catch (error) {
      fail(opts, 1, ERROR_CODES.VALIDATION, `Cannot read PDF: ${(error as Error).message}`, { file });
    }
  }
  if (bytes.byteLength < 5 || new TextDecoder("ascii").decode(bytes.subarray(0, 5)) !== "%PDF-") {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Format mismatch: selected PDF input does not have a PDF byte signature.", {});
  }
  const sourceName = file === "-" ? "stdin.pdf" : file ?? attachmentName!;
  const rootTitle = getFlag(flags, "title") ?? basename(sourceName, ".pdf");
  const spaceKey = spaceFlag ?? profile?.space;
  if (!spaceKey) fail(opts, 1, ERROR_CODES.VALIDATION, "No space given. Use --space <KEY> or set a profile space.", {});
  const deployment = profile
    ? resolveDeploymentType(profile) === "cloud" ? "cloud" : "data-center"
    : "unresolved-offline";
  const target: PdfReviewTargetV1 = {
    spaceKey,
    title: rootTitle,
    ...(getFlag(flags, "parent") ? { parentId: getFlag(flags, "parent") } : {}),
    deployment,
    supportsPageTree: deployment === "cloud" ? true : deployment === "data-center" ? false : null,
    evidence: profile ? "profile" : "offline-unresolved",
  };
  try {
    const wasm = new Uint8Array(await readFile(assetFilePath(pdfiumWasm)));
    const adapter = createPdfiumFactsAdapter({ wasmBinary: wasm });
    const sourceSha256 = await sha256Hex(bytes);
    const overrides = await loadOverrides(getFlag(flags, "overrides"), sourceSha256, opts);
    const review = await buildPdfImportReview(bytes, adapter, {
      target,
      splitPolicy,
      titleConflict,
      readingOrder,
      scanPolicy,
      unsupported,
      attachSource: hasFlag(flags, "attach-source"),
      overrides,
    });
    if (!confirm || hasFlag(flags, "dry-run")) {
      output(opts.json ? pdfImportReviewReport(review) : renderPdfImportReview(review), opts);
      return;
    }
    if (
      scanPolicy === "report"
      && review.pages.some((page) => page.fallback === "reported")
      && (unsupported !== "report" || !hasFlag(flags, "accept-reported-pages"))
    ) {
      fail(
        opts,
        1,
        ERROR_CODES.VALIDATION,
        "Reported source pages require both --unsupported report and --accept-reported-pages before publication.",
        {},
      );
    }
    if (review.blockers.length > 0) {
      fail(opts, 1, ERROR_CODES.VALIDATION, `PDF publication is blocked:\n  ${review.blockers.join("\n  ")}`, {
        planDigest: review.planDigest,
        blockers: review.blockers,
      });
    }
    if (deployment === "data-center" && review.split.resolved.kind === "page-tree") {
      fail(
        opts,
        1,
        ERROR_CODES.VALIDATION,
        `Data Center cannot publish the resolved ${review.split.totalWikiPages}-page PDF tree; it is not flattened.`,
        { pages: review.split.totalWikiPages },
      );
    }
    fail(
      opts,
      1,
      ERROR_CODES.VALIDATION,
      "PDF publication is not enabled until the shared transaction/readback task is complete; the digest-bound review plan made no writes.",
      { planDigest: review.planDigest },
    );
  } catch (error) {
    if (isPdfImportError(error)) {
      fail(opts, 1, ERROR_CODES.VALIDATION, `Rejected PDF import: ${error.message}`, {
        code: error.code,
        context: error.context,
      });
    }
    throw error;
  }
}
