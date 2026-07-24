import {
  ConfluenceClient,
  resolveExportMentions,
  type ConfluencePageDetails,
  type ExportBlock,
  type ExportMentionResolution,
  type ExportNote,
  type ExportScope,
} from "@atlcli/confluence/browser";
import type {
  ExportJobExecutionContext,
  PdfExportJobRequestV1,
} from "@atlcli/export-jobs";
import type { MacroResolutionOptions } from "@atlcli/export-macros";
import {
  checkpointPdfAssetsV1,
  confluenceSourceResolverPortFromClientV1,
  createConfluencePdfResolveInputV1,
  createConfluenceSourcePlanSpoolV1,
  createExportTreeBodySpoolV1,
  type ConfluenceSourceResolverPortV1,
  type PdfExportJobEngineInputV1,
} from "@atlcli/export-wiring/jobs";
import {
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  normalizePdfLocale,
  type PdfAssetResolver,
  type PdfProfile,
  type PdfTemplateSettings,
  type PreparePdfExportEnv,
} from "@atlcli/pdf/browser";
import {
  resolveExportComposition,
  type ExportComposition,
} from "../confluence/export-composition.js";
import {
  buildSessionMacroResolutionOptions,
  createSessionMacroPorts,
  createSessionMacroState,
  SESSION_EXPIRED_MESSAGE,
} from "../macros/session-ports.js";
import { sanitizeDownloadName } from "../download.js";
import { profileFromTabUrl } from "../profile.js";
import { extensionPdfAssets } from "../pdf/run-export.js";
import { classifyAtlassianSessionError } from "../session-error.js";
import { IndexedDbExportByteStore } from "./chunk-store.js";
import { extensionPdfLogoSpoolRef } from "./pdf-submit.js";

interface PdfJobRoot {
  id: string;
  title: string;
  version?: number;
  spaceKey?: string;
  storage?: string;
  modifiedBy?: { displayName?: string };
}

export interface ExtensionPdfJobResolverDepsV1 {
  bytes: Pick<IndexedDbExportByteStore, "read" | "stat">;
  loadRoot(
    request: PdfExportJobRequestV1,
    signal: AbortSignal,
  ): Promise<PdfJobRoot>;
  resolveComposition: typeof resolveExportComposition;
  resolveMentions(
    blocks: ExportBlock[],
    siteOrigin: string,
    signal: AbortSignal,
  ): Promise<ExportMentionResolution>;
  createAssets(input: {
    rootPageId: string;
    siteOrigin: string;
    signal: AbortSignal;
  }): PdfAssetResolver;
  createMacros(input: {
    siteOrigin: string;
    signal: AbortSignal;
    live: boolean;
    chapterAnchorById?: ReadonlyMap<string, string>;
    sourceNotes: ExportNote[];
  }): MacroResolutionOptions;
  locale(): string;
  now(): number;
}

function siteOriginOf(request: PdfExportJobRequestV1): string {
  const profile = profileFromTabUrl(request.source.siteOrigin);
  if (!profile) throw new Error("The PDF job source is not an approved Atlassian Cloud origin.");
  if (request.authRef !== `session:${profile.baseUrl}`) {
    throw new Error("The PDF job session reference does not match its source origin.");
  }
  return profile.baseUrl;
}

async function defaultLoadRoot(
  request: PdfExportJobRequestV1,
  signal: AbortSignal,
): Promise<PdfJobRoot> {
  const siteOrigin = siteOriginOf(request);
  const profile = profileFromTabUrl(siteOrigin)!;
  const client = new ConfluenceClient(profile);
  let pageId: string;
  if (request.source.locator.kind === "space-key") {
    const homepageId = await client.getSpaceHomepageId(
      request.source.locator.spaceKey,
      { signal },
    );
    if (!homepageId) {
      throw new Error(`Space ${request.source.locator.spaceKey} has no exportable homepage.`);
    }
    pageId = homepageId;
  } else if (request.source.locator.kind === "page-id") {
    pageId = request.source.locator.id;
  } else {
    throw new Error("The extension PDF runner does not support content-key locators.");
  }
  const current = await client.getPageDetails(pageId, { signal });
  const pinnedVersion = request.source.locator.kind === "page-id"
    ? request.source.locator.version
    : undefined;
  if (pinnedVersion === undefined || current.version === pinnedVersion) return current;

  signal.throwIfAborted();
  const historical = await client.getPageAtVersion(pageId, pinnedVersion);
  signal.throwIfAborted();
  return {
    id: historical.id,
    title: historical.title,
    ...(historical.version === undefined ? {} : { version: historical.version }),
    ...(historical.spaceKey === undefined ? {} : { spaceKey: historical.spaceKey }),
    storage: historical.storage,
  };
}

