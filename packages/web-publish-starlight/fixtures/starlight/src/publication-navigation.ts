import type { PublicationPageV1 } from "@atlcli/web-publish";
import type { ExportBlock } from "@atlcli/export-blocks";
import { planPublicationNavigationV1 } from "@atlcli/web-publish";
import {
  createStarlightPublicationNavigationV1,
  starlightPublicationLabelLandingV1,
  starlightPublicationPageNavigationV1,
} from "@atlcli/web-publish-starlight";
import { chartWorldClassBlocksV1 } from "@atlcli/export-fixtures";
import { EXPORT_BLOCKS_ASTRO_CHART_SHAPES_FIXTURE_V1 } from "@atlcli/export-blocks-astro/fixtures";
import { PUBLISHED_RELEASE_BLOCKS_V1 } from "./published-release";

export const PUBLISHED_GUIDE_BLOCKS_V1: readonly ExportBlock[] = [
  { type: "heading", level: 2, explicitAnchor: "prepare", content: [{ type: "text", text: "Prepare" }] },
  { type: "paragraph", content: [{ type: "text", text: "A responsive Starlight presentation keeps normalized content separate from its theme." }] },
  { type: "heading", level: 2, explicitAnchor: "publish", content: [{ type: "text", text: "Publish" }] },
  { type: "paragraph", content: [{ type: "link", target: { kind: "anchor", anchor: "prepare" }, content: [{ type: "text", text: "Return to preparation" }] }] },
];

export const PUBLISHED_INTERACTIVE_CHART_BLOCKS_V1 = EXPORT_BLOCKS_ASTRO_CHART_SHAPES_FIXTURE_V1
  .filter((block): block is Extract<ExportBlock, { type: "chart" }> =>
    block.type === "chart" && (block.chart.kind === "bar" || block.chart.kind === "xyBar")
  )
  .map((block) => ({
    ...block,
    chart: {
      ...block.chart,
      title: `${block.chart.kind === "bar" ? "Categorical" : "XY"} bar interaction`,
      subtitle: "Optional TanStack enhancement; the complete static SVG and table remain available",
    },
  }));

if (PUBLISHED_INTERACTIVE_CHART_BLOCKS_V1.length !== 2) throw new TypeError("interactive chart gallery fixture drift");

export const PUBLISHED_CHART_BLOCKS_V1: readonly ExportBlock[] = [
  {
    type: "paragraph",
    content: [{
      type: "text",
      text: "Twelve source-neutral chart shapes share one pinned TanStack scene across Astro, DOCX, and PDF. Every chart keeps an exact-value data table and remains complete without JavaScript.",
    }],
  },
  ...chartWorldClassBlocksV1(),
  {
    type: "heading",
    level: 2,
    explicitAnchor: "interactive-enhancement",
    content: [{ type: "text", text: "Interactive enhancement" }],
  },
  {
    type: "paragraph",
    content: [{
      type: "text",
      text: "Bounded categorical and XY bar charts add responsive pointer and keyboard exploration. Static SVG and tabular values remain the canonical fallback.",
    }],
  },
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
  {
    schema: "atlcli.publication-page/1", sourceId: "chart-gallery", sourceVersion: "fixture", title: "Chart gallery",
    parentId: "release-notes", position: 2, depth: 1, route: "/charts/", blocks: PUBLISHED_CHART_BLOCKS_V1,
    notes: [], labels: ["charts", "publishing"], links: [], assetIds: [], renderDependencies: [], pageDigest: "fixture-charts",
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
export const PUBLISHED_CHART_PAGE_V1 = pages[2]!;
export const PUBLISHED_RELEASE_NAVIGATION_V1 = starlightPublicationPageNavigationV1(PUBLISHED_STARLIGHT_NAVIGATION_V1, "release-notes");
export const PUBLISHED_GUIDE_NAVIGATION_V1 = starlightPublicationPageNavigationV1(PUBLISHED_STARLIGHT_NAVIGATION_V1, "publishing-guide");
export const PUBLISHED_CHART_NAVIGATION_V1 = starlightPublicationPageNavigationV1(PUBLISHED_STARLIGHT_NAVIGATION_V1, "chart-gallery");
export const PUBLISHED_PUBLISHING_LABEL_LANDING_V1 = starlightPublicationLabelLandingV1(PUBLISHED_STARLIGHT_NAVIGATION_V1, "publishing");
