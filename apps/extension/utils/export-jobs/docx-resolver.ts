import {
  ConfluenceClient,
  type ConfluencePageDetails,
  type ExportNote,
  type ExportScope,
} from "@atlcli/confluence/browser";
import { getConfluenceBaseUrl } from "@atlcli/core";
import type {
  DocxExportJobRequestV1,
  ExportJobExecutionContext,
} from "@atlcli/export-jobs";
import type { MacroResolutionOptions } from "@atlcli/export-macros";
import {
  checkpointDocxAssetsV1,
  createExportTreeBodySpoolV1,
  type TypescriptDocxExportJobResolvedInputV1,
} from "@atlcli/export-wiring/jobs";
import type { AssetFetcher, SvgRasterizer } from "@atlcli/docx/browser";
import type { ResolveDeps } from "@atlcli/docx/internal";
import {
  resolveDocxExportScope,
  type DocxScopeContribution,
  type DocxScopeInput,
} from "../docx/export-deps.js";
import {
  canvasSvgRasterizer,
  sessionDocxAssets,
} from "../docx/env.js";
import {
  buildSessionMacroResolutionOptions,
  createSessionMacroPorts,
  createSessionMacroState,
  SESSION_EXPIRED_MESSAGE,
} from "../macros/session-ports.js";
import { profileFromTabUrl } from "../profile.js";

export interface ExtensionDocxJobResolverDepsV1 {
  loadRoot(
    request: DocxExportJobRequestV1,
    signal: AbortSignal,
  ): Promise<ConfluencePageDetails>;
  resolveScope(
    input: DocxScopeInput,
  ): Promise<DocxScopeContribution | undefined>;
  createDeps(input: {
    root: ConfluencePageDetails;
    siteOrigin: string;
    signal: AbortSignal;
  }): ResolveDeps;
  createAssets(input: {
    siteOrigin: string;
    signal: AbortSignal;
  }): AssetFetcher;
  createRasterizer(): SvgRasterizer;
  createMacros(input: {
    siteOrigin: string;
    signal: AbortSignal;
    live: boolean;
    chapterAnchorById?: ReadonlyMap<string, string>;
    sourceNotes: ExportNote[];
  }): MacroResolutionOptions;
  now(): number;
}

function siteOriginOf(request: DocxExportJobRequestV1): string {
  const profile = profileFromTabUrl(request.source.siteOrigin);
  if (!profile) throw new Error("The DOCX job source is not an approved Atlassian Cloud origin.");
  if (request.authRef !== `session:${profile.baseUrl}`) {
    throw new Error("The DOCX job session reference does not match its source origin.");
  }
  return profile.baseUrl;
}

async function defaultLoadRoot(
  request: DocxExportJobRequestV1,
  signal: AbortSignal,
): Promise<ConfluencePageDetails> {
  const siteOrigin = siteOriginOf(request);
  const client = new ConfluenceClient(profileFromTabUrl(siteOrigin)!);
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
    throw new Error("The extension DOCX runner does not support content-key locators.");
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
    storage: historical.storage,
    ...(historical.version === undefined ? {} : { version: historical.version }),
    ...(historical.spaceKey === undefined ? {} : { spaceKey: historical.spaceKey }),
  };
}