async function defaultResolveMentions(
  blocks: ExportBlock[],
  siteOrigin: string,
  signal: AbortSignal,
): Promise<ExportMentionResolution> {
  const profile = profileFromTabUrl(siteOrigin);
  if (!profile) throw new Error("The PDF job source is not an approved Atlassian Cloud origin.");
  return resolveExportMentions(blocks, async (accountIds) => {
    signal.throwIfAborted();
    const users = await new ConfluenceClient(profile).getUsersBulk(accountIds, {
      signal,
    });
    signal.throwIfAborted();
    return new Map(
      [...users].map(([accountId, user]) => [accountId, user?.displayName ?? null]),
    );
  });
}

function defaultCreateMacros(input: {
  siteOrigin: string;
  signal: AbortSignal;
  live: boolean;
  chapterAnchorById?: ReadonlyMap<string, string>;
  sourceNotes: ExportNote[];
}): MacroResolutionOptions {
  const state = createSessionMacroState(() => {
    input.sourceNotes.push({
      level: "warning",
      code: "auth-error",
      message: SESSION_EXPIRED_MESSAGE,
    });
  });
  const ports = createSessionMacroPorts({
    pageUrl: input.siteOrigin,
    signal: input.signal,
    state,
  });
  return buildSessionMacroResolutionOptions({
    pageUrl: input.siteOrigin,
    targetEngine: "pdf",
    signal: input.signal,
    live: input.live,
    ports,
    ...(input.chapterAnchorById
      ? { chapterAnchorById: input.chapterAnchorById }
      : {}),
  }).options;
}

function requestScope(request: PdfExportJobRequestV1, root: PdfJobRoot): ExportScope {
  if (request.source.scope.kind === "space") {
    if (request.source.locator.kind !== "space-key") {
      throw new Error("A space PDF scope requires a space-key locator.");
    }
    return { kind: "space", spaceKey: request.source.locator.spaceKey };
  }
  if (request.source.locator.kind !== "page-id") {
    throw new Error("A page or tree PDF scope requires a page-id locator.");
  }
  if (request.source.scope.kind === "tree") {
    return {
      kind: "tree",
      rootPageId: request.source.locator.id,
      ...(request.source.scope.includeRoot === undefined
        ? {}
        : { includeRoot: request.source.scope.includeRoot }),
      ...(request.source.scope.maxDepth === undefined
        ? {}
        : { maxDepth: request.source.scope.maxDepth }),
    };
  }
  return { kind: "page", pageId: root.id };
}

async function readPinnedLogo(
  request: PdfExportJobRequestV1,
  bytes: Pick<IndexedDbExportByteStore, "read" | "stat">,
  signal: AbortSignal,
): Promise<PdfTemplateSettings["logo"] | undefined> {
  const logo = request.settings.logo;
  if (!logo) return undefined;
  if (
    !/^extension-spool:.+:0:request-assets:pdf-logo$/.test(logo.assetRef)
  ) {
    throw new Error("Pinned PDF logo reference is not a durable extension asset.");
  }
  // `assetRef` is immutable replay metadata. Each derived job owns a physical
  // copy under its new job id, so cleanup of an ancestor cannot invalidate it.
  const ref = extensionPdfLogoSpoolRef(request.id);
  const stored = await bytes.stat(ref);
  if (
    !stored
    || stored.byteLength !== logo.byteLength
    || stored.sha256 !== logo.sha256
  ) {
    throw new Error("Pinned PDF logo bytes failed their durable integrity binding.");
  }
  const result = new Uint8Array(logo.byteLength);
  let offset = 0;
  for await (const chunk of bytes.read(ref, { signal })) {
    if (offset + chunk.byteLength > result.byteLength) {
      throw new Error("Pinned PDF logo exceeded its declared length.");
    }
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== result.byteLength) {
    throw new Error("Pinned PDF logo was truncated.");
  }
  return { bytes: result, mediaType: logo.mediaType, alt: logo.alt };
}

