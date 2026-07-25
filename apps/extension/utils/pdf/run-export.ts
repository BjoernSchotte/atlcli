/**
 * The extension's PDF export host (spec 010 T5.1 + T5.4).
 *
 * A thin shell over the neutral `runPdfExport` from `@atlcli/pdf/browser`: it
 * resolves the requested SCOPE into one composed block list, builds the
 * session-authenticated asset seam, wires dynamic-macro resolution, and maps
 * the engine's phases onto the panel's vocabulary. No export logic of its own —
 * everything below either calls a shared package or adapts a browser fact
 * (the ambient session, the download sink, the compiler worker).
 *
 * ## The one rule this file must not break
 *
 * `PdfExportEnv.assets` is only ever {@link extensionPdfAssets}. That function
 * composes `trustRoutingPdfAssetResolver` unconditionally, which is what stops
 * a URL emitted by third-party macro HTML (`trust: "export-view"`) from being
 * fetched by the session-authenticated resolver. Passing `macros` to an env
 * whose `assets` is NOT policy-routed is an SSRF bypass, not a style problem;
 * `@atlcli/export-wiring/fixtures#assertPdfEnvMacroAssetRule` is the executable
 * form of the rule and `tests/pdf/run-export-scope.test.ts` runs it against the
 * env built here — plus a structural check that no second `assets:` site
 * appears in this file.
 */
import {
  ConfluenceClient,
  resolveExportMentions,
  type ExportBlock,
  type ExportMentionResolution,
  type ExportNote,
  type ExportScope,
  type CompletenessMode,
  type LabelFilter,
  type TreeFetchProgress,
} from "@atlcli/confluence/browser";
import {
  normalizePdfLocale,
  runPdfExport as runNeutralPdfExport,
  type PdfAssetRef,
  type PdfAssetResolver,
  type PdfCompilePort,
  type PdfExportPhase as NeutralPdfExportPhase,
  type PdfExportReport,
  type PdfOutputSink,
  type PdfProfile,
  type PdfTemplateSettings,
  type PdfThemeOptions,
} from "@atlcli/pdf/browser";
import type { ExternalAssetFetcher, ExternalAssetPolicy } from "@atlcli/export-macros";
import type { CodeThemeId } from "@atlcli/code-highlight/registry";
import { trustRoutingPdfAssetResolver } from "@atlcli/export-wiring";
import type { LoadedPage } from "../read-path.js";
import { profileFromTabUrl } from "../profile.js";
import { exportScopeIdentity } from "../scope-state.js";
import {
  resolveExportComposition,
  type ExportComposition,
  type ExportCompositionDeps,
} from "../confluence/export-composition.js";
import {
  createExternalAssetFetcher,
  extensionAssetPolicyFromPageUrl,
  extensionPagePdfAssetResolver,
} from "../macros/external-asset-policy.js";
import {
  buildSessionMacroResolutionOptions,
  type JiraClientLike,
  type SessionMacroResolution,
} from "../macros/session-ports.js";
import { sessionAssetFetcher } from "../docx/env.js";
import { downloadBytes, sanitizeDownloadName } from "../download.js";
import { extensionPdfCompilePort } from "./compile-port.js";
import { updatePdfJobProgress } from "./job-store.js";

export { normalizePdfLocale };

export type PdfExportPhase =
  | "preparing"
  | "fetching"
  | "queued"
  | "compiling"
  | "validating"
  | "downloading";

/** Panel-side knobs for dynamic-macro resolution (T5.4). */
export interface RunPdfMacroOptions {
  /**
   * `false` mirrors the CLI's `--no-live-macros`: no port call is made and every
   * dynamic macro is reported `macro-skipped-by-config` rather than silently
   * disappearing. Default (`undefined`) resolves live, matching the CLI.
   */
  live?: boolean;
  /**
   * Overrides the `JiraClient` the session ports build from the active tab's
   * profile. A test seam — the extension declares `@atlcli/jira` and always
   * constructs one, so Jira macros render here exactly as they do in the CLI.
   */
  jiraClient?: JiraClientLike;
}

