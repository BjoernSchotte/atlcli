import { describe, expect, test } from "bun:test";
import {
  PublicationReferencePlanningErrorV1,
  normalizePublicationAnchorReferenceV1,
  planPublicationReferencesV1,
} from "./index.js";

const assets = [{
  assetId: "diagram",
  path: "assets/diagram.svg",
  sha256: "a".repeat(64),
  byteLength: 12,
  mediaType: "image/svg+xml",
  disposition: "inline" as const,
}];

function plan(overrides: Partial<Parameters<typeof planPublicationReferencesV1>[0]> = {}) {
  return planPublicationReferencesV1({
    pages: [{
      sourceId: "guide",
      route: "/guide/",
      blocks: [
        { type: "heading", level: 1, content: [{ type: "text", text: "Overview" }] },
        { type: "heading", level: 2, content: [{ type: "text", text: "Overview" }] },
        { type: "anchor", name: "Customer Notes" },
        {
          type: "heading",
          level: 2,
          explicitAnchor: "API Details",
          content: [
            { type: "text", text: "API " },
            { type: "link", target: { kind: "external", href: "https://example.test" }, content: [{ type: "text", text: "details" }] },
          ],
        },
      ],
      links: [
        { referenceId: "self", kind: "page", sourceId: "guide", anchorId: "Customer Notes" },
        { referenceId: "asset", kind: "asset", assetId: "diagram" },
        { referenceId: "external", kind: "external", href: "https://example.test/docs" },
      ],
      assetIds: ["diagram"],
    }],
    assets,
    ...overrides,
  });
}

function expectError(run: () => unknown, code: PublicationReferencePlanningErrorV1["code"]): void {
  expect(run).toThrow(PublicationReferencePlanningErrorV1);
  try {
    run();
  } catch (error) {
    expect((error as PublicationReferencePlanningErrorV1).code).toBe(code);
  }
}

describe("publication page references", () => {
  test("creates stable, page-local, deduplicated anchors and logical references", () => {
    const result = plan();
    expect(result.pages).toEqual([{
      sourceId: "guide",
      route: "/guide/",
      anchors: [
        { anchorId: "overview", kind: "heading", level: 1, text: "Overview" },
        { anchorId: "overview-2", kind: "heading", level: 2, text: "Overview" },
        { anchorId: "customer-notes", sourceAnchor: "customer-notes", kind: "bookmark" },
        { anchorId: "api-details", sourceAnchor: "api-details", kind: "heading", level: 2, text: "API details" },
      ],
      links: [
        {
          referenceId: "self",
          target: { kind: "page", sourceId: "guide", route: "/guide/", anchorId: "customer-notes" },
        },
        {
          referenceId: "asset",
          target: { kind: "asset", assetId: "diagram", path: "assets/diagram.svg" },
        },
        {
          referenceId: "external",
          target: { kind: "external", href: "https://example.test/docs" },
        },
      ],
      assets: assets,
    }]);
  });

  test("does not bake Astro base or output profile into typed internal references", () => {
    const result = plan({
      pages: [
        {
          sourceId: "guide",
          route: "/docs/guide/",
          blocks: [],
          links: [{ referenceId: "next", kind: "page", sourceId: "next" }],
          assetIds: [],
        },
        {
          sourceId: "next",
          route: "/docs/next/",
          blocks: [],
          links: [],
          assetIds: [],
        },
      ],
      assets: [],
    });
    expect(result.pages[0]?.links).toEqual([{
      referenceId: "next",
      target: { kind: "page", sourceId: "next", route: "/docs/next/" },
    }]);
  });

  test("canonicalizes only bounded plain fragment names", () => {
    expect(normalizePublicationAnchorReferenceV1("  Crème  brûlée ")).toBe("creme-brulee");
    expectError(() => normalizePublicationAnchorReferenceV1("../private"), "unsafe-anchor");
    expectError(() => normalizePublicationAnchorReferenceV1("#fragment"), "unsafe-anchor");
  });

  test("fails before build for ambiguous or dangling internal references", () => {
    expectError(() => plan({
      pages: [{ sourceId: "guide", route: "/guide/", blocks: [{ type: "anchor", name: "same" }, { type: "anchor", name: "Same" }], links: [], assetIds: [] }],
      assets: [],
    }), "duplicate-anchor");
    expectError(() => plan({
      pages: [{ sourceId: "guide", route: "/guide/", blocks: [], links: [{ referenceId: "missing", kind: "page", sourceId: "missing" }], assetIds: [] }],
      assets: [],
    }), "dangling-page-reference");
    expectError(() => plan({
      pages: [{ sourceId: "guide", route: "/guide/", blocks: [], links: [{ referenceId: "missing", kind: "asset", assetId: "missing" }], assetIds: [] }],
      assets: [],
    }), "dangling-asset-reference");
    expectError(() => plan({
      pages: [{ sourceId: "guide", route: "/guide/", blocks: [], links: [{ referenceId: "bad", kind: "external", href: "javascript:alert(1)" }], assetIds: [] }],
      assets: [],
    }), "unsafe-external-link");
  });
});
