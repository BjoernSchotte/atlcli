/**
 * `atlcli wiki export <page> --format pdf` — the headless PDF export command
 * (spec 008 T3.2/T3.3). The CLI is just another `PdfExportEnv`: token-auth asset
 * resolver, the lazily-loaded Bun compiler (`export-pdf-assets.ts`), and a
 * strict atomic filesystem sink.
 *
 * Report/error-boundary contract (T3.2): this module NEVER calls `fail()` and
 * never lets an error escape `exportPdf()`. It returns a typed
 * {@link ExportOutcome}; the command entry point (`handleExport`) turns that into
 * stdout output and the exit code via the single `emitReportOutcome` sink.
 *
 * Host adapters here (`cliPdfAssetResolver`, `filePdfOutputSink`) take no CLI
 * `flags`/`opts` — pure Node ports, so their eventual extraction into
 * `@atlcli/export-node` (A5(c)) is a mechanical move.
 */
import { lstat, open, rename, link, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { OutputOptions } from "@atlcli/core";
import {
  storageToBlocks,
  resolveExportMentions,
  type ConfluenceClient,
  type ExportBlock,
  type ExportNote,
} from "@atlcli/confluence";
import {
  normalizePdfLocale,
  runPdfExport,
  type PdfAssetRef,
  type PdfAssetResolver,
  type PdfExportMetadata,
  type PdfOutputSink,
  type PdfResolvedAsset,
} from "@atlcli/pdf";
import {
  buildReport,
  classifyError,
  noteToIssue,
  pdfReportContributions,
  type ExportOutcome,
  type Issue,
  type SourcePageEntry,
} from "./export-report.js";
import type { ParsedExportRequest } from "./export-request.js";
import { createAssetByteCache, tokenAssetFetcher, tokenMentionLookup } from "./export-internals.js";
import { getPdfCompiler } from "./export-pdf-assets.js";

/**
 * A thrown error that maps to a specific usage/config exit (1) — for local input
 * mistakes (bad page ref, sink containment/clobber) that are not remote errors.
 */
export class PdfUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfUsageError";
  }
}

/**
 * The strict PDF filesystem sink (T3.2). Deliberately stricter than the DOCX
 * `fileOutputSink`, which writes directly:
 *   - temp file created exclusively (`wx`) with a random suffix (collision-safe
 *     under concurrent invocations) and 0600 perms, in the SAME directory so the
 *     commit never crosses a filesystem boundary;
 *   - refuses to commit through a symlink, directory, or special file at the
 *     target path;
 *   - commits via an atomic no-replace primitive (`link` + `unlink`), so two
 *     racing writers never clobber each other — the loser fails cleanly;
 *   - `force` overwrites ONLY a pre-existing regular file (never a symlink or
 *     directory), via an atomic replacing `rename`;
 *   - the temp file is always removed in a `finally` on failure, so a
 *     killed/failed export never leaves a partial file for a CI artifact step.
 */
export function filePdfOutputSink(targetPath: string, opts: { force?: boolean } = {}): PdfOutputSink {
  return {
    async emit(_name: string, bytes: Uint8Array, context?: { signal?: AbortSignal }): Promise<void> {
      context?.signal?.throwIfAborted();
      const path = resolve(targetPath);
      const dir = dirname(path);

      // Inspect any existing target WITHOUT following symlinks.
      let existing: Awaited<ReturnType<typeof lstat>> | null = null;
      try {
        existing = await lstat(path);
      } catch {
        existing = null;
      }
      if (existing) {
        if (existing.isSymbolicLink()) {
          throw new PdfUsageError(`Refusing to write through a symlink at ${path}.`);
        }
        if (existing.isDirectory()) {
          throw new PdfUsageError(`Output path ${path} is a directory.`);
        }
        if (!existing.isFile()) {
          throw new PdfUsageError(`Output path ${path} is not a regular file.`);
        }
        if (!opts.force) {
          throw new PdfUsageError(`Output file already exists: ${path} (use --force to overwrite).`);
        }
      }

      const unique = `${process.pid.toString(36)}${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2)}`;
      const tmp = join(dir, `.${basename(path)}.${unique}.tmp`);
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.close();
        context?.signal?.throwIfAborted();
        if (existing && opts.force) {
          // Overwrite an existing regular file atomically.
          await rename(tmp, path);
        } else {
          // No-replace commit: link fails with EEXIST if someone raced us, so
          // no-clobber holds under concurrency. Then drop the temp name.
          await link(tmp, path);
          await unlink(tmp);
        }
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(tmp).catch(() => {});
        throw error;
      }
    },
  };
}