export interface RunPdfExportInput {
  page: LoadedPage;
  pageUrl: string;
  /**
   * Export scope (spec 010 T5.1). Absent → the loaded page alone, which is what
   * every caller did before scope existed.
   */
  scope?: ExportScope;
  /** Label include/exclude filter for a tree/space scope. */
  labels?: LabelFilter;
  /** Folder 002's completeness policy; left at the shared default when unset. */
  completenessMode?: CompletenessMode;
  /** Hard traversal cap; left at the shared default when unset. */
  maxPages?: number;
  theme?: PdfThemeOptions;
  profile?: PdfProfile;
  /** Level-A template settings (spec 007), threaded straight to the engine. */
  settings?: PdfTemplateSettings;
  /** Product-owned Shiki theme shared with DOCX. */
  codeTheme?: CodeThemeId;
  signal?: AbortSignal;
  onPhase?: (phase: PdfExportPhase) => void;
  /**
   * Tree-walk detail channel: `{ fetched, total, currentTitle }`, one call per
   * fetched page body, so the panel can say "Page 37/210: <title>". Never
   * called for a single-page export — there is nothing to count.
   */
  onProgress?: (progress: TreeFetchProgress) => void;
  /** Dynamic-macro resolution (T5.4); defaults to live. */
  macros?: RunPdfMacroOptions;
}

export interface RunPdfExportDeps {
  now: () => number;
  locale: () => string;
  resolveMentions: (
    blocks: ExportBlock[],
    pageUrl: string,
    signal?: AbortSignal
  ) => Promise<ExportMentionResolution>;
  /**
   * The INNER asset resolver. Always wrapped by {@link extensionPdfAssets} —
   * an override replaces the session fetch, never the trust router.
   */
  resolver?: PdfAssetResolver;
  /** Injectable `TreeSource` seam; see `utils/confluence/export-composition.ts`. */
  createTreeSource?: ExportCompositionDeps["createTreeSource"];
  /**
   * Composition seam used by the bounded preview path. Production exports use
   * {@link resolveExportComposition} unchanged; previews wrap it only to select
   * a chapter prefix after the shared tree walk has completed.
   */
  resolveComposition: typeof resolveExportComposition;
  /**
   * Macro-resolution factory. Returning `undefined` reproduces the pre-T5.4
   * behaviour exactly (unresolved macros stay placeholders with a report note).
   */
  createMacros: (args: {
    pageUrl: string;
    targetEngine: "pdf";
    signal?: AbortSignal;
    chapterAnchorById?: ReadonlyMap<string, string>;
    options?: RunPdfMacroOptions;
  }) => SessionMacroResolution | undefined;
  createCompilePort: (options: {
    sourceIdentity: string;
    /** Page/document title the Jobs list shows instead of "Untitled export". */
    title?: string;
    /** The name the finished file will be downloaded under. */
    filename?: string;
    /** Human scope label — "Current page", "Page + children", "Space DOCSY". */
    scopeLabel?: string;
    /** Fires once the durable record exists, so progress can be attributed. */
    onJobCreated?: (jobId: string) => void;
    onQueued: () => void;
    onCompiling: () => void;
  }) => PdfCompilePort;
  /**
   * Annotate a durable job record with the walk's page count (T5.6).
   * Injected so a test needs no IndexedDB to assert the wiring.
   */
  updateJobProgress: (jobId: string, progress: { done: number; total: number }) => Promise<void>;
  output: PdfOutputSink;
}

/**
 * The label the Jobs screen shows next to a durable export (spec 010 T5.6).
 *
 * Derived from the SHARED `ExportScope`, not from the panel's form state: the
 * same export started from a Forge dialog must read the same way, and the form
 * state does not exist there. Deliberately terse — the Jobs list is a column,
 * not a sentence — and deliberately not localized here: this module has no
 * locale of its own, and the label rides the job record into contexts (the
 * toolbar badge, a re-attached panel) that outlive the panel that made it.
 */
