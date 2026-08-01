import { expect, test } from "bun:test";
import {
  createStarlightPublicationNavigationV1,
  starlightPublicationHrefV1,
  starlightPublicationPageNavigationV1,
} from "./navigation.js";

const navigation = {
  roots: [{
    sourceId: "root", title: "Knowledge", route: "/knowledge/", children: [{
      sourceId: "guide", title: "Guide", route: "/guide/", children: [],
    }],
  }],
  pages: [
    {
      sourceId: "root",
      breadcrumbs: [{ sourceId: "root", title: "Knowledge", route: "/knowledge/" }],
      toc: [],
      next: { sourceId: "guide", title: "Guide", route: "/guide/" },
      related: [],
    },
    {
      sourceId: "guide",
      breadcrumbs: [
        { sourceId: "root", title: "Knowledge", route: "/knowledge/" },
        { sourceId: "guide", title: "Guide", route: "/guide/" },
      ],
      toc: [{ anchorId: "install", level: 2, text: "Install" }],
      previous: { sourceId: "root", title: "Knowledge", route: "/knowledge/" },
      related: [{
        sourceId: "root", title: "Knowledge", route: "/knowledge/", score: 5,
        reasons: ["same-root"],
      }],
    },
  ],
  labels: [],
} as const;

test("maps the neutral plan to documented Starlight sidebar data and route-prefixed chrome links", () => {
  const result = createStarlightPublicationNavigationV1({
    navigation,
    routePrefix: "/publish",
    landingLabel: "Overview",
  });
  expect(result).toEqual({
    routePrefix: "/publish",
    sidebar: [{
      label: "Knowledge", collapsed: false,
      items: [
        { label: "Overview", link: "/publish/knowledge/" },
        { label: "Guide", link: "/publish/guide/" },
      ],
    }],
    pages: expect.any(Array),
  });
  expect(starlightPublicationPageNavigationV1(result, "guide")).toEqual({
    sourceId: "guide",
    breadcrumbs: [
      { sourceId: "root", title: "Knowledge", href: "/publish/knowledge/" },
      { sourceId: "guide", title: "Guide", href: "/publish/guide/" },
    ],
    toc: [{ anchorId: "install", level: 2, text: "Install" }],
    previous: { sourceId: "root", title: "Knowledge", href: "/publish/knowledge/" },
    related: [{
      sourceId: "root", title: "Knowledge", href: "/publish/knowledge/", score: 5,
      reasons: ["same-root"],
    }],
  });
});

test("keeps route identity closed and rejects missing page lookups or untrusted labels", () => {
  expect(starlightPublicationHrefV1("/", "/publish")).toBe("/publish/");
  expect(starlightPublicationHrefV1("/guide/", "")).toBe("/guide/");
  expect(() => createStarlightPublicationNavigationV1({ navigation, routePrefix: "/publish", landingLabel: " " })).toThrow("landingLabel");
  const result = createStarlightPublicationNavigationV1({ navigation, routePrefix: "/publish", landingLabel: "Overview" });
  expect(() => starlightPublicationPageNavigationV1(result, "unknown")).toThrow("no page");
});
