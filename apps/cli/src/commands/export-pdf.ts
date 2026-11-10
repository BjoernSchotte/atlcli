/**
 * `atlcli wiki export <page> --format pdf` — the headless PDF export command
 * (spec 008 T3.2/T3.3). The CLI is just another `PdfExportEnv`: token-auth asset
 * resolver, the lazily-loaded Bun compiler (`export-pdf-assets.ts`), and a
 * strict atomic filesystem sink.
 *
 * Report/error-boundary contract (T3.2): this module NEVER calls `fail()` and
 * never lets an error escape `exportPdfAsOrdinaryJob()`. It returns a typed
 * {@link ExportOutcome}; the command entry point (`handleExport`) turns that into
 * stdout output and the exit code via the single `emitReportOutcome` sink.
 *
 * Host adapters here (`cliPdfAssetResolver`, `filePdfOutputSink`) take no CLI
 * `flags`/`opts` — pure Node ports, so their eventual extraction into
 * `@atlcli/export-node` (A5(c)) is a mechanical move.
 */
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { buildConfluenceUrl, type OutputOptions, type Profile } from "@atlcli/core";
import type { MacroResolutionOptions } from "@atlcli/export-macros";
import {
  exportSourcePolicyFromFlag,
  resolveExportMentions,
  type ComposeOptions,
  type ConfluenceClient,
  type ConfluencePageDetails,
  type ExportBlock,
  type ExportNote,
} from "@atlcli/confluence";
import {
  normalizePdfLocale,
  type PdfAssetRef,
  type PdfAssetResolver,
  type PdfExportMetadata,
  type PdfExportReport,
  type PdfOutputPolicyV1,
  type PdfResolvedAsset,
} from "@atlcli/pdf";
import type {
  ExportJobDerivationV1,
  PdfExportJobRequestV1,
  ResourceEstimateV1,
} from "@atlcli/export-jobs";
import { createFileExportJobPersistence } from "@atlcli/export-node";
import {
  buildReport,
  buildTreeExportReport,
  classifyConfluenceSourceError,
  classifyError,
  classifyFailedExportJob,
  noteToIssue,
  pdfReportContributions,
  type ExportOutcome,
  type SourcePageEntry,
} from "./export-report.js";
import {
  buildExportScope,
  buildScopeReportFields,
  type ParsedExportRequest,
  type ScopeReportFields,
} from "./export-request.js";
import { createAssetByteCache, tokenAssetFetcher, tokenMentionLookup } from "./export-internals.js";
import {
  defaultExternalAssetFetcher,
  defaultExternalAssetPolicy,
  trustRoutingPdfAssetResolver,
} from "@atlcli/export-wiring";
import {
  checkpointPdfAssetsV1,
  confluenceSourceResolverPortFromClientV1,
  createConfluencePdfResolveInputV1,
  createConfluenceSourcePlanSpoolV1,
  createExportTreeBodySpoolV1,
} from "@atlcli/export-wiring/jobs";
import { getPdfCompiler } from "./export-pdf-assets.js";
import {
  PdfUsageError,
  derivePdfOutputPath,
  filePdfOutputSink,
  sanitizePathComponent,
} from "./export-pdf-sink.js";
import {
  createOrdinaryPdfExecutorV1,
  readOrdinaryExportProjectionV1,
  runOrdinaryExportJobV1,
  writeOrdinaryExportProjectionV1,
} from "./export-job-runtime.js";
import { formatConfluenceHierarchyDiagnosticV1 } from "./export-job-monitor.js";

// Re-export the pure sink/path surface so existing callers keep importing from
// this module (no API change). The implementations live in export-pdf-sink.ts —
// a deliberately dependency-free module (no wasm/font imports) whose tests run
// on Windows CI where `packages/pdf/.fonts/` is not materialized.
export { PdfUsageError, derivePdfOutputPath, filePdfOutputSink, sanitizePathComponent };

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
 * The resolver the PDF export env actually gets: {@link cliPdfAssetResolver}
 * with the spec-004 trust router already composed around it.
 *
 * **Every `PdfExportEnv.assets` the CLI builds goes through here** — that is the
 * whole point of the function existing rather than the two lines being inlined
 * at the `runPdfExport` call. `trustRoutingPdfAssetResolver` had been written,
 * unit-tested, and then wired NOWHERE: only the DOCX path composed its sibling,
 * and this path handed `runPdfExport` a bare token resolver. That was harmless
 * only because the CLI PDF path resolves no macros yet, so nothing could mint a
 * `trust: "export-view"` ref — a latent gap that becomes a live SSRF the day
 * `macros` is passed here. Composing it unconditionally costs nothing today
 * (refs without that trust marker take the identical path) and cannot be
 * forgotten tomorrow.
 *
 * `apps/cli/src/commands/export-pdf-assets.test.ts` pins both halves: the
 * router is present, and no other construction site bypasses it.
 */