export function scopeLabelFor(scope: ExportScope | undefined, labels?: LabelFilter): string {
  const filtered = labels && (labels.include?.length || labels.exclude?.length) ? " (filtered)" : "";
  if (!scope || scope.kind === "page") return `Current page${filtered}`;
  if (scope.kind === "space") return `Space ${scope.spaceKey}${filtered}`;
  const depth = scope.maxDepth === undefined ? "" : ` (depth ${scope.maxDepth})`;
  return `Page + children${depth}${filtered}`;
}

function runtimeLocale(): string {
  return (typeof document !== "undefined" ? document.documentElement.lang : "")
    || (typeof navigator !== "undefined" ? navigator.language : "")
    || "en";
}

async function defaultResolveMentions(
  blocks: ExportBlock[],
  pageUrl: string,
  signal?: AbortSignal
): Promise<ExportMentionResolution> {
  return resolveExportMentions(blocks, async (accountIds) => {
    throwIfAborted(signal);
    const profile = profileFromTabUrl(pageUrl);
    if (!profile) throw new Error("The active page is not on an approved Atlassian host.");
    const users = await new ConfluenceClient(profile).getUsersBulk(accountIds);
    throwIfAborted(signal);
    return new Map([...users].map(([accountId, user]) => [accountId, user?.displayName ?? null]));
  });
}

/**
 * The session macro registry, or `undefined` when the tab is not on an approved
 * Atlassian host.
 *
 * Degrading rather than throwing is deliberate: the export itself can still
 * proceed (`pageResolver` already returns a resolver that fails per asset), and
 * a missing macro registry produces exactly the documented fallback — a
 * placeholder plus a report note — instead of aborting a whole export over a
 * URL the panel could not classify.
 */
function defaultCreateMacros(args: {
  pageUrl: string;
  targetEngine: "pdf";
  signal?: AbortSignal;
  chapterAnchorById?: ReadonlyMap<string, string>;
  options?: RunPdfMacroOptions;
}): SessionMacroResolution | undefined {
  if (!profileFromTabUrl(args.pageUrl)) return undefined;
  return buildSessionMacroResolutionOptions({
    pageUrl: args.pageUrl,
    targetEngine: args.targetEngine,
    ...(args.options?.live !== undefined ? { live: args.options.live } : {}),
    ...(args.options?.jiraClient ? { jiraClient: args.options.jiraClient } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.chapterAnchorById ? { chapterAnchorById: args.chapterAnchorById } : {}),
  });
}

const defaultDeps: RunPdfExportDeps = {
  now: () => Date.now(),
  locale: runtimeLocale,
  resolveMentions: defaultResolveMentions,
  resolveComposition: resolveExportComposition,
  createMacros: defaultCreateMacros,
  createCompilePort: (options) => extensionPdfCompilePort(options),
  updateJobProgress: (jobId, progress) => updatePdfJobProgress(jobId, progress).then(() => undefined),
  output: {
    emit: (name, bytes, context) => downloadBytes({
      name,
      bytes,
      mimeType: "application/pdf",
      signal: context?.signal,
    }),
  },
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("PDF export was cancelled.", "AbortError");
}