async function durableSettings(
  request: PdfExportJobRequestV1,
  deps: Pick<ExtensionPdfJobResolverDepsV1, "bytes">,
  signal: AbortSignal,
): Promise<PdfTemplateSettings> {
  if (request.settings.custom && Object.keys(request.settings.custom).length > 0) {
    throw new Error("The built-in PDF renderer does not accept custom manifest settings.");
  }
  const logo = await readPinnedLogo(request, deps.bytes, signal);
  return {
    ...(request.settings.page === undefined ? {} : { page: request.settings.page }),
    ...(request.settings.orientation === undefined
      ? {}
      : { orientation: request.settings.orientation }),
    ...(request.settings.cover === undefined ? {} : { cover: request.settings.cover }),
    ...(request.settings.outline === undefined ? {} : { outline: request.settings.outline }),
    ...(request.settings.headerText === undefined
      ? {}
      : { headerText: request.settings.headerText }),
    ...(request.settings.footerText === undefined
      ? {}
      : { footerText: request.settings.footerText }),
    ...(request.settings.accentColor === undefined
      ? {}
      : { accentColor: request.settings.accentColor }),
    ...(request.settings.organizationName === undefined
      ? {}
      : { organizationName: request.settings.organizationName }),
    ...(request.settings.watermark === undefined
      ? {}
      : { watermark: structuredClone(request.settings.watermark) }),
    ...(logo ? { logo } : {}),
  };
}

function pdfProfile(value: string | undefined): PdfProfile | undefined {
  if (value === undefined) return undefined;
  if (value === "tagged" || value === "pdf-ua-1") return value;
  throw new Error(`Unsupported PDF profile: ${value}.`);
}

function runtimeLocale(): string {
  return (typeof document !== "undefined" ? document.documentElement.lang : "")
    || (typeof navigator !== "undefined" ? navigator.language : "")
    || "en";
}

function defaults(
  bytes: Pick<IndexedDbExportByteStore, "read" | "stat">,
): ExtensionPdfJobResolverDepsV1 {
  return {
    bytes,
    loadRoot: defaultLoadRoot,
    resolveComposition: resolveExportComposition,
    resolveMentions: defaultResolveMentions,
    createAssets: ({ rootPageId, siteOrigin, signal }) =>
      extensionPdfAssets({ rootPageId, pageUrl: siteOrigin, signal }),
    createMacros: defaultCreateMacros,
    locale: runtimeLocale,
    now: Date.now,
  };
}

export type ResolvedExtensionPdfJobInputV1 = {
  input: PdfExportJobEngineInputV1;
  env: Omit<PreparePdfExportEnv, "now">;
  telemetry?: { sourcePageCount: number };
};

