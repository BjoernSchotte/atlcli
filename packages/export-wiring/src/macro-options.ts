/**
 * Assemble the `MacroResolutionOptions` an engine env accepts, from real
 * clients.
 *
 * Client construction is the host's job — the CLI builds a token-auth
 * `ConfluenceClient`/`JiraClient` from a profile, the extension builds a
 * session-auth pair from the active tab, a Forge app would build one from its
 * bridge. This function takes them already built, so the wiring is identical
 * everywhere and only the credentials differ.
 */
import {
  extractMacroBody,
  htmlToExportBlocks,
  parsePageProperties,
  storageToBlocks,
  type ConfluenceClient,
} from "@atlcli/confluence";
import {
  defaultRegistry,
  type ExternalAssetFetcher,
  type ExternalAssetPolicy,
  type MacroExportContext,
  type MacroPageScope,
  type MacroRendererRegistry,
  type MacroResolutionOptions,
} from "@atlcli/export-macros";
import { defaultExternalAssetFetcher, defaultExternalAssetPolicy } from "./asset-policy.js";
import {
  attachmentLookupFromClient,
  confluenceContentPortFromClient,
  exportViewPortFromClient,
  jiraIssuePortFromClient,
  type JiraClientLike,
} from "./ports.js";

/**
 * The `defaultRegistry` construction site every host shares — same injected
 * deps, same renderer set, so a macro renders identically from the CLI, the
 * panel, and any future shell.
 */
export function createMacroRegistry(): MacroRendererRegistry {
  return defaultRegistry({
    storageToBlocks,
    htmlToExportBlocks,
    parsePageProperties,
    extractMacroBody,
  });
}

export interface BuildMacroOptionsArgs {
  /**
   * The site base URL (`https://acme.atlassian.net`). Used for the Jira browse
   * links, the `siteId` cache key, and — unless {@link policy} is supplied —
   * the same-origin external-asset policy.
   */
  siteBaseUrl: string;
  confluence: ConfluenceClient;
  /** Present only when the host has Jira access configured. */
  jira?: JiraClientLike;
  targetEngine: "docx" | "pdf";
  /** `false` for `--no-live-macros` (compliance/deterministic exports). */
  live?: boolean;
  /** Whether the DOCX template already carries a native TOC field. */
  nativeTocPresent?: boolean;
  /**
   * Host-supplied allow/reject decision for `export_view`-sourced image URLs.
   * Defaults to same-origin-only over {@link siteBaseUrl}; a host widens it by
   * passing its own (e.g. the extension's manifest-granted media origins).
   */
  policy?: ExternalAssetPolicy;
  /** Host-supplied fetcher; defaults to the shared enforced one over `policy`. */
  externalAssets?: ExternalAssetFetcher;
  /**
   * `composeChapters(...).chapterAnchorById` for a tree/space export.
   *
   * Renderers that link to OTHER Confluence pages (the Confluence-list
   * datasource) run after composition, so composition can no longer rewrite
   * their link targets; this hands them composition's own answer instead of
   * growing a second link-resolution path. Omitted for single-page exports —
   * nothing else is in scope there, so every row links absolutely.
   */
  chapterAnchorById?: ReadonlyMap<string, string>;
  /** Cancels in-flight port work; forwarded into every macro context. */
  signal?: AbortSignal;
}

/**
 * Build the resolution options: the shared registry plus a `contextFor` that
 * assembles a per-source-page context over ports shared across pages.
 *
 * **`contextFor` receives each macro's OWN source page.** The resolver calls
 * `contextFor(block.sourcePage ?? ctx.page)`, so in a tree/space export this is
 * the page the macro actually sits on. Never substitute the export root's id
 * here: every Jira/`export_view` macro on a child page would then resolve
 * against the wrong page (wrong attachment lookups, wrong macro bodies) while
 * looking perfectly successful in the report.
 *
 * The ports are shared across pages on purpose — their batch/listing
 * memoisation and the resolver's circuit breaker are keyed by page id inside
 * the ports, which is what makes a 200-page export cost one `export_view`
 * request per page rather than one per macro.
 */
export function buildMacroResolutionOptions(args: BuildMacroOptionsArgs): MacroResolutionOptions {
  const registry = createMacroRegistry();
  const confluencePort = confluenceContentPortFromClient(
    args.confluence,
    args.signal,
  );
  const exportViewPort = exportViewPortFromClient(args.confluence, args.signal);
  const attachmentsPort = attachmentLookupFromClient(
    args.confluence,
    args.signal,
  );
  const jiraPort = args.jira
    ? jiraIssuePortFromClient(args.jira, args.siteBaseUrl, args.signal)
    : undefined;
  const policy = args.policy ?? defaultExternalAssetPolicy(args.siteBaseUrl);
  const externalAssets = args.externalAssets ?? defaultExternalAssetFetcher(policy);
  const siteId = args.siteBaseUrl;
  const anchors = args.chapterAnchorById;
  const pageScope: MacroPageScope | undefined = anchors
    ? { chapterAnchorFor: (pageId) => anchors.get(pageId) }
    : undefined;

  return {
    registry,
    ...(args.live !== undefined ? { live: args.live } : {}),
    contextFor(page): MacroExportContext {
      return {
        page,
        confluence: confluencePort,
        exportView: exportViewPort,
        attachments: attachmentsPort,
        ...(jiraPort ? { jira: jiraPort } : {}),
        ...(pageScope ? { pageScope } : {}),
        externalAssets,
        depth: 0,
        visited: new Set(),
        siteId,
        siteOrigin: args.siteBaseUrl,
        ...(args.signal ? { signal: args.signal } : {}),
        flags: {
          ...(args.nativeTocPresent ? { nativeTocPresent: true } : {}),
          targetEngine: args.targetEngine,
        },
      };
    },
  };
}