function requestScope(
  request: DocxExportJobRequestV1,
  root: ConfluencePageDetails,
): ExportScope {
  if (request.source.scope.kind === "space") {
    if (request.source.locator.kind !== "space-key") {
      throw new Error("A space DOCX scope requires a space-key locator.");
    }
    return { kind: "space", spaceKey: request.source.locator.spaceKey };
  }
  if (request.source.locator.kind !== "page-id") {
    throw new Error("A page or tree DOCX scope requires a page-id locator.");
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

function defaultCreateDeps(input: {
  root: ConfluencePageDetails;
  siteOrigin: string;
  signal: AbortSignal;
}): ResolveDeps {
  const profile = profileFromTabUrl(input.siteOrigin)!;
  const client = new ConfluenceClient(profile);
  const checked = async <T>(load: () => Promise<T>): Promise<T> => {
    input.signal.throwIfAborted();
    const value = await load();
    input.signal.throwIfAborted();
    return value;
  };
  return {
    getSpace: async (key) => (await checked(() => client.getSpaceWithIcon(key))).space,
    getCurrentUser: () => checked(() => client.getCurrentUser()),
    getPageOwner: (id) => checked(() => client.getPageOwner(id)),
    getSpaceHomepageStorage: (key) =>
      checked(() => client.getSpaceHomepageStorage(key)),
    getSpaceLogo: async (key) => {
      const icon = (await checked(() => client.getSpaceWithIcon(key))).icon;
      return icon ? { url: icon.path } : null;
    },
    getIncludedPage: async (ref) => {
      const { buildGetIncludedPage } = await import("@atlcli/docx/internal");
      return buildGetIncludedPage({
        getPage: (id) => checked(() => client.getPage(id)),
        findPagesByTitle: (title, spaceKey) =>
          checked(() => client.findPagesByTitle(title, { spaceKey })),
        defaultSpaceKey: input.root.spaceKey,
      })(ref);
    },
  };
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
    targetEngine: "docx",
    signal: input.signal,
    live: input.live,
    ports,
    ...(input.chapterAnchorById
      ? { chapterAnchorById: input.chapterAnchorById }
      : {}),
  }).options;
}

function defaults(): ExtensionDocxJobResolverDepsV1 {
  return {
    loadRoot: defaultLoadRoot,
    resolveScope: (input) => resolveDocxExportScope(input),
    createDeps: defaultCreateDeps,
    createAssets: ({ siteOrigin }) => {
      const profile = profileFromTabUrl(siteOrigin)!;
      return sessionDocxAssets({
        pageUrl: siteOrigin,
        baseUrl: getConfluenceBaseUrl(profile),
      });
    },
    createRasterizer: () => canvasSvgRasterizer(),
    createMacros: defaultCreateMacros,
    now: Date.now,
  };
}

/** Resolve a durable request without any active-tab, panel, or React state. */
export function createExtensionDocxJobInputResolver(
  overrides: Partial<ExtensionDocxJobResolverDepsV1> = {},
): (
  request: DocxExportJobRequestV1,
  context: ExportJobExecutionContext,
) => Promise<TypescriptDocxExportJobResolvedInputV1> {
  const deps = { ...defaults(), ...overrides };
  return async (request, context) => {
    context.signal.throwIfAborted();
    const siteOrigin = siteOriginOf(request);
    const root = await deps.loadRoot(request, context.signal);
    context.signal.throwIfAborted();
    const sourceNotes: ExportNote[] = [];
    const scope = requestScope(request, root);
    const contribution = await deps.resolveScope({
      root,
      pageUrl: siteOrigin,
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
      onProgress: (value) => {
        void context.updateProgress({
          stage: "fetch",
          done: value.fetched,
          total: value.total,
          ...(value.currentTitle ? { detail: value.currentTitle } : {}),
          updatedAt: deps.now(),
        });
      },
    });
    if (contribution) sourceNotes.push(...contribution.sourceNotes);
    context.signal.throwIfAborted();
    const macros = deps.createMacros({
      siteOrigin,
      signal: context.signal,
      live: request.options.resolveMacros,
      ...(contribution?.chapterAnchorById
        ? { chapterAnchorById: contribution.chapterAnchorById }
        : {}),
      sourceNotes,
    });

    return {
      jobTelemetry: { sourcePageCount: contribution?.pageCount ?? 1 },
      details: root,
      ...(contribution
        ? {
            blocks: contribution.blocks,
            complete: contribution.complete,
          }
        : {}),
      sourceNotes,
      template: {
        name: request.template.name,
        modificationDate: new Date(
          request.template.uploadedAt ?? request.createdAt,
        ),
      },
      exportDate: new Date(request.createdAt),
      deps: deps.createDeps({ root, siteOrigin, signal: context.signal }),
      assets: checkpointDocxAssetsV1(
        context,
        request.idempotencyKey,
        deps.createAssets({ siteOrigin, signal: context.signal }),
      ),
      rasterizer: deps.createRasterizer(),
      macros,
      ...(request.options.keepIgnored ? { exportControls: "passthrough" as const } : {}),
      ...(request.options.updateFields
        ? { updateFields: request.options.updateFields }
        : {}),
      ...(request.options.captionLang
        ? { captionLang: request.options.captionLang }
        : {}),
    };
  };
}