export function cliPdfAssets(
  client: ConfluenceClient,
  baseUrl: string,
  options: { noCache?: boolean } = {}
): PdfAssetResolver {
  return trustRoutingPdfAssetResolver(
    cliPdfAssetResolver(client, baseUrl, options),
    defaultExternalAssetFetcher(defaultExternalAssetPolicy(baseUrl))
  );
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

export interface ResolvedScope {
  metaPage: ConfluencePageDetails;
  blocks: ExportBlock[];
  sourceNotes: ExportNote[];
  complete: boolean;
  sourcePages: SourcePageEntry[];
  outNameKey: string;
  /**
   * Set ONLY for a single-page scope, to that page's id: the one
   * {@link sourcePages} entry's notes are exactly the walker notes that go into
   * the engine as {@link sourceNotes}, so the engine's reconciled list can be
   * projected back onto it after the export (spec 010). A tree/space scope
   * leaves this undefined — its per-page notes come from the per-page walk and
   * never enter the engine, so there is nothing to project back.
   */
  reconcilablePageId?: string;
  /**
   * Scope traceability for the report (spec 002 A5), built by the shared
   * {@link buildScopeReportFields}. Tree/space only — a single-page export has
   * no scope resolution to trace, matching the DOCX single-page path.
   */
  scopeReport?: ScopeReportFields;
  /**
   * `composeChapters(...).chapterAnchorById` — tree/space only. Macro
   * resolution runs after composition, so a renderer that links to other
   * Confluence pages (the Confluence-list datasource) reads composition's own
   * in-scope answer from here rather than resolving links a second way.
   */
  chapterAnchorById?: ReadonlyMap<string, string>;
}

/**
 * Build the spec-004 macro-resolution options for the PDF env.
 *
 * The PDF path used to pass NO `macros`, so every dynamic macro on a page —
 * Jira tables, includes, the `export_view` catch-all — degraded to a
 * placeholder that the report described as "not rendered", while the very same
 * page exported to DOCX with `--engine ts` rendered them live. That gap became
 * user-visible with datasource smart links: the modern Jira table is *only*
 * reachable through this chain, so without it a PDF export of a current-editor
 * page can never show the table.
 *
 * Mirrors `buildTsEngineMacroOptions` in `export.ts` (same profile → clients →
 * shared builder). The sink-side SSRF guard the chain requires is already in
 * place here: {@link cliPdfAssets} composes `trustRoutingPdfAssetResolver`
 * unconditionally, which is exactly the "cannot be forgotten tomorrow" it was
 * written for.
 */
export async function buildPdfMacroOptions(
  profile: Profile,
  client: ConfluenceClient,
  chapterAnchorById?: ReadonlyMap<string, string>,
  signal?: AbortSignal,
  /** `false` under `--no-live-macros`: only pure renderers run. */
  live = true,
): Promise<MacroResolutionOptions> {
  const [wiring, { JiraClient }] = await Promise.all([
    import("./export-macros-wiring.js"),
    import("@atlcli/jira"),
  ]);
  return wiring.buildMacroResolutionOptions({
    profile,
    confluence: client,
    // Cloud shares one site between Confluence and Jira; if Jira is not
    // accessible the chain degrades to a note, never a hard failure.
    jira: new JiraClient(profile),
    targetEngine: "pdf",
    live,
    ...(chapterAnchorById ? { chapterAnchorById } : {}),
    ...(signal ? { signal } : {}),
  });
}

export interface ExportPdfArgs {
  client: ConfluenceClient;
  /**
   * The resolved auth profile. Widened from `{ name?, email? }` when the macro
   * chain was wired in: the Jira port needs the real base URL + credentials,
   * exactly as the DOCX ts path already does.
   */
  profile: Profile;
  request: ParsedExportRequest;
  baseUrl: string;
  outputPath?: string;
  outDir?: string;
  force: boolean;
  strict: boolean;
  noCache: boolean;
  exportedAt?: Date;
  outputPolicy?: PdfOutputPolicyV1;
  opts: OutputOptions;
}

function cliConfluenceExternalUrlResolver(
  profile: Profile,
): NonNullable<ComposeOptions["resolveExternalUrl"]> {
  return (target, anchor) => {
    let path: string;
    if (target.contentId) {
      path = target.spaceKey
        ? `spaces/${target.spaceKey}/pages/${target.contentId}`
        : `pages/viewpage.action?pageId=${target.contentId}`;
    } else if (target.spaceKey) {
      path = `display/${target.spaceKey}/${encodeURIComponent(target.contentTitle)}`;
    } else {
      path = `search?text=${encodeURIComponent(target.contentTitle)}`;
    }
    const url = buildConfluenceUrl(
      profile as Parameters<typeof buildConfluenceUrl>[0],
      path,
    );
    return anchor ? `${url}#${anchor}` : url;
  };
}

/**
 * Queue-backed ordinary PDF command. The unresolved request is persisted by
 * {@link runOrdinaryExportJobV1} before the shared source resolver performs the first API
 * read; rendering then runs exclusively through the PR-C executor.
 */
export async function exportPdfAsOrdinaryJob(
  args: ExportPdfArgs,
  jobRequest: PdfExportJobRequestV1,
  derivedFrom?: ExportJobDerivationV1,
  suppliedPersistence?: ReturnType<typeof createFileExportJobPersistence>,
): Promise<ExportOutcome> {
  const startedAt = Date.now();
  const persistence =
    suppliedPersistence ?? createFileExportJobPersistence();
  let resolvedOutputPath: string | undefined;
  type CliProjection = Pick<ResolvedScope, "sourcePages" | "reconcilablePageId" | "scopeReport"> & {
    outputPath: string;
  };
  let reportProjection: CliProjection | undefined;

  try {
    // Compiler loading is local-only; runOrdinaryExportJobV1 persists before
    // the shared ADF/Storage resolver (the first Confluence read) is reachable.
    const compiler = await getPdfCompiler();
    const sourcePolicyKey = args.profile.deploymentType === "data-center"
      ? "storage-primary:data-center:v1"
      : `${exportSourcePolicyFromFlag(process.env.ATLCLI_EXPORT_SOURCE)}:v1`;
    const resolveInput = createConfluencePdfResolveInputV1({
      port: confluenceSourceResolverPortFromClientV1(args.client),
      classifyError: classifyConfluenceSourceError,
      resolveExternalUrl: cliConfluenceExternalUrlResolver(args.profile),
      createSourcePlan: (_request, context) => ({
        store: createConfluenceSourcePlanSpoolV1(context),
        sourcePolicyKey,
      }),
      createBodyStore: (request, context) =>
        createExportTreeBodySpoolV1(context, request.idempotencyKey),
      onDiagnostic: (_request, context, diagnostic) => {
        return context.updateProgress({
          stage: "discover",
          done: 0,
          total: null,
          detail: formatConfluenceHierarchyDiagnosticV1(diagnostic),
          updatedAt: Date.now(),
        });
      },
      onProgress: (_request, context, progress) => {
        return context.updateProgress({
          stage: "fetch",
          done: progress.fetched,
          total: progress.total,
          updatedAt: Date.now(),
        });
      },
      async build(resolved, request, context) {
        const mentions = await resolveExportMentions(
          resolved.blocks,
          tokenMentionLookup(args.client, context.signal),
        );
        resolved.blocks = mentions.blocks;
        if (mentions.unresolved > 0) {
          resolved.sourceNotes.push({
            level: "warning",
            code: "mention-unresolved",
            message:
              `${mentions.unresolved} mention(s) could not be resolved to a display name.`,
          });
        }

        const outNameKey = args.request.scopeKind === "space"
          ? args.request.spaceKey!
          : resolved.root.id;
        resolvedOutputPath = args.outDir
          ? derivePdfOutputPath(args.outDir, outNameKey, resolved.root.title)
          : resolve(args.outputPath!);
        const sourcePages: SourcePageEntry[] = resolved.pages.map((page) => ({
          id: page.id,
          title: page.title,
          notes: page.notes.map((note) => noteToIssue(note, "compose", page.id)),
        }));
        const scopeReport = args.request.scopeKind === "page"
          ? undefined
          : buildScopeReportFields(
              args.request,
              buildExportScope(args.request, resolved.root.id),
            );
        reportProjection = {
          sourcePages,
          outputPath: resolvedOutputPath,
          ...(args.request.scopeKind === "page"
            ? { reconcilablePageId: resolved.root.id }
            : {}),
          ...(scopeReport ? { scopeReport } : {}),
        };
        await writeOrdinaryExportProjectionV1(persistence, {
          schema: "atlcli.cli-export-projection/1",
          jobId: jobRequest.id,
          format: "pdf",
          value: reportProjection,
        });

        const locale = normalizePdfLocale(undefined);
        const metadata: PdfExportMetadata = {
          title: resolved.root.title,
          space: resolved.root.spaceKey ?? "UNKNOWN",
          ...(resolved.root.version !== undefined
            ? { version: resolved.root.version }
            : {}),
          exporter: "atlcli",
          language: locale.language,
          ...(locale.region ? { region: locale.region } : {}),
          exportedAt: request.options.exportedAt !== undefined
            ? new Date(request.options.exportedAt)
            : new Date(request.createdAt),
        };
        const macros = await buildPdfMacroOptions(
          args.profile,
          args.client,
          resolved.chapterAnchorById,
          context.signal,
          request.options.resolveMacros,
        );
        return {
          input: {
            metadata,
            filename: basename(resolvedOutputPath),
            // The CLI sets only the page switches (`--no-cover`, `--no-toc`,
            // `--no-closing-page`); absent ones keep the template defaults.
            ...(request.settings.cover !== undefined ||
            request.settings.outline !== undefined ||
            request.settings.closingPage !== undefined
              ? {
                  settings: {
                    ...(request.settings.cover !== undefined ? { cover: request.settings.cover } : {}),
                    ...(request.settings.outline !== undefined ? { outline: request.settings.outline } : {}),
                    ...(request.settings.closingPage !== undefined
                      ? { closingPage: request.settings.closingPage }
                      : {}),
                  },
                }
              : {}),
            ...(request.options.outputPolicy !== undefined
              ? { outputPolicy: request.options.outputPolicy }
              : {}),
          },
          env: {
            assets: checkpointPdfAssetsV1(
              context,
              request.idempotencyKey,
              cliPdfAssets(args.client, args.baseUrl, {
                noCache: request.options.noCache === true,
              }),
            ),
            macros,
          },
        };
      },
    });
    const executor = createOrdinaryPdfExecutorV1(persistence, {
      compiler,
      resolveInput,
      estimateRender(input): ResourceEstimateV1 {
        const sourceBytes = new TextEncoder().encode(JSON.stringify(input.blocks)).byteLength;
        return {
          heapBytes: Math.max(256 * 1024 * 1024, sourceBytes * 8),
          spoolBytes: Math.max(512 * 1024 * 1024, sourceBytes * 16),
          outputBytes: 512 * 1024 * 1024,
          rasterPixels: 128 * 1024 * 1024,
          confidence: "unknown",
        };
      },
    });

    const execution = await runOrdinaryExportJobV1({
      request: jobRequest,
      ...(derivedFrom ? { derivedFrom } : {}),
      executor,
      persistence,
      monitor: {
        mode: args.opts.json ? "jsonl" : process.stderr.isTTY ? "tty" : "lines",
        writer: process.stderr,
      },
    });
    if (execution.snapshot.state !== "succeeded" || !execution.report) {
      const classified = classifyFailedExportJob(execution.snapshot);
      return {
        ok: false,
        report: buildReport({
          format: "pdf",
          sourcePages: [],
          outputDetails: [],
          issues: [classified.issue],
          timings: { totalMs: Date.now() - startedAt },
          failureExitCode: classified.exitCode,
        }),
      };
    }

    // Recovery can skip resolveInput when a ready/result checkpoint exists.
    // The CLI projection is therefore durable too; never re-read Confluence
    // merely to print the report after the artifact has already succeeded.
    reportProjection ??= await readOrdinaryExportProjectionV1<CliProjection>(
      persistence,
      execution.snapshot.id,
      "pdf",
    );
    if (!reportProjection) throw new Error("PDF job recovery has no durable CLI report projection.");
    const report = execution.report as PdfExportReport;
    const outputPath = reportProjection.outputPath;
    const { outputDetail, issues } = pdfReportContributions(
      report,
      outputPath,
      report.compilerDiagnostics ?? [],
    );
    const sourcePages: SourcePageEntry[] =
      reportProjection.reconcilablePageId && report.sourceNotes
        ? [{
            ...reportProjection.sourcePages[0]!,
            notes: report.sourceNotes.map((note) =>
              noteToIssue(note, "compose", reportProjection!.reconcilablePageId!),
            ),
          }]
        : reportProjection.sourcePages;
    const common = {
      format: "pdf" as const,
      ...(report.outputPolicy !== undefined
        ? { outputPolicy: report.outputPolicy }
        : {}),
      ...(report.outputStandardEvidence !== undefined
        ? { outputStandardEvidence: report.outputStandardEvidence }
        : {}),
      sourcePages,
      outputDetails: [outputDetail],
      issues,
      timings: { ...report.timings, totalMs: Date.now() - startedAt },
      complete: report.complete,
      strict: args.strict,
    };
    return {
      ok: true,
      report: reportProjection.scopeReport
        ? buildTreeExportReport({ ...common, scope: reportProjection.scopeReport })
        : buildReport(common),
    };
  } catch (error) {
    const classified = classifyError(error);
    return {
      ok: false,
      report: buildReport({
        format: "pdf",
        sourcePages: [],
        outputDetails: [],
        issues: [classified.issue],
        timings: { totalMs: Date.now() - startedAt },
        failureExitCode: classified.exitCode,
      }),
    };
  }
}
