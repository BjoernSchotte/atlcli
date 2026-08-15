import { expect, test } from "bun:test";
import {
  createStarlightPublicationNavigationV1,
  starlightPublicationHrefV1,
  starlightPublicationLabelLandingV1,
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
  labels: [{ label: "Docs", slug: "docs", route: "/topics/docs/", sourceIds: ["guide", "root"] }],
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
    pages: expect.any(Array), labels: expect.any(Array),
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
  expect(starlightPublicationLabelLandingV1(result, "docs")).toEqual({
    label: "Docs", slug: "docs", href: "/publish/topics/docs/",
    pages: [
      { sourceId: "guide", title: "Guide", href: "/publish/guide/" },
      { sourceId: "root", title: "Knowledge", href: "/publish/knowledge/" },
    ],
  });
});

test("keeps route identity closed and rejects missing page lookups or untrusted labels", () => {
  expect(starlightPublicationHrefV1("/", "/publish")).toBe("/publish/");
  expect(starlightPublicationHrefV1("/guide/", "")).toBe("/guide/");
  expect(starlightPublicationHrefV1("/guide/", "/publish", "/docs")).toBe("/docs/publish/guide/");
  expect(() => createStarlightPublicationNavigationV1({ navigation, routePrefix: "/publish", landingLabel: " " })).toThrow("landingLabel");
  const result = createStarlightPublicationNavigationV1({ navigation, routePrefix: "/publish", landingLabel: "Overview" });
  expect(() => starlightPublicationPageNavigationV1(result, "unknown")).toThrow("no page");
  expect(() => starlightPublicationLabelLandingV1(result, "unknown")).toThrow("no label landing");
});

test("maps every Starlight chrome link through the configured Astro base", () => {
  const result = createStarlightPublicationNavigationV1({
    navigation,
    routePrefix: "/publish",
    base: "/docs",
    landingLabel: "Overview",
  });
  expect(result.sidebar).toEqual([{
    label: "Knowledge", collapsed: false,
    items: [
      { label: "Overview", link: "/publish/knowledge/" },
      { label: "Guide", link: "/publish/guide/" },
    ],
  }]);
  expect(starlightPublicationPageNavigationV1(result, "guide").previous?.href).toBe("/docs/publish/knowledge/");
  expect(starlightPublicationLabelLandingV1(result, "docs").pages[0]?.href).toBe("/docs/publish/guide/");
});