function mimeFromFilename(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "svg": return "image/svg+xml";
    case "webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

/**
 * The session-authenticated INNER resolver.
 *
 * Attachments are keyed on `ref.pageId ?? rootPageId` (spec 002 A1(c)): in a
 * tree/space export two chapters can each carry a `diagram.png`, and keying on
 * the filename alone would serve the root page's copy for both. The fallback is
 * what keeps a single-page export — whose refs carry no page id at all —
 * working unchanged.
 *
 * Page-author external images (`trust` absent/`"page"`) whose origin is covered
 * by the extension manifest are fetched through the same session path the DOCX
 * engine uses. Other absolute origins are rejected by the host-specific guard
 * around this resolver before Chrome can emit a CORS request.
 * `trust: "export-view"` refs never arrive here: the router in
 * {@link extensionPdfAssets} diverts them to the policy-checked fetcher first.
 */
function pageResolver(
  rootPageId: string,
  pageUrl: string,
  signal?: AbortSignal
): PdfAssetResolver {
  const profile = profileFromTabUrl(pageUrl);
  if (!profile) {
    return { resolve: async () => { throw new Error("The active page is not on an approved Atlassian host."); } };
  }
  const baseUrl = `${profile.baseUrl.replace(/\/+$/, "")}/wiki`;
  const fetcher = sessionAssetFetcher(
    baseUrl,
    ((request: RequestInfo | URL, init?: RequestInit) => fetch(request, { ...init, signal })) as typeof fetch
  );
  return {
    async resolve(ref: PdfAssetRef) {
      throwIfAborted(signal);
      if (ref.kind === "external") {
        const url = ref.url ?? "";
        if (!url) throw new Error("External image reference carried no URL.");
        const bytes = await fetcher.fetch({ url });
        throwIfAborted(signal);
        if (bytes.byteLength === 0) throw new Error("External image response was empty.");
        // Left as octet-stream so `preparePdfDocument` sniffs the real type from
        // the bytes rather than trusting a URL extension.
        return { bytes, mediaType: "application/octet-stream" };
      }
      const filename = ref.filename ?? "attachment";
      const pageId = ref.pageId ?? rootPageId;
      const bytes = await fetcher.fetch({
        url: `/download/attachments/${encodeURIComponent(pageId)}/${encodeURIComponent(filename)}`,
        pageId,
        filename,
      });
      throwIfAborted(signal);
      if (bytes.byteLength === 0) throw new Error("Attachment response was empty.");
      return { bytes, mediaType: mimeFromFilename(filename), filename };
    },
  };
}

export interface ExtensionPdfAssetsOptions {
  /** Fallback page id for attachment refs that carry none (single-page export). */
  rootPageId: string;
  pageUrl: string;
  signal?: AbortSignal;
  /** Replaces the session fetch; the manifest guard and trust router are composed around it. */
  inner?: PdfAssetResolver;
  /** Defaults to the extension's manifest-scoped origin allowlist. */
  policy?: ExternalAssetPolicy;
  /** Defaults to the shared enforced fetcher over {@link policy}. */
  external?: ExternalAssetFetcher;
}

/**
 * The resolver the PDF export env actually gets: the session resolver with the
 * manifest-origin guard and spec-004 trust router already composed around it.
 *
 * **Every `PdfExportEnv.assets` this host builds goes through here.** That is
 * the reason it is a function rather than two inlined lines: the CLI's PDF path
 * shipped `trustRoutingPdfAssetResolver` written, unit-tested and wired
 * NOWHERE for two specs, and it was harmless only for exactly as long as that
 * path passed no `macros`. This host passes `macros`, so an unwrapped resolver
 * here is a live SSRF — third-party macro HTML naming
 * the cloud metadata service would be fetched from inside the user's
 * authenticated browser session. Refs without the trust marker take the inner
 * path only when the extension manifest covers their origin; unsupported
 * absolute origins degrade before the browser transport.
 */
export function extensionPdfAssets(options: ExtensionPdfAssetsOptions): PdfAssetResolver {
  const policy = options.policy ?? extensionAssetPolicyFromPageUrl(options.pageUrl);
  const external = options.external ?? createExternalAssetFetcher(policy);
  const session =
    options.inner ?? pageResolver(options.rootPageId, options.pageUrl, options.signal);
  const inner = extensionPagePdfAssetResolver(session, policy);
  return trustRoutingPdfAssetResolver(inner, external);
}

function mapNeutralPhase(
  phase: NeutralPdfExportPhase,
  onPhase: RunPdfExportInput["onPhase"]
): void {
  switch (phase) {
    case "preparing": onPhase?.("preparing"); break;
    case "fetching": onPhase?.("fetching"); break;
    case "compiling": break;
    case "validating": onPhase?.("validating"); break;
    case "emitting": onPhase?.("downloading"); break;
  }
}

/**
 * The compile-cache discriminator.
 *
 * `pageUrl|id|version` alone cannot tell a single-page export of page 42 from a
 * tree export rooted at page 42: same URL, same id, same version — different
 * bytes. {@link exportScopeIdentity} (the same discriminator the scope form
 * uses, so the two agree by construction) is appended so the two can never
 * collide in the compile cache or in the preview store.
 *
 * Known limit, carried forward from W1-D: this mixes in the ROOT page's version
 * only. A child page edited between two tree exports does not change it. That
 * is fine for a panel-lifetime compile cache (bodies are refetched every run);
 * a cache that persists BYTES across runs must additionally mix in a hash of
 * the resolved tree's per-node versions — which is what
 * `utils/pdf/preview-cache.ts#hashTreeVersions` exists for.
 */
export function pdfSourceIdentity(
  input: Pick<RunPdfExportInput, "pageUrl" | "scope" | "labels">,
  root: { id: string; version?: number }
): string {
  const scope: ExportScope = input.scope ?? { kind: "page", pageId: root.id };
  return (
    `${input.pageUrl}|${root.id}|${root.version ?? ""}` +
    `|${exportScopeIdentity(scope, input.labels)}`
  );
}

export async function runPdfExport(
  input: RunPdfExportInput,
  overrides: Partial<RunPdfExportDeps> = {}
): Promise<PdfExportReport> {
  const deps = { ...defaultDeps, ...overrides };
  throwIfAborted(input.signal);

  // Per-page walk ticks, mirrored onto the durable job record (T5.6).
  //
  // The ordering is what makes this a *mirror* rather than a live feed: the
  // record does not exist until the bundle is stored, which is after the walk
  // has finished — so `jobId` arrives once, with the walk's final figure to
  // hand. `lastProgress` carries it across that gap, and the branch below keeps
  // forwarding if a later tick ever arrives (it does not today, but a wiring
  // that silently depends on "the walk is over by now" is the kind that breaks
  // quietly when the phase order changes).
  let lastProgress: TreeFetchProgress | undefined;
  let progressJobId: string | undefined;
  const recordProgress = (progress: TreeFetchProgress): void => {
    lastProgress = progress;
    if (progressJobId === undefined || progress.total === null) return;
    void deps
      .updateJobProgress(progressJobId, { done: progress.fetched, total: progress.total })
      .catch(() => {
        // Progress is decoration on a record that is already durable; failing to
        // annotate it must never take the export down with it.
      });
  };
  const onWalkProgress = (progress: TreeFetchProgress): void => {
    recordProgress(progress);
    input.onProgress?.(progress);
  };

  // Scope resolution FIRST: the abort signal reaches the walk, not only the
  // compile, so a Cancel on page 37 of 210 stops fetching immediately.
  const composition: ExportComposition = await deps.resolveComposition(
    {
      root: {
        id: input.page.details.id,
        title: input.page.details.title,
        ...(input.page.details.version !== undefined ? { version: input.page.details.version } : {}),
        ...(input.page.details.spaceKey !== undefined ? { spaceKey: input.page.details.spaceKey } : {}),
        storage: input.page.details.storage ?? "",
      },
      pageUrl: input.pageUrl,
      exporter: "pdf",
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.completenessMode ? { completenessMode: input.completenessMode } : {}),
      ...(input.maxPages !== undefined ? { maxPages: input.maxPages } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      onProgress: onWalkProgress,
    },
    deps.createTreeSource ? { createTreeSource: deps.createTreeSource } : {}
  );
  throwIfAborted(input.signal);

  let blocks = composition.blocks;
  const mentionNotes: ExportNote[] = [];
  try {
    const resolved = await deps.resolveMentions(blocks, input.pageUrl, input.signal);
    blocks = resolved.blocks;
    if (resolved.unresolved > 0) {
      // SHARED code (spec 010): the CLI's PDF host
      // (`apps/cli/src/commands/export-pdf.ts`) and its DOCX host
      // (`apps/cli/src/commands/export.ts`) both report this exact condition as
      // `mention-unresolved`. A host-local spelling made one report's
      // `notesByCode` unfilterable with the other's key even though the fact —
      // "an account id did not resolve to a display name on the source page" —
      // is identical and has nothing to do with which host noticed it.
      mentionNotes.push({
        level: "warning",
        code: "mention-unresolved",
        message: `${resolved.unresolved} mention display name(s) could not be resolved; technical identifiers were retained.`,
      });
    }
  } catch {
    throwIfAborted(input.signal);
    mentionNotes.push({
      level: "warning",
      code: "pdf-mention-resolution-failed",
      message: "Mention display names could not be resolved; technical identifiers were retained.",
    });
  }

  const locale = normalizePdfLocale(deps.locale());
  const root = composition.root;
  const filename = sanitizeDownloadName(root.title, "pdf");
  // Everything the Jobs list needs to name this export (T5.6). Without it a
  // durable record reads "Untitled export" with no scope, so three queued jobs
  // are indistinguishable — technically working, useless to read. All of it is
  // already in hand here; nothing extra is fetched to produce it.
  const compiler = deps.createCompilePort({
    sourceIdentity: pdfSourceIdentity(input, root),
    title: root.title,
    filename,
    scopeLabel: scopeLabelFor(input.scope, input.labels),
    onJobCreated: (jobId) => {
      progressJobId = jobId;
      if (lastProgress) recordProgress(lastProgress);
    },
    onQueued: () => input.onPhase?.("queued"),
    onCompiling: () => input.onPhase?.("compiling"),
  });

  // Live macro resolution (T5.4). `contextFor` is handed to the engine
  // UNCHANGED: the engine calls `contextFor(block.sourcePage ?? rootPage)`, so a
  // macro on a CHILD page of a tree export resolves against that page. Anything
  // that substituted the root id here would silently render every child page's
  // Jira/`export_view` macro against the wrong page while the report claimed
  // success.
  const macros = deps.createMacros({
    pageUrl: input.pageUrl,
    targetEngine: "pdf",
    ...(input.signal ? { signal: input.signal } : {}),
    ...(composition.chapterAnchorById ? { chapterAnchorById: composition.chapterAnchorById } : {}),
    ...(input.macros ? { options: input.macros } : {}),
  });

  const report = await runNeutralPdfExport({
    blocks,
    sourceNotes: [...composition.notes, ...mentionNotes],
    complete: composition.complete,
    metadata: {
      title: root.title,
      space: root.spaceKey,
      version: root.version,
      author: input.page.details.modifiedBy?.displayName,
      exporter: input.page.details.modifiedBy?.displayName ?? "atlcli",
      language: locale.language,
      region: locale.region,
      exportedAt: new Date(deps.now()),
    },
    page: {
      id: root.id,
      ...(root.version !== undefined ? { version: root.version } : {}),
      ...(root.spaceKey !== undefined ? { spaceKey: root.spaceKey } : {}),
    },
    profile: input.profile,
    theme: input.theme,
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.codeTheme ? { codeTheme: input.codeTheme } : {}),
    filename,
    signal: input.signal,
    onPhase: (phase) => mapNeutralPhase(phase, input.onPhase),
  }, {
    assets: extensionPdfAssets({
      rootPageId: root.id,
      pageUrl: input.pageUrl,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(deps.resolver ? { inner: deps.resolver } : {}),
    }),
    compiler,
    output: deps.output,
    now: deps.now,
    ...(macros ? { macros: macros.options } : {}),
  });

  // Session expiry is latched DURING the resolve pass, so its one distinct note
  // only exists once the engine has returned. Appended to both lists because a
  // host projecting `sourceNotes` per page must see it too.
  const sessionNotes = macros?.notes() ?? [];
  if (sessionNotes.length > 0) {
    report.notes.push(...sessionNotes);
    report.sourceNotes?.push(...sessionNotes);
  }
  return report;
}

export function hasPdfRelevantBlocks(blocks: ExportBlock[]): boolean {
  return blocks.length > 0;
}
