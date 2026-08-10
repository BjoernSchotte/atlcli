import { describe, expect, test } from "bun:test";
import {
  createPageLinkResolver,
  type PageLinkCandidate,
  type PageLinkResolution,
} from "./page-link-resolution.js";
import type { LinkTarget } from "./index.js";

type PageTarget = Extract<LinkTarget, { kind: "page" }>;

const pages: readonly PageLinkCandidate[] = [
  { id: "1", title: "Home", spaceKey: "DOC" },
  { id: "2", title: "Guide", spaceKey: "DOC" },
  { id: "3", title: "Guide", spaceKey: "DOC" },
  { id: "4", title: "Guide", spaceKey: "OTHER" },
  { id: "5", title: "Unscoped" },
  { id: "6", title: "Case", spaceKey: "DOC" },
];

interface ResolutionCase {
  name: string;
  target: PageTarget;
  currentSpaceKey?: string;
  expected: PageLinkResolution;
}

describe("createPageLinkResolver", () => {
  const cases: readonly ResolutionCase[] = [
    {
      name: "resolves a matching contentId before title and space",
      target: {
        kind: "page",
        contentId: "4",
        contentTitle: "Wrong title",
        spaceKey: "WRONG",
      },
      expected: { kind: "resolved", targetId: "4" },
    },
    {
      name: "does not fall back to title when a non-empty contentId is missing",
      target: {
        kind: "page",
        contentId: "missing",
        contentTitle: "Home",
        spaceKey: "DOC",
      },
      expected: { kind: "out-of-scope" },
    },
    {
      name: "treats an empty contentId as absent and resolves by title",
      target: { kind: "page", contentId: "", contentTitle: "Home", spaceKey: "DOC" },
      expected: { kind: "resolved", targetId: "1" },
    },
    {
      name: "uses the target space before the current page space",
      target: { kind: "page", contentTitle: "Guide", spaceKey: "OTHER" },
      currentSpaceKey: "DOC",
      expected: { kind: "resolved", targetId: "4" },
    },
    {
      name: "falls back to the current page space",
      target: { kind: "page", contentTitle: "Home" },
      currentSpaceKey: "DOC",
      expected: { kind: "resolved", targetId: "1" },
    },
    {
      name: "reports duplicate exact titles in one space as ambiguous",
      target: { kind: "page", contentTitle: "Guide", spaceKey: "DOC" },
      expected: { kind: "ambiguous" },
    },
    {
      name: "does not title-resolve without a target or current space",
      target: { kind: "page", contentTitle: "Home" },
      expected: { kind: "out-of-scope" },
    },
    {
      name: "does not index pages that have no space",
      target: { kind: "page", contentTitle: "Unscoped" },
      expected: { kind: "out-of-scope" },
    },
    {
      name: "keeps empty target space authoritative over the current space",
      target: { kind: "page", contentTitle: "Home", spaceKey: "" },
      currentSpaceKey: "DOC",
      expected: { kind: "out-of-scope" },
    },
    {
      name: "matches space and title case-sensitively",
      target: { kind: "page", contentTitle: "case", spaceKey: "DOC" },
      expected: { kind: "out-of-scope" },
    },
    {
      name: "ignores anchors and hrefs while selecting the target page",
      target: {
        kind: "page",
        contentId: "1",
        contentTitle: "Home",
        anchor: "section",
        href: "https://wiki.example/pages/1",
      },
      expected: { kind: "resolved", targetId: "1" },
    },
  ];

  for (const resolutionCase of cases) {
    test(resolutionCase.name, () => {
      const resolver = createPageLinkResolver(pages);
      expect(
        resolver.resolve(resolutionCase.target, resolutionCase.currentSpaceKey),
      ).toEqual(resolutionCase.expected);
    });
  }

  test("preserves duplicate-ID Map semantics and exposes an immutable resolver", () => {
    const resolver = createPageLinkResolver([
      { id: "same", title: "First", spaceKey: "DOC" },
      { id: "same", title: "Last", spaceKey: "OTHER" },
    ]);

    expect(Object.isFrozen(resolver)).toBe(true);
    expect(resolver.resolve({
      kind: "page",
      contentId: "same",
      contentTitle: "Ignored",
    })).toEqual({ kind: "resolved", targetId: "same" });
  });
});
