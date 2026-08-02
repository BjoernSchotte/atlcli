import { expect, test } from "bun:test";
import type { PublicationBundleV1, PublicationPageV1 } from "@atlcli/web-publish";
import { createPublicationRenderContextV1 } from "./render-context.js";
import { astroExportLinkKeyV1 } from "@atlcli/export-blocks-astro";

const targetPage: PublicationPageV1 = {
  schema: "atlcli.publication-page/1",
  sourceId: "target",
  sourceVersion: "1",
  title: "Target",
  position: 0,
  depth: 0,
  route: "/target/",
  blocks: [{ type: "heading", level: 2, explicitAnchor: "Details", content: [{ type: "text", text: "Details" }] }],
  notes: [],
  labels: [],
  links: [],
  assetIds: [],
  renderDependencies: [],
  pageDigest: "target-digest",
};

const page: PublicationPageV1 = {
  schema: "atlcli.publication-page/1",
  sourceId: "source",
  sourceVersion: "1",
  title: "Source",
  position: 0,
  depth: 0,
  route: "/source/",
  blocks: [
    { type: "heading", level: 2, explicitAnchor: "Intro", content: [{ type: "text", text: "Intro" }] },
    {
      type: "paragraph",
      content: [
        {
          type: "link",
          target: { kind: "page", contentId: "target", contentTitle: "Target", anchor: "Details" },
          content: [{ type: "text", text: "Read more" }],
        },
      ],
    },
    { type: "image", source: { kind: "attachment", pageId: "source", filename: "hero.png" }, alt: "Hero" },
  ],
  notes: [],
  labels: [],
  links: [
    { referenceId: "page-link", kind: "page", sourceId: "target", anchorId: "Details" },
    { referenceId: "asset-link", kind: "asset", assetId: "hero" },
    { referenceId: "external-link", kind: "external", href: "https://example.test/docs" },
    { referenceId: "unresolved-link", kind: "unresolved", reason: "missing", label: "Missing" },
  ],
  assetIds: ["hero"],
  renderDependencies: [],
  pageDigest: "source-digest",
};

const bundle = {
  schema: "atlcli.publication-bundle/1",
  bundleDigest: "bundle-digest",
  createdBy: { name: "atlcli", version: "0.1.0" },
  sourceSnapshot: { sourceDigest: "source", complete: true, deletionAuthority: "complete-scan", rootIds: ["source"], pages: [] },
  sourcePolicyDigest: "policy",
  chartPolicy: {
    strict: true,
    normalization: { maxRows: 2_000, maxSeries: 64, maxPoints: 20_000, maxBytes: 524_288 },
    static: { maxSvgNodes: 50_000, maxSvgBytes: 1_000_000, maxRenderMs: 1_000 },
    island: { enabled: false, maxRows: 80, maxSeries: 12, maxPoints: 800, maxBytes: 65_536, maxMountMs: 250 },
  },
  complete: true,
  rootIds: ["source"],
  pages: [],
  routes: [
    { sourceId: "source", route: "/source/", state: "active", assignedBy: "generated", previousRoutes: [] },
    { sourceId: "target", route: "/target/", state: "active", assignedBy: "generated", previousRoutes: [] },
  ],
  assets: [{ assetId: "hero", path: "assets/hero/hash/hero.png", sha256: "hash", byteLength: 3, mediaType: "image/png", disposition: "inline", downloadName: "hero.png" }],
  issues: [],
} as unknown as PublicationBundleV1;

test("resolves bundle page links, anchors, assets, and headings into the Astro context", () => {
  const context = createPublicationRenderContextV1({
    page,
    bundle,
    pages: [page, targetPage],
    base: "/docs",
    routePrefix: "/publish",
    locale: "en",
  });

  expect(context.headings.intro).toEqual({ id: "intro", level: 2, text: "Intro" });
  expect(context.headingAnchors?.["$blocks[0]"]).toBe("intro");
  expect(context.links["page-link"]).toEqual({ kind: "page", href: "/docs/publish/target/#details" });
  expect(context.links["asset-link"]).toEqual({ kind: "asset", href: "/docs/assets/hero/hash/hero.png" });
  expect(context.links["external-link"]).toEqual({ kind: "external", href: "https://example.test/docs" });
  expect(context.links["unresolved-link"]).toEqual({ kind: "unresolved", href: "#" });
  expect(context.assets["attachment:source:hero.png"]).toMatchObject({
    src: "/docs/assets/hero/hash/hero.png",
    downloadHref: "/docs/assets/hero/hash/hero.png",
    downloadName: "hero.png",
    mode: "verified-original",
  });
  expect(context.chartPolicy).toEqual(bundle.chartPolicy);
});

test("rejects unsafe URL base, route, and asset paths", () => {
  expect(() => createPublicationRenderContextV1({ page, bundle, base: "//evil" })).toThrow("safe absolute path");
  expect(() => createPublicationRenderContextV1({ page, bundle: { ...bundle, routes: [bundle.routes[0], { ...bundle.routes[1], route: "/../escape/" }] } as PublicationBundleV1 })).toThrow("route is not safe");
  expect(() => createPublicationRenderContextV1({ page, bundle: { ...bundle, assets: [{ ...bundle.assets[0], path: "../secret" }] } as PublicationBundleV1 })).toThrow("asset path is not safe");
});

test("does not turn unsafe external references into clickable links", () => {
  const unsafePage = { ...page, links: [{ referenceId: "bad", kind: "external" as const, href: "javascript:alert(1)" }] };
  const context = createPublicationRenderContextV1({ page: unsafePage, bundle });
  expect(context.links.bad).toEqual({ kind: "unresolved", href: "#" });
});

test("marks stale page-local anchor links unresolved", () => {
  const anchor = { kind: "anchor" as const, anchor: "missing-top" };
  const context = createPublicationRenderContextV1({
    page: {
      ...page,
      blocks: [{ type: "paragraph", content: [{ type: "link", target: anchor, content: [{ type: "text", text: "Back" }] }] }],
    },
    bundle,
  });
  expect(context.links[astroExportLinkKeyV1(anchor)]).toEqual({ kind: "unresolved", href: "#" });
});