function createDefaultExtensionPdfJobInputResolver(
  bytes: Pick<IndexedDbExportByteStore, "read" | "stat">,
  sourcePort?: ConfluenceSourceResolverPortV1,
): (
  request: PdfExportJobRequestV1,
  context: ExportJobExecutionContext,
) => Promise<ResolvedExtensionPdfJobInputV1> {
  return async (request, context) => {
    const siteOrigin = siteOriginOf(request);
    const profile = profileFromTabUrl(siteOrigin)!;
    const client = new ConfluenceClient(profile);
    return createConfluencePdfResolveInputV1({
      port: sourcePort ?? confluenceSourceResolverPortFromClientV1(client),
      classifyError: (error) =>
        classifyAtlassianSessionError(error) === "not-logged-in"
          ? "authentication"
          : "unknown",
      createSourcePlan: (_sourceRequest, sourceContext) => ({
        store: createConfluenceSourcePlanSpoolV1(sourceContext),
        sourcePolicyKey: "adf-primary:cloud:v1",
      }),
      createBodyStore: (sourceRequest, sourceContext) =>
        createExportTreeBodySpoolV1(
          sourceContext,
          sourceRequest.idempotencyKey,
        ),
      onProgress: (_sourceRequest, sourceContext, progress) => {
        return sourceContext.updateProgress({
          stage: "fetch",
          done: progress.fetched,
          total: progress.total,
          updatedAt: Date.now(),
        });
      },
      async build(resolved, sourceRequest, sourceContext) {
        if (
          sourceRequest.template.id !== BUILTIN_PDF_TEMPLATE_MANIFEST.id ||
          sourceRequest.template.manifestVersion !==
            BUILTIN_PDF_TEMPLATE_MANIFEST.version
        ) {
          throw new Error(
            "The pinned PDF template manifest is unavailable or changed.",
          );
        }
        try {
          const mentions = await defaultResolveMentions(
            resolved.blocks,
            siteOrigin,
            sourceContext.signal,
          );
          resolved.blocks = mentions.blocks;
          if (mentions.unresolved > 0) {
            resolved.sourceNotes.push({
              level: "warning",
              code: "mention-unresolved",
              message:
                `${mentions.unresolved} mention display name(s) could not be resolved; technical identifiers were retained.`,
            });
          }
        } catch {
          sourceContext.signal.throwIfAborted();
          resolved.sourceNotes.push({
            level: "warning",
            code: "pdf-mention-resolution-failed",
            message:
              "Mention display names could not be resolved; technical identifiers were retained.",
          });
        }

        const locale = normalizePdfLocale(runtimeLocale());
        const selectedProfile = pdfProfile(sourceRequest.options.profile);
        const settings = await durableSettings(
          sourceRequest,
          { bytes },
          sourceContext.signal,
        );
        const macros = defaultCreateMacros({
          siteOrigin,
          signal: sourceContext.signal,
          live: sourceRequest.options.resolveMacros,
          ...(resolved.chapterAnchorById
            ? { chapterAnchorById: resolved.chapterAnchorById }
            : {}),
          sourceNotes: resolved.sourceNotes,
        });
        return {
          input: {
            metadata: {
              title: resolved.root.title,
              ...(resolved.root.spaceKey
                ? { space: resolved.root.spaceKey }
                : {}),
              ...(resolved.root.version === undefined
                ? {}
                : { version: resolved.root.version }),
              exporter: "atlcli",
              language: locale.language,
              region: locale.region,
              exportedAt: new Date(
                sourceRequest.options.exportedAt ?? Date.now(),
              ),
            },
            ...(selectedProfile ? { profile: selectedProfile } : {}),
            settings,
            filename: sourceRequest.requestedFilename ??
              sanitizeDownloadName(
                sourceRequest.displayName || "export",
                "pdf",
              ),
          },
          env: {
            assets: checkpointPdfAssetsV1(
              sourceContext,
              sourceRequest.idempotencyKey,
              extensionPdfAssets({
                rootPageId: resolved.root.id,
                pageUrl: siteOrigin,
                signal: sourceContext.signal,
              }),
            ),
            macros,
          },
        };
      },
    })(request, context);
  };
}

/**
 * Resolve a replay-safe durable request into the neutral PDF engine input.
 * Nothing here depends on the side panel, active tab, or a loaded React page.
 */
