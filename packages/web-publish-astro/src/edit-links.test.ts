import { expect, test } from "bun:test";
import { resolveConfluenceEditLinkV1 } from "./edit-links.js";

const base = { sourceId: "page-1", trustedOrigin: "https://tenant.atlassian.net", label: "Open in Confluence", fallback: "open-page" as const, visibility: "all" as const, publicationVisibility: "public" as const, publicTenantDisclosureAcknowledged: true as const };

test("accepts only provider-returned same-origin edit relations", () => {
  expect(resolveConfluenceEditLinkV1({ ...base, relation: { sourceId: "page-1", editui: "https://tenant.atlassian.net/wiki/pages/editpage.action?pageId=1", webui: "https://tenant.atlassian.net/wiki/spaces/DOCSY/pages/1" } })).toMatchObject({ sourceId: "page-1", href: "https://tenant.atlassian.net/wiki/pages/editpage.action?pageId=1" });
  expect(resolveConfluenceEditLinkV1({ ...base, relation: { sourceId: "page-1", webui: "https://tenant.atlassian.net/wiki/spaces/DOCSY/pages/1" } })).toMatchObject({ href: "https://tenant.atlassian.net/wiki/spaces/DOCSY/pages/1" });
  expect(resolveConfluenceEditLinkV1({ ...base, relation: { sourceId: "page-1", editui: "https://evil.example.test/edit" } })).toBeUndefined();
});

test("does not synthesize missing relations or leak public tenant links without acknowledgement", () => {
  expect(resolveConfluenceEditLinkV1({ ...base, relation: { sourceId: "page-1" } })).toBeUndefined();
  expect(() => resolveConfluenceEditLinkV1({ ...base, publicTenantDisclosureAcknowledged: undefined, relation: { sourceId: "page-1", editui: "https://tenant.atlassian.net/wiki/pages/editpage.action?pageId=1" } })).toThrow("tenant disclosure");
  expect(resolveConfluenceEditLinkV1({ ...base, visibility: "internal", relation: { sourceId: "page-1", editui: "https://tenant.atlassian.net/wiki/pages/editpage.action?pageId=1" } })).toBeUndefined();
});
