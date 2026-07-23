import type { ExportSourceV1 } from "@atlcli/export-jobs";
import type { ExportScopeRequest } from "../ports/export.js";
import type { LoadedPage } from "../read-path.js";
import { profileFromTabUrl } from "../profile.js";

export interface ExtensionConfluenceJobSourceInput
  extends Pick<ExportScopeRequest, "scope" | "labels"> {
  page: LoadedPage;
  pageUrl: string;
}

/**
 * Resolve only the immutable source identity. Discovery and page reads belong
 * to the background executor and must not happen while creating the request.
 */
export function createExtensionConfluenceJobSource(
  request: ExtensionConfluenceJobSourceInput,
): ExportSourceV1 {
  const profile = profileFromTabUrl(request.pageUrl);
  if (!profile) throw new Error("The active page is not on an approved Atlassian host.");
  const rootId = request.page.details.id;
  if (!rootId) throw new Error("Background export requires a Confluence page id.");

  const selectedScope = request.scope ?? { kind: "page" as const, pageId: rootId };
  const selectedPageId = selectedScope.kind === "tree"
    ? selectedScope.rootPageId
    : selectedScope.kind === "page"
      ? selectedScope.pageId
      : undefined;
  const source: ExportSourceV1 = selectedScope.kind === "space"
    ? {
        kind: "confluence",
        siteOrigin: profile.baseUrl,
        locator: { kind: "space-key", spaceKey: selectedScope.spaceKey },
        scope: { kind: "space" },
      }
    : {
        kind: "confluence",
        siteOrigin: profile.baseUrl,
        locator: {
          kind: "page-id",
          id: selectedPageId!,
          ...(request.page.details.version === undefined || selectedPageId !== rootId
            ? {}
            : { version: request.page.details.version }),
        },
        scope: selectedScope.kind === "tree"
          ? {
              kind: "tree",
              ...(selectedScope.includeRoot === undefined
                ? {}
                : { includeRoot: selectedScope.includeRoot }),
              ...(selectedScope.maxDepth === undefined
                ? {}
                : { maxDepth: selectedScope.maxDepth }),
            }
          : { kind: "page" },
      };
  return {
    ...source,
    ...(request.labels === undefined ? {} : { labels: structuredClone(request.labels) }),
  };
}
