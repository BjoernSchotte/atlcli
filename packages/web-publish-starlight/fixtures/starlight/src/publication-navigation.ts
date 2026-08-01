import type { PublicationPageV1 } from "@atlcli/web-publish";
import type { ExportBlock } from "@atlcli/export-blocks";
import { planPublicationNavigationV1 } from "@atlcli/web-publish";
import {
  createStarlightPublicationNavigationV1,
  starlightPublicationPageNavigationV1,
} from "@atlcli/web-publish-starlight";
import { PUBLISHED_RELEASE_BLOCKS_V1 } from "./published-release";

export const PUBLISHED_GUIDE_BLOCKS_V1: readonly ExportBlock[] = [
  { type: "heading", level: 2, explicitAnchor: "prepare", content: [{ type: "text", text: "Prepare" }] },
  { type: "paragraph", content: [{ type: "text", text: "A responsive Starlight presentation keeps normalized content separate from its theme." }] },
  { type: "heading", level: 2, explicitAnchor: "publish", content: [{ type: "text", text: "Publish" }] },
  { type: "paragraph", content: [{ type: "link", target: { kind: "anchor", anchor: "prepare" }, content: [{ type: "text", text: "Return to preparation" }] }] },
];

const pages: readonly PublicationPageV1[] = [
  {
    schema: "atlcli.publication-page/1", sourceId: "release-notes", sourceVersion: "fixture", title: "Release notes",
    position: 0, depth: 0, route: "/", blocks: PUBLISHED_RELEASE_BLOCKS_V1, notes: [], labels: ["release", "publishing"],
    links: [{ referenceId: "guide", kind: "page", sourceId: "publishing-guide" }], assetIds: [], renderDependencies: [], pageDigest: "fixture-release",
  },
  {
    schema: "atlcli.publication-page/1", sourceId: "publishing-guide", sourceVersion: "fixture", title: "Publishing guide",
    parentId: "release-notes", position: 1, depth: 1, route: "/guide/", blocks: PUBLISHED_GUIDE_BLOCKS_V1,
    notes: [], labels: ["guide", "publishing"],
    links: [{ referenceId: "release", kind: "page", sourceId: "release-notes" }], assetIds: [], renderDependencies: [], pageDigest: "fixture-guide",
  },
];

const plan = planPublicationNavigationV1({ pages, rootIds: ["release-notes"] });
export const PUBLISHED_STARLIGHT_NAVIGATION_V1 = createStarlightPublicationNavigationV1({
  navigation: plan,
  routePrefix: "",
  landingLabel: "Overview",
});

export const PUBLISHED_RELEASE_PAGE_V1 = pages[0]!;
export const PUBLISHED_GUIDE_PAGE_V1 = pages[1]!;
export const PUBLISHED_RELEASE_NAVIGATION_V1 = starlightPublicationPageNavigationV1(PUBLISHED_STARLIGHT_NAVIGATION_V1, "release-notes");
export const PUBLISHED_GUIDE_NAVIGATION_V1 = starlightPublicationPageNavigationV1(PUBLISHED_STARLIGHT_NAVIGATION_V1, "publishing-guide");
