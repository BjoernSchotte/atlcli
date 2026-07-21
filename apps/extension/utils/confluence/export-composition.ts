/**
 * Scope → ONE composed block list, shared by both engines (spec 010 T5.1,
 * Architecture point 1).
 *
 * ## Why this module exists at all
 *
 * The PDF host (`utils/pdf/run-export.ts`) and the DOCX host
 * (`entrypoints/sidepanel/ports/docx.ts` via `utils/docx/export-deps.ts`) must
 * resolve `scope` + `labels` **identically** — same walk, same label pruning,
 * same chapter composition, same notes, same completeness verdict. The CLI gets
 * that for free because both of its paths call `fetchExportTree` →
 * `composeChapters` in the same file. Here they are two modules, and "keep the
 * two in sync" is exactly the instruction that stops being followed. So the
 * orchestration lives once, in the layer both hosts already depend on.
 *
 * Everything below is a *call* into folder 002's shared orchestration. There is
 * no extension-only tree logic here: the walk, the label filter, the ordering,
 * the completeness contract and the chapter composition are all
 * `@atlcli/confluence`'s, and the only genuinely host-shaped decision — how to
 * spell an absolute Confluence URL for a link that points OUT of the export
 * scope — is the same `buildConfluenceUrl` the CLI uses.
 *
 * The `TreeSource` is injected (defaulting to `sessionTreeSource`) so a test
 * drives a real `fetchExportTree` over a port-level fake instead of mocking
 * HTTP.
 */
import {
  buildConfluenceUrl,
  type Profile,
} from "@atlcli/core";
import {
  composeChapters,
  fetchExportTree,
  storageToBlocks,
  type ComposeOptions,
  type CompletenessMode,
  type ExportBlock,
  type ExportNote,
  type ExportScope,
  type LabelFilter,
  type TreeFetchProgress,
  type TreeSource,
} from "@atlcli/confluence/browser";
import { profileFromTabUrl } from "../profile.js";
import { NOT_ATLASSIAN_HOST_MESSAGE, sessionTreeSource } from "./tree-source.js";

export { NOT_ATLASSIAN_HOST_MESSAGE };

/**
 * True for the scopes that require a tree walk. A `page` scope (or no scope at
 * all — today's implicit default) resolves from the already-loaded page and
 * issues no extra request, which is what keeps the 90 % single-page case as
 * cheap as it was before T5.1.
 */
export function isTreeScope(scope: ExportScope | undefined): scope is Extract<
  ExportScope,
  { kind: "tree" } | { kind: "space" }
> {
  return scope !== undefined && (scope.kind === "tree" || scope.kind === "space");
}

/** The root page the panel already loaded (`LoadedPage.details`, structurally). */
export interface CompositionRootPage {
  id: string;
  title: string;
  version?: number;
  spaceKey?: string;
  storage?: string;
}

export interface ExportCompositionInput {
  root: CompositionRootPage;
  /** The active tab's URL — the single source of the session profile. */
  pageUrl: string;
  /** Absent → single page (today's behaviour). */
  scope?: ExportScope;
  labels?: LabelFilter;
  /** Which engine's walker dialect to use for the single-page walk. */
  exporter: "pdf" | "word";
  /** Left at the engine default (`strict`) unless the host chooses otherwise. */
  completenessMode?: CompletenessMode;
  maxPages?: number;
  signal?: AbortSignal;
  /** `{ fetched, total, currentTitle }` — one call per fetched page body. */
  onProgress?: (progress: TreeFetchProgress) => void;
}

export interface ExportCompositionDeps {
  /**
   * Injectable `TreeSource` seam. Production passes nothing and gets
   * `sessionTreeSource`; a test supplies a port-level fake, which is a real
   * implementation of folder 002's port — not an HTTP mock.
   */
  createTreeSource: (pageUrl: string, signal?: AbortSignal) => TreeSource;
}

export interface ExportComposition {
  /** `page` for the single-page path, `tree` once `fetchExportTree` ran. */
  kind: "page" | "tree";
  blocks: ExportBlock[];
  /** Fetch + compose notes (tree/space) or walker notes (single page). */
  notes: ExportNote[];
  /** Folder 002's completeness contract; always `true` for a single page. */
  complete: boolean;
  /**
   * Document metadata source. For a single page this is the loaded page; for a
   * tree/space export it is the walk's ROOT NODE, which for `space` scope is
   * the resolved homepage rather than whatever tab the user happened to be on.
   */
  root: { id: string; title: string; version?: number; spaceKey?: string };
  /**
   * `composeChapters(...).chapterAnchorById` — tree/space only. Macro
   * resolution runs after composition, so a renderer that links to other
   * Confluence pages reads composition's own in-scope answer from here instead
   * of resolving links a second way.
   */
  chapterAnchorById?: ReadonlyMap<string, string>;
  /** Pages that entered the document (1 for a single-page export). */
  pageCount: number;
}