/**
 * The CLI's token-auth {@link PdfAssetResolver}. Reuses `tokenAssetFetcher` +
 * `createAssetByteCache` (the same attachment-listing `downloadUrl` resolution
 * the DOCX path uses), adapting its `Uint8Array` return to a
 * {@link PdfResolvedAsset}. Media type is left as `application/octet-stream` so
 * `preparePdfDocument` sniffs it from the bytes (its declared-vs-sniffed check
 * short-circuits on octet-stream) — a single source of truth for the type.
 */
export function cliPdfAssetResolver(
  client: ConfluenceClient,
  baseUrl: string,
  options: { noCache?: boolean } = {}
): PdfAssetResolver {
  // `--no-cache`: route the disk cache into a per-process temp directory so
  // nothing persists across invocations (CI runners). Otherwise use the shared
  // `~/.atlcli/cache/assets` store.
  const cache = options.noCache
    ? createAssetByteCache(baseUrl, join(tmpdir(), `atlcli-pdf-nocache-${process.pid.toString(36)}`))
    : createAssetByteCache(baseUrl);
  const fetcher = tokenAssetFetcher(client, cache);
  return {
    async resolve(ref: PdfAssetRef, context?: { signal?: AbortSignal }): Promise<PdfResolvedAsset> {
      const url = ref.kind === "attachment" ? (ref.filename ?? "") : (ref.url ?? "");
      const bytes = await fetcher.fetch(
        {
          url,
          ...(ref.pageId ? { pageId: ref.pageId } : {}),
          ...(ref.filename ? { filename: ref.filename } : {}),
        },
        context?.signal ? { signal: context.signal } : {}
      );
      return {
        bytes,
        mediaType: "application/octet-stream",
        ...(ref.filename ? { filename: ref.filename } : {}),
      };
    },
  };
}

/**
 * Resolve `--exported-at <ISO8601>` / `SOURCE_DATE_EPOCH` to a fixed timestamp
 * (reproducible builds) or `undefined` to fall back to `new Date()`.
 */
export function resolveExportedAt(raw: string | undefined): Date | undefined {
  if (raw) {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) throw new PdfUsageError(`Invalid --exported-at value: ${raw}.`);
    return date;
  }
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000);
  return undefined;
}

/** Throwing page-ref resolver (the boundary turns throws into a report). */
async function resolvePageIdThrowing(
  client: ConfluenceClient,
  ref: string,
  signal?: AbortSignal
): Promise<string> {
  if (/^\d+$/.test(ref)) return ref;
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    const match = ref.match(/pages\/(\d+)/) ?? ref.match(/pageId=(\d+)/);
    if (match) return match[1];
    throw new PdfUsageError(`Could not extract page ID from URL: ${ref}`);
  }
  if (ref.includes(":")) {
    const [spaceKey, ...titleParts] = ref.split(":");
    const cql = `type=page AND space="${spaceKey}" AND title="${titleParts.join(":")}"`;
    const results = await client.searchPages(cql, 1, signal ? { signal } : {});
    if (results.length === 0) throw new PdfUsageError(`Page not found: ${ref}`);
    return results[0].id;
  }
  throw new PdfUsageError(`Invalid page reference: ${ref}. Use ID, SPACE:Title, or URL.`);
}

