/**
 * Spec 005 — includepage + metadata placeholder conformance fixtures (case 005
 * `placeholders`). DOCX-only: placeholders are a `.docx` template feature.
 *
 * A real `.docx` template (built with `@atlcli/docx/fixtures.buildDocx`) carries
 * a `$scroll.title` metadata placeholder, an unsupported `$scroll.metadata.*`
 * placeholder, and two atomic `$scroll.includepage` paragraphs — one resolvable
 * ("Imprint"), one self-referential (the export root's own title, to trigger
 * cycle protection). The harness case feeds these bytes to the REAL
 * `runExport` with an in-memory `getIncludedPage` port built via the production
 * `buildGetIncludedPage` (fed plain closures over fixture pages — the pattern
 * from `packages/docx/src/include-lookup.test.ts`, no mocks).
 *
 * Contract proven: the resolved DOCX contains the included page's text and the
 * resolved title, and the report carries an `includepage-cycle` note (self
 * include) and a `placeholder-unsupported` note (`$scroll.metadata.*`).
 */
import type { ConfluencePageDetails } from "@atlcli/confluence/browser";
import { buildDocx, para, stylesXml } from "@atlcli/docx/fixtures";
import {
  buildGetIncludedPage,
  type IncludeLookupIo,
  type IncludeLookupOutcome,
  type IncludePageRef,
} from "@atlcli/docx/internal";

/** The page being exported; also the self-include target that must be a cycle. */
export const PLACEHOLDER_ROOT_DETAILS: ConfluencePageDetails = {
  id: "placeholder-root",
  title: "Placeholders Home",
  url: "https://example.invalid/wiki/spaces/TEST/pages/placeholder-root",
  version: 1,
  spaceKey: "TEST",
  storage: "<p>Root body.</p>",
  created: "2026-07-17T08:00:00.000Z",
  modified: "2026-07-17T08:00:00.000Z",
  createdBy: { displayName: "Harness Author" },
  modifiedBy: { displayName: "Harness Author" },
  labels: [],
};

/** The resolvable included page. */
export const PLACEHOLDER_INCLUDED_DETAILS: ConfluencePageDetails = {
  id: "500",
  title: "Imprint",
  url: "https://example.invalid/wiki/spaces/TEST/pages/500",
  version: 1,
  spaceKey: "TEST",
  storage: "<p>Imprint body text.</p>",
  created: "2026-07-17T08:00:00.000Z",
  modified: "2026-07-17T08:00:00.000Z",
  createdBy: { displayName: "Harness Author" },
  modifiedBy: { displayName: "Harness Author" },
  labels: [],
};

const PLACEHOLDER_PAGES: Record<string, ConfluencePageDetails> = {
  [PLACEHOLDER_ROOT_DETAILS.id]: PLACEHOLDER_ROOT_DETAILS,
  [PLACEHOLDER_INCLUDED_DETAILS.id]: PLACEHOLDER_INCLUDED_DETAILS,
};

/** The host primitive bag `buildGetIncludedPage` wraps — pure closures over fixtures. */
export function placeholderIncludeIo(): IncludeLookupIo {
  return {
    defaultSpaceKey: "TEST",
    async getPage(id: string): Promise<ConfluencePageDetails> {
      const page = PLACEHOLDER_PAGES[id];
      if (!page) throw new Error("Confluence API error (404)");
      return page;
    },
    async findPagesByTitle(title: string, spaceKey?: string): Promise<Array<{ id: string }>> {
      return Object.values(PLACEHOLDER_PAGES)
        .filter((p) => p.title === title && (spaceKey === undefined || p.spaceKey === spaceKey))
        .map((p) => ({ id: p.id }));
    },
  };
}

/** The production `getIncludedPage` port over the in-memory fixtures. */
export function placeholderGetIncludedPage(): (ref: IncludePageRef) => Promise<IncludeLookupOutcome> {
  return buildGetIncludedPage(placeholderIncludeIo());
}

/**
 * A `.docx` template with:
 *   - `$scroll.title` (supported metadata → the root title),
 *   - `$scroll.metadata.status` (unsupported → empty + `placeholder-unsupported`),
 *   - an atomic resolvable includepage ("Imprint"),
 *   - an atomic self-include (the root's own title → `includepage-cycle`),
 *   - the `$scroll.content` insertion point.
 * `date` pins the DOS timestamps so the template bytes are byte-reproducible.
 */
export const PLACEHOLDER_TEMPLATE_BYTES: Uint8Array = buildDocx({
  body:
    para("$scroll.title") +
    para("$scroll.metadata.status") +
    para('$scroll.includepage.("Imprint")') +
    para('$scroll.includepage.("Placeholders Home")') +
    para("$scroll.content"),
  styles: stylesXml(),
  date: new Date("2026-07-17T08:00:00.000Z"),
});
