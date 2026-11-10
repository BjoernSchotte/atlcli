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

test("ranks related pages exactly as an exhaustive pairwise comparison would", () => {
  // Deterministic pseudo-random graph: three roots, nested children, shared
  // labels, cross links, duplicate titles and a self link.
  let seed = 7;
  const random = (bound: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % bound;
  };
  const pages: PublicationPageV1[] = [];
  for (let index = 0; index < 60; index += 1) {
    const parent = index < 3 ? undefined : pages[random(index)]!;
    pages.push(page({
      sourceId: `p${index}`,
      title: `Title ${random(12)}`,
      route: `/p${index}/`,
      position: random(4),
      ...(parent === undefined ? {} : { parentId: parent.sourceId, depth: parent.depth + 1 }),
      labels: [["Alpha", "alpha", "Beta", "Gamma", "Delta"][random(5)]!].slice(0, random(3) === 0 ? 0 : 1),
      links: Array.from({ length: random(3) }, (_, link) => ({ referenceId: `l${link}`, kind: "page" as const, sourceId: `p${random(60)}` })),
    }));
  }
  const byId = new Map(pages.map((entry) => [entry.sourceId, entry]));
  const rootOf = (entry: PublicationPageV1): string => entry.parentId === undefined ? entry.sourceId : rootOf(byId.get(entry.parentId)!);
  const fold = (label: string): string => label.normalize("NFKC").toLowerCase();
  const linksTo = (from: PublicationPageV1, to: PublicationPageV1): boolean => from.links.some((link) => link.kind === "page" && link.sourceId === to.sourceId);
  const expected = (current: PublicationPageV1, limit: number): { sourceId: string; score: number; reasons: string[] }[] => pages.flatMap((candidate) => {
    if (candidate === current) return [];
    const reasons: string[] = [];
    let score = 0;
    if (linksTo(current, candidate)) { score += 100; reasons.push("outbound-link"); }
    if (linksTo(candidate, current)) { score += 75; reasons.push("inbound-link"); }
    if (candidate.labels.some((label) => current.labels.map(fold).includes(fold(label)))) { score += 20; reasons.push("shared-label"); }
    if (current.parentId === candidate.parentId) { score += 10; reasons.push("same-parent"); }
    if (rootOf(current) === rootOf(candidate)) { score += 5; reasons.push("same-root"); }
    return score === 0 ? [] : [{ sourceId: candidate.sourceId, title: candidate.title, score, reasons }];
  }).sort((left, right) => right.score - left.score || left.title.localeCompare(right.title) || left.sourceId.localeCompare(right.sourceId))
    .slice(0, limit).map(({ sourceId, score, reasons }) => ({ sourceId, score, reasons }));

  for (const limit of [1, 6, 100]) {
    const plan = planPublicationNavigationV1({ rootIds: ["p0", "p1", "p2"], pages, maxRelatedPages: limit });
    for (const entry of plan.pages) {
      expect(entry.related.map(({ sourceId, score, reasons }) => ({ sourceId, score, reasons: [...reasons] as string[] })))
        .toEqual(expected(byId.get(entry.sourceId)!, limit));
    }
  }
});
