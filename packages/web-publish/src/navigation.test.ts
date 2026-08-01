import { expect, test } from "bun:test";
import {
  PublicationNavigationPlanningErrorV1,
  planPublicationNavigationV1,
  type PublicationPageV1,
} from "./index.js";

function page(input: Pick<PublicationPageV1, "sourceId" | "title" | "route"> & Partial<PublicationPageV1>): PublicationPageV1 {
  return {
    schema: "atlcli.publication-page/1",
    sourceVersion: "1",
    position: 0,
    depth: 0,
    blocks: [],
    notes: [],
    labels: [],
    links: [],
    assetIds: [],
    renderDependencies: [],
    pageDigest: `${input.sourceId}-digest`,
    ...input,
  };
}

function expectError(run: () => unknown, code: PublicationNavigationPlanningErrorV1["code"]): void {
  expect(run).toThrow(PublicationNavigationPlanningErrorV1);
  try { run(); } catch (error) { expect((error as PublicationNavigationPlanningErrorV1).code).toBe(code); }
}

test("plans ordered tree navigation, breadcrumbs, TOC, previous/next, labels, and explainable related pages", () => {
  const result = planPublicationNavigationV1({
    rootIds: ["root"],
    maxRelatedPages: 3,
    pages: [
      page({
        sourceId: "root", title: "Knowledge", route: "/knowledge/", labels: ["Docs"],
        blocks: [{ type: "heading", level: 1, content: [{ type: "text", text: "Knowledge" }] }],
      }),
      page({
        sourceId: "guide", title: "Guide", route: "/guide/", parentId: "root", position: 2, depth: 1,
        labels: ["Docs", "Getting Started"],
        links: [{ referenceId: "related", kind: "page", sourceId: "reference" }],
        blocks: [{ type: "heading", level: 2, explicitAnchor: "Install", content: [{ type: "text", text: "Install" }] }],
      }),
      page({
        sourceId: "reference", title: "Reference", route: "/reference/", parentId: "root", position: 1, depth: 1,
        labels: ["Docs"],
        links: [{ referenceId: "back", kind: "page", sourceId: "guide" }],
      }),
    ],
  });
  expect(result.roots).toEqual([{
    sourceId: "root", title: "Knowledge", route: "/knowledge/",
    children: [
      { sourceId: "reference", title: "Reference", route: "/reference/", children: [] },
      { sourceId: "guide", title: "Guide", route: "/guide/", children: [] },
    ],
  }]);
  expect(result.pages.map((entry) => entry.sourceId)).toEqual(["root", "reference", "guide"]);
  expect(result.pages[2]).toMatchObject({
    breadcrumbs: [
      { sourceId: "root", title: "Knowledge", route: "/knowledge/" },
      { sourceId: "guide", title: "Guide", route: "/guide/" },
    ],
    toc: [{ anchorId: "install", level: 2, text: "Install" }],
    previous: { sourceId: "reference", title: "Reference", route: "/reference/" },
  });
  expect(result.pages[2]?.related[0]).toEqual({
    sourceId: "reference", title: "Reference", route: "/reference/", score: 210,
    reasons: ["outbound-link", "inbound-link", "shared-label", "same-parent", "same-root"],
  });
  expect(result.labels).toEqual([
    { label: "Docs", slug: "docs", route: "/topics/docs/", sourceIds: ["guide", "reference", "root"] },
    { label: "Getting Started", slug: "getting-started", route: "/topics/getting-started/", sourceIds: ["guide"] },
  ]);
});

test("allows a selected tree root to retain an out-of-scope parent identity", () => {
  const result = planPublicationNavigationV1({
    rootIds: ["selected-root"],
    pages: [page({
      sourceId: "selected-root", title: "Selected root", route: "/selected/", parentId: "outside", depth: 3,
    })],
  });
  expect(result.pages[0]?.breadcrumbs).toEqual([{ sourceId: "selected-root", title: "Selected root", route: "/selected/" }]);
});

test("fails closed for unsafe graph ownership, depth, and route ambiguity", () => {
  expectError(() => planPublicationNavigationV1({
    rootIds: ["missing"], pages: [page({ sourceId: "page", title: "Page", route: "/page/" })],
  }), "unknown-root");
  expectError(() => planPublicationNavigationV1({
    rootIds: ["root"], pages: [
      page({ sourceId: "root", title: "Root", route: "/root/" }),
      page({ sourceId: "child", title: "Child", route: "/child/", parentId: "root", depth: 0 }),
    ],
  }), "depth-mismatch");
  expectError(() => planPublicationNavigationV1({
    rootIds: ["root"], pages: [
      page({ sourceId: "root", title: "Root", route: "/root/" }),
      page({ sourceId: "other", title: "Other", route: "/root/" }),
    ],
  }), "duplicate-route");
  expectError(() => planPublicationNavigationV1({
    rootIds: ["root"], pages: [
      page({ sourceId: "root", title: "Root", route: "/root/" }),
      page({ sourceId: "orphan", title: "Orphan", route: "/orphan/", parentId: "unknown", depth: 1 }),
    ],
  }), "unknown-parent");
  expectError(() => planPublicationNavigationV1({
    rootIds: ["root"], labelRoutePrefix: "/", pages: [page({ sourceId: "root", title: "Root", route: "/root/" })],
  }), "invalid-label-route-prefix");
  expectError(() => planPublicationNavigationV1({
    rootIds: ["root"], pages: [
      page({ sourceId: "root", title: "Root", route: "/topics/docs/", labels: ["Docs"] }),
    ],
  }), "label-route-collision");
});
