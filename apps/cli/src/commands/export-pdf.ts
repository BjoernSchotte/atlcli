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
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { buildConfluenceUrl, type OutputOptions, type Profile } from "@atlcli/core";
import type { MacroResolutionOptions } from "@atlcli/export-macros";
import {
  createAdfAnnotationResolver,
  createAdfMediaAttachmentResolver,
  SpaceHomepageError,
  composeChapters,
  confluenceTreeSource,
  exportSourcePolicyFromFlag,
  fetchExportTree,
  pageBodyToBlocks,
  resolveExportMentions,
  type ComposeOptions,
  type ConfluenceClient,
  type ConfluencePageDetails,
  type ExportBlock,
  type ExportNote,
  type ExportProgressCallback,
  type ExportTreeBodyStoreV1,
} from "@atlcli/confluence";
import {
  normalizePdfLocale,
  runPdfExport,
  type PdfAssetRef,
  type PdfAssetResolver,
  type PdfExportMetadata,
  type PdfExportReport,
  type PdfOutputSink,
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

/**
 * Progress → stderr only (stdout stays clean for `--report json`). In `--json`
 * mode each event is one JSONL line; otherwise a single rewriting status line.
 */
function makePdfProgress(opts: OutputOptions): { report: ExportProgressCallback; clear: () => void } {
  let dirty = false;
  const report: ExportProgressCallback = (event) => {
    if (opts.json) {
      process.stderr.write(`${JSON.stringify(event)}\n`);
      return;
    }
    const total = event.total === null ? "?" : String(event.total);
    const detail = event.detail ? ` ${event.detail}` : "";
    process.stderr.write(`\r${`[${event.phase}] ${event.done}/${total}${detail}`.slice(0, 120).padEnd(120)}`);
    dirty = true;
  };
  return { report, clear: () => { if (!opts.json && dirty) process.stderr.write(`\r${" ".repeat(120)}\r`); } };
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
    live: true,
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
 * Resolve the export scope into ONE composed block list. Page scope walks a
 * single page (with page context so attachment ImageSources carry pageId);
 * tree/space scope drives folder 002's shared `fetchExportTree` →
 * `composeChapters` orchestration and feeds the composed blocks straight into
 * the same `runPdfExport` call (artifact-cardinality contract: always one file).
 */
export async function resolveScope(
  args: ExportPdfArgs,
  signal: AbortSignal,
  onProgress: ExportProgressCallback,
  walk: { exporter?: "pdf" | "word"; keepIgnored?: boolean } = {},
  bodyStore?: ExportTreeBodyStoreV1,
): Promise<ResolvedScope> {
  const { client, request, profile } = args;

  if (request.scopeKind === "page") {
    const pageId = await resolvePageIdThrowing(client, request.pageRef!, signal);
    const page = await client.getExportPageDetailsWithMedia(pageId, { signal });
    const spaceKey = page.spaceKey ?? "UNKNOWN";
    const walked = pageBodyToBlocks(page.exportSource, {
      exporter: walk.exporter ?? "pdf",
      resolveMediaAttachment: createAdfMediaAttachmentResolver(page.mediaAttachments),
      resolveAnnotation: createAdfAnnotationResolver(page.inlineComments),
      annotationCommentsComplete: page.inlineCommentsComplete,
      ...(walk.keepIgnored ? { exportControls: "passthrough" as const } : {}),
      pageContext: {
        id: pageId,
        title: page.title,
        ...(page.exportSource.sourceVersion !== undefined
          ? { version: page.exportSource.sourceVersion }
          : {}),
        spaceKey,
      },
    });
    const mention = await resolveExportMentions(
      walked.blocks,
      tokenMentionLookup(client, signal),
    );
    const sourceNotes: ExportNote[] = [...walked.notes];
    // `mention-unresolved` is the CROSS-HOST code (spec 010): the CLI's DOCX
    // path (`export.ts`) and the extension's PDF host
    // (`apps/extension/utils/pdf/run-export.ts`) report this same condition
    // under this same code. Pinned from both ends —
    // `export-source-contract.test.ts` for the CLI, `apps/extension/tests/pdf/
    // run-export.test.ts` for the extension.
    if (mention.unresolved > 0) {
      sourceNotes.push({ level: "warning", code: "mention-unresolved", message: `${mention.unresolved} mention(s) could not be resolved to a display name.` });
    }
    return {
      metaPage: page,
      blocks: mention.blocks,
      sourceNotes,
      complete: true,
      // Provisional: these are the PRE-macro-resolution walker notes. The
      // engine owns the terminal outcome, so `exportPdf` projects its
      // reconciled `sourceNotes` back onto this entry (see
      // `reconcilablePageId`) before the report is built.
      sourcePages: [{ id: pageId, title: page.title, notes: walked.notes.map((n) => noteToIssue(n, "compose", pageId)) }],
      outNameKey: pageId,
      reconcilablePageId: pageId,
    };
  }

  // --- tree / space scope (spec 008 T3.3, reusing folder 002's orchestration) ---
  let rootId: string;
  if (request.scopeKind === "space") {
    const homepageId = await client.getSpaceHomepageId(request.spaceKey!, { signal });
    if (!homepageId) throw new SpaceHomepageError(request.spaceKey!);
    rootId = homepageId;
  } else {
    rootId = await resolvePageIdThrowing(client, request.pageRef!, signal);
  }
  const scope = buildExportScope(request, rootId);
  const treeResult = await fetchExportTree(confluenceTreeSource(client), scope, {
    ...(request.labels ? { labels: request.labels } : {}),
    completenessMode: request.completenessMode,
    ...(request.maxPages !== undefined ? { maxPages: request.maxPages } : {}),
    ...(request.maxFolders !== undefined ? { maxFolders: request.maxFolders } : {}),
    bodyOptions: {
      exporter: walk.exporter ?? "pdf",
      ...(walk.keepIgnored ? { exportControls: "passthrough" as const } : {}),
    },
    ...(bodyStore ? { bodyStore } : {}),
    signal,
    onProgress: (p) => onProgress({ phase: "fetch", done: p.fetched, total: p.total, detail: p.currentTitle }),
  });

  const composed = composeChapters(treeResult.nodes, {
    resolveExternalUrl: cliConfluenceExternalUrlResolver(profile),
  });
  const rootDetails = await client.getPageDetails(rootId, { signal });

  const mention = await resolveExportMentions(
    composed.blocks,
    tokenMentionLookup(client, signal),
  );
  const sourceNotes: ExportNote[] = [...treeResult.notes, ...composed.notes];
  if (mention.unresolved > 0) {
    sourceNotes.push({ level: "warning", code: "mention-unresolved", message: `${mention.unresolved} mention(s) could not be resolved to a display name.` });
  }

  const pageNodes = treeResult.nodes.filter(
    (node): node is Extract<typeof node, { kind: "page" }> => node.kind === "page"
  );
  const sourcePages: SourcePageEntry[] = pageNodes.map((node) => ({
    id: node.pageId,
    title: node.title,
    notes: node.notes.map((note) => noteToIssue(note, "compose", node.pageId)),
  }));

  return {
    metaPage: rootDetails,
    blocks: mention.blocks,
    sourceNotes,
    complete: treeResult.complete,
    sourcePages,
    outNameKey: request.scopeKind === "space" ? request.spaceKey! : rootId,
    // Same builder the DOCX tree path uses — a `--scope space` request stays
    // traceable to the tree rooted at the resolved homepage id (spec 002 A5).
    scopeReport: buildScopeReportFields(request, scope),
    chapterAnchorById: composed.chapterAnchorById,
  };
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
  const progress = makePdfProgress(opts);

  const format = "pdf" as const;

  try {
    // Resolve the scope into a single composed block list (T3.3:
    // `--scope tree|space` always yields exactly ONE artifact, never one file
    // per page). Mentions are resolved across the whole document with one
    // deduped bulk lookup.
    const scope = await resolveScope(args, controller.signal, progress.report);

    const locale = normalizePdfLocale(undefined);
    const metadata: PdfExportMetadata = {
      title: scope.metaPage.title,
      space: scope.metaPage.spaceKey ?? "UNKNOWN",
      ...(scope.metaPage.version !== undefined ? { version: scope.metaPage.version } : {}),
      ...(scope.metaPage.createdBy?.displayName ? { author: scope.metaPage.createdBy.displayName } : {}),
      exporter: "atlcli",
      language: locale.language,
      ...(locale.region ? { region: locale.region } : {}),
      exportedAt: args.exportedAt ?? new Date(),
    };

    // Choose the output path: --output names the single file; --out-dir chooses
    // a directory and derives a deterministic, sanitized, containment-checked
    // filename (path-escape hardening — hostile titles/keys cannot escape it).
    const outputPath = args.outDir
      ? derivePdfOutputPath(args.outDir, scope.outNameKey, scope.metaPage.title)
      : resolve(args.outputPath!);

    const compiler = await getPdfCompiler();
    const macros = await buildPdfMacroOptions(
      args.profile,
      client,
      scope.chapterAnchorById,
      controller.signal,
    );
    const report = await runPdfExport(
      {
        blocks: scope.blocks,
        sourceNotes: scope.sourceNotes,
        metadata,
        filename: basename(outputPath),
        signal: controller.signal,
        complete: scope.complete,
        ...(args.outputPolicy !== undefined
          ? { outputPolicy: args.outputPolicy }
          : {}),
        onProgress: progress.report,
        page: {
          id: scope.metaPage.id,
          ...(scope.metaPage.version !== undefined ? { version: scope.metaPage.version } : {}),
          ...(scope.metaPage.spaceKey !== undefined ? { spaceKey: scope.metaPage.spaceKey } : {}),
        },
      },
      {
        assets: cliPdfAssets(client, baseUrl, { noCache: args.noCache }),
        compiler,
        output: filePdfOutputSink(outputPath, { force: args.force }),
        macros,
      }
    );
    progress.clear();

    // `mention-unresolved` is deliberately NOT appended here. `resolveScope`
    // already pushed it into `scope.sourceNotes`, which rides into the engine as
    // `input.sourceNotes`, comes back on `report.notes`, and is projected onto an
    // Issue by `pdfReportContributions` like every other note — same `prepare`
    // phase, plus the message carrying the unresolved COUNT that a hand-built,
    // message-less issue could not. Appending a second one made
    // `notesByCode["mention-unresolved"]` read 2 on the PDF path where the DOCX
    // ts path (which only maps `report.notes`) read 1, and inflated the
    // `--strict` warning count for the same single fact.
    const { outputDetail, issues } = pdfReportContributions(report, outputPath, report.compilerDiagnostics ?? []);

    // Per-page provenance, reconciled (spec 010). For a single-page scope the
    // one entry's notes ARE `scope.sourceNotes`, and macro resolution rewrote
    // that list inside the engine — a provisional `macro-not-rendered` became
    // `macro-rendered-via`. Projecting the engine's reconciled list back is what
    // stops `sourcePages[].notes` from contradicting `notesByCode`, which said
    // the macro rendered. Tree/space keeps its per-page walk: those notes never
    // enter the engine, so there is no reconciled counterpart to project.
    const sourcePages: SourcePageEntry[] =
      scope.reconcilablePageId && report.sourceNotes
        ? [
            {
              ...scope.sourcePages[0]!,
              notes: report.sourceNotes.map((n) => noteToIssue(n, "compose", scope.reconcilablePageId!)),
            },
          ]
        : scope.sourcePages;

    // Report-contract parity with the DOCX path. `complete` rides on EVERY
    // successful export (spec 002's completeness contract, which a CI consumer
    // reads via `jq -r '.complete'` — it must never be null on success); the
    // scope-traceability pair is tree/space-only, exactly as on the DOCX side,
    // and comes from the same shared builder. A tree/space export goes through
    // `buildTreeExportReport`, which makes both REQUIRED at compile time.
    const common = {
      format,
      codeTheme: report.codeTheme,
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
      strict,
    };

    return {
      ok: true,
      report: scope.scopeReport
        ? buildTreeExportReport({ ...common, scope: scope.scopeReport })
        : buildReport(common),
    };
  } catch (error) {
    progress.clear();
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

/**
 * Queue-backed ordinary PDF command. The unresolved request is persisted by
 * {@link runOrdinaryExportJobV1} before `resolveScope` performs the first API
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
        );
        return {
          input: {
            metadata,
            filename: basename(resolvedOutputPath),
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