/** Derive a deterministic slugified filename for `--out-dir`. */
function slugFilename(pageId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${pageId}${slug ? `-${slug}` : ""}.pdf`;
}

export interface ExportPdfArgs {
  client: ConfluenceClient;
  profile: { name?: string; email?: string };
  request: ParsedExportRequest;
  baseUrl: string;
  outputPath?: string;
  outDir?: string;
  force: boolean;
  strict: boolean;
  noCache: boolean;
  exportedAt?: Date;
  opts: OutputOptions;
}

/**
 * The PDF export host wiring. Returns a typed {@link ExportOutcome} — never
 * throws past this boundary, never calls `fail()`.
 */
export async function exportPdf(args: ExportPdfArgs): Promise<ExportOutcome> {
  const { client, request, baseUrl, strict, opts } = args;
  const startedAt = Date.now();

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const format = "pdf" as const;

  try {
    // --- resolve the single page (T3.2). Tree/space scope is wired in T3.3. ---
    const pageId = await resolvePageIdThrowing(client, request.pageRef!, controller.signal);
    const page = await client.getPageDetails(pageId, { signal: controller.signal });
    const spaceKey = page.spaceKey ?? "UNKNOWN";

    // Walk storage WITH page context so attachment ImageSources carry pageId
    // (needed by the token asset resolver's (pageId, filename) lookup).
    const { blocks: rawBlocks, notes: walkNotes } = storageToBlocks(page.storage, {
      exporter: "pdf",
      pageContext: { id: pageId, ...(page.version ? { version: page.version } : {}), spaceKey },
    });

    // Resolve @mentions to display names, matching the extension pipeline
    // (parity gap the CLI had until now).
    const mention = await resolveExportMentions(rawBlocks, tokenMentionLookup(client));
    const blocks: ExportBlock[] = mention.blocks;
    const sourceNotes: ExportNote[] = [...walkNotes];
    if (mention.unresolved > 0) {
      sourceNotes.push({
        level: "warning",
        code: "mention-unresolved",
        message: `${mention.unresolved} mention(s) could not be resolved to a display name.`,
      });
    }

    const locale = normalizePdfLocale(undefined);
    const metadata: PdfExportMetadata = {
      title: page.title,
      space: spaceKey,
      ...(page.version !== undefined ? { version: page.version } : {}),
      ...(page.createdBy?.displayName ? { author: page.createdBy.displayName } : {}),
      exporter: "atlcli",
      language: locale.language,
      ...(locale.region ? { region: locale.region } : {}),
      exportedAt: args.exportedAt ?? new Date(),
    };

    // Choose the output path: --output names the file; --out-dir chooses a
    // directory and derives a deterministic filename.
    const outputPath = args.outDir
      ? join(resolve(args.outDir), slugFilename(pageId, page.title))
      : resolve(args.outputPath!);

    const compiler = await getPdfCompiler();
    const report = await runPdfExport(
      {
        blocks,
        sourceNotes,
        metadata,
        filename: basename(outputPath),
        signal: controller.signal,
      },
      {
        assets: cliPdfAssetResolver(client, baseUrl, { noCache: args.noCache }),
        compiler,
        output: filePdfOutputSink(outputPath, { force: args.force }),
      }
    );

    const sourcePages: SourcePageEntry[] = [
      { id: pageId, title: page.title, notes: walkNotes.map((n) => noteToIssue(n, "compose", pageId)) },
    ];
    const { outputDetail, issues } = pdfReportContributions(report, outputPath, report.compilerDiagnostics);
    const allIssues: Issue[] = [
      ...issues,
      ...(mention.unresolved > 0
        ? [{ code: "mention-unresolved", severity: "warning" as const, phase: "prepare", retryable: false }]
        : []),
    ];

    return {
      ok: true,
      report: buildReport({
        format,
        sourcePages,
        outputDetails: [outputDetail],
        issues: allIssues,
        timings: { ...report.timings, totalMs: Date.now() - startedAt },
        strict,
      }),
    };
  } catch (error) {
    const classified =
      error instanceof PdfUsageError
        ? { exitCode: 1, issue: { code: "usage-error", severity: "error" as const, phase: "usage", retryable: false, message: error.message } }
        : classifyError(error);
    return {
      ok: false,
      report: buildReport({
        format,
        sourcePages: [],
        outputDetails: [],
        issues: [classified.issue],
        timings: { totalMs: Date.now() - startedAt },
        failureExitCode: classified.exitCode,
      }),
    };
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