const defaultDeps: ExportCompositionDeps = {
  createTreeSource: (pageUrl, signal) =>
    sessionTreeSource(pageUrl, signal ? { signal } : {}),
};

/**
 * Absolute-URL builder for a link whose target page is outside the export
 * scope. Same shape as the CLI's (`apps/cli/src/commands/export-pdf.ts`), built
 * from the session profile rather than a configured one.
 */
function externalUrlResolver(profile: Profile): NonNullable<ComposeOptions["resolveExternalUrl"]> {
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
    const url = buildConfluenceUrl(profile, path);
    return anchor ? `${url}#${anchor}` : url;
  };
}

/**
 * Resolve the requested scope into one composed document.
 *
 * Single page: walks the already-loaded storage — with `pageContext`, so
 * attachment `ImageSource`s carry `pageId` and `unknown` blocks carry
 * `sourcePage` exactly as they do in a tree export. That uniformity is what
 * lets the asset resolvers and the macro `contextFor` take ONE code path for
 * both scopes rather than special-casing the root.
 *
 * Tree/space: folder 002's `fetchExportTree` (label filter, ordering,
 * completeness, `onProgress`, `signal`) followed by `composeChapters`. The
 * `signal` reaches the WALK, not only the compile — a Cancel during page 37 of
 * 210 stops fetching immediately.
 */
export async function resolveExportComposition(
  input: ExportCompositionInput,
  overrides: Partial<ExportCompositionDeps> = {}
): Promise<ExportComposition> {
  const deps = { ...defaultDeps, ...overrides };
  input.signal?.throwIfAborted();

  if (!isTreeScope(input.scope)) {
    const walked = storageToBlocks(input.root.storage ?? "", {
      exporter: input.exporter,
      pageContext: {
        id: input.root.id,
        ...(input.root.version !== undefined ? { version: input.root.version } : {}),
        ...(input.root.spaceKey !== undefined ? { spaceKey: input.root.spaceKey } : {}),
        title: input.root.title,
      },
    });
    return {
      kind: "page",
      blocks: walked.blocks,
      notes: walked.notes,
      complete: true,
      root: {
        id: input.root.id,
        title: input.root.title,
        ...(input.root.version !== undefined ? { version: input.root.version } : {}),
        ...(input.root.spaceKey !== undefined ? { spaceKey: input.root.spaceKey } : {}),
      },
      pageCount: 1,
    };
  }

  const profile = profileFromTabUrl(input.pageUrl);
  if (!profile) throw new Error(NOT_ATLASSIAN_HOST_MESSAGE);

  const source = deps.createTreeSource(input.pageUrl, input.signal);
  const tree = await fetchExportTree(source, input.scope, {
    ...(input.labels ? { labels: input.labels } : {}),
    ...(input.completenessMode ? { completenessMode: input.completenessMode } : {}),
    ...(input.maxPages !== undefined ? { maxPages: input.maxPages } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
  input.signal?.throwIfAborted();

  const composed = composeChapters(tree.nodes, {
    resolveExternalUrl: externalUrlResolver(profile),
  });

  // The metadata root is the walk's first PAGE node: for `space` scope that is
  // the resolved homepage, which is generally NOT the tab the panel is sitting
  // on. Falling back to the loaded page keeps a degenerate (folder-only) walk
  // from producing a title-less document.
  const rootNode = tree.nodes.find((node) => node.kind === "page");
  const root = rootNode
    ? {
        id: rootNode.pageId,
        title: rootNode.title,
        ...(rootNode.meta.version !== undefined ? { version: rootNode.meta.version } : {}),
        ...(rootNode.meta.spaceKey !== undefined ? { spaceKey: rootNode.meta.spaceKey } : {}),
      }
    : {
        id: input.root.id,
        title: input.root.title,
        ...(input.root.version !== undefined ? { version: input.root.version } : {}),
        ...(input.root.spaceKey !== undefined ? { spaceKey: input.root.spaceKey } : {}),
      };

  return {
    kind: "tree",
    blocks: composed.blocks,
    notes: [...tree.notes, ...composed.notes],
    complete: tree.complete,
    root,
    chapterAnchorById: composed.chapterAnchorById,
    pageCount: tree.nodes.filter((node) => node.kind === "page").length,
  };
}