export function createExtensionPdfJobInputResolver(
  options: {
    bytes: Pick<IndexedDbExportByteStore, "read" | "stat">;
    deps?: Partial<ExtensionPdfJobResolverDepsV1>;
    /** Test/alternate-host port; production omits it and binds the session client. */
    sourcePort?: ConfluenceSourceResolverPortV1;
  },
): (
  request: PdfExportJobRequestV1,
  context: ExportJobExecutionContext,
) => Promise<ResolvedExtensionPdfJobInputV1> {
  if (!options.deps) {
    return createDefaultExtensionPdfJobInputResolver(
      options.bytes,
      options.sourcePort,
    );
  }
  const deps = { ...defaults(options.bytes), ...options.deps };
  return async (request, context) => {
    context.signal.throwIfAborted();
    const siteOrigin = siteOriginOf(request);
    if (
      request.template.id !== BUILTIN_PDF_TEMPLATE_MANIFEST.id
      || request.template.manifestVersion !== BUILTIN_PDF_TEMPLATE_MANIFEST.version
    ) {
      throw new Error("The pinned PDF template manifest is unavailable or changed.");
    }
    const root = await deps.loadRoot(request, context.signal);
    context.signal.throwIfAborted();
    const scope = requestScope(request, root);
    const composition: ExportComposition = await deps.resolveComposition({
      root,
      pageUrl: siteOrigin,
      exporter: "pdf",
      scope,
      ...(request.source.labels ? { labels: request.source.labels } : {}),
      ...(scope.kind === "page"
        ? {}
        : {
            bodyStore: createExportTreeBodySpoolV1(
              context,
              request.idempotencyKey,
            ),
          }),
      signal: context.signal,
      onProgress: (progress) => {
        void context.updateProgress({
          stage: "fetch",
          done: progress.fetched,
          total: progress.total,
          ...(progress.currentTitle ? { detail: progress.currentTitle } : {}),
          updatedAt: deps.now(),
        });
      },
    });
    context.signal.throwIfAborted();

    let blocks = composition.blocks;
    const sourceNotes: ExportNote[] = [...composition.notes];
    try {
      const mentions = await deps.resolveMentions(blocks, siteOrigin, context.signal);
      blocks = mentions.blocks;
      if (mentions.unresolved > 0) {
        sourceNotes.push({
          level: "warning",
          code: "mention-unresolved",
          message: `${mentions.unresolved} mention display name(s) could not be resolved; technical identifiers were retained.`,
        });
      }
    } catch {
      context.signal.throwIfAborted();
      sourceNotes.push({
        level: "warning",
        code: "pdf-mention-resolution-failed",
        message: "Mention display names could not be resolved; technical identifiers were retained.",
      });
    }

    const locale = normalizePdfLocale(deps.locale());
    const profile = pdfProfile(request.options.profile);
    const settings = await durableSettings(request, deps, context.signal);
    const macros = deps.createMacros({
      siteOrigin,
      signal: context.signal,
      live: request.options.resolveMacros,
      ...(composition.chapterAnchorById
        ? { chapterAnchorById: composition.chapterAnchorById }
        : {}),
      sourceNotes,
    });
    return {
      input: {
        blocks,
        sourceNotes,
        complete: composition.complete,
        metadata: {
          title: composition.root.title,
          ...(composition.root.spaceKey ? { space: composition.root.spaceKey } : {}),
          ...(composition.root.version === undefined
            ? {}
            : { version: composition.root.version }),
          ...(root.modifiedBy?.displayName
            ? { author: root.modifiedBy.displayName, exporter: root.modifiedBy.displayName }
            : { exporter: "atlcli" }),
          language: locale.language,
          region: locale.region,
          exportedAt: new Date(request.options.exportedAt ?? deps.now()),
        },
        page: {
          id: composition.root.id,
          ...(composition.root.version === undefined
            ? {}
            : { version: composition.root.version }),
          ...(composition.root.spaceKey
            ? { spaceKey: composition.root.spaceKey }
            : {}),
        },
        ...(profile ? { profile } : {}),
        settings,
        filename: request.requestedFilename
          ?? sanitizeDownloadName(request.displayName || "export", "pdf"),
      },
      env: {
        assets: checkpointPdfAssetsV1(
          context,
          request.idempotencyKey,
          deps.createAssets({
            rootPageId: composition.root.id,
            siteOrigin,
            signal: context.signal,
          }),
        ),
        macros,
      },
      telemetry: { sourcePageCount: composition.pageCount },
    };
  };
}
