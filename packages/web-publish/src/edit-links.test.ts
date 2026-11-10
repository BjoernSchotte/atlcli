import { expect, test } from "bun:test";
import {
  assertPublicationEditLinkBuildPolicyV1,
  planPublicationEditLinksV1,
  publicationEditLinkV1,
  resolveConfluenceEditLinkV1,
  trustedConfluenceEditUrlV1,
} from "./edit-links.js";

const origin = "https://confluence.example.test";
const editui = `${origin}/wiki/pages/resumedraft.action?draftId=1`;
const webui = `${origin}/wiki/spaces/DOCS/pages/1/Guide`;
const base = { trustedOrigin: origin, label: "Open in Confluence", fallback: "open-page" as const, visibility: "all" as const, publicationVisibility: "public" as const, publicTenantDisclosureAcknowledged: true as const };
const policy = { provider: "confluence", label: "Edit in Confluence", placement: "page-actions", visibility: "all", fallback: "open-page" } as const;

test("accepts only provider-returned same-origin edit relations", () => {
  expect(resolveConfluenceEditLinkV1({ ...base, relation: { sourceId: "page-1", editui, webui } })).toEqual({ sourceId: "page-1", href: editui, label: "Open in Confluence" });
  expect(resolveConfluenceEditLinkV1({ ...base, relation: { sourceId: "page-1", webui } })).toMatchObject({ href: webui });
  expect(resolveConfluenceEditLinkV1({ ...base, fallback: "omit", relation: { sourceId: "page-1", webui } })).toBeUndefined();
  expect(resolveConfluenceEditLinkV1({ ...base, relation: { sourceId: "page-1", editui: "https://evil.example.test/edit" } })).toBeUndefined();
});

test("does not synthesize missing relations or leak public tenant links without acknowledgement", () => {
  expect(resolveConfluenceEditLinkV1({ ...base, relation: { sourceId: "page-1" } })).toBeUndefined();
  expect(() => resolveConfluenceEditLinkV1({ ...base, publicTenantDisclosureAcknowledged: undefined, relation: { sourceId: "page-1", editui } })).toThrow("tenant disclosure");
  expect(resolveConfluenceEditLinkV1({ ...base, visibility: "internal", relation: { sourceId: "page-1", editui } })).toBeUndefined();
});

test("the trusted-origin filter rejects everything but a plain https page URL on the origin", () => {
  expect(trustedConfluenceEditUrlV1(editui, origin)).toBe(editui);
  for (const rejected of [
    undefined,
    "not a url",
    "http://confluence.example.test/wiki/pages/1",
    "https://confluence.example.test.evil.test/wiki/pages/1",
    "https://user:secret@confluence.example.test/wiki/pages/1",
    `${origin}/wiki/pages/1#fragment`,
    `${origin}/wiki/pages/1?token=abc`,
    `${origin}/`,
    `${origin}/wiki/rest/api/content/1`,
    "javascript:alert(1)",
  ]) {
    expect(trustedConfluenceEditUrlV1(rejected, origin)).toBeUndefined();
  }
  expect(trustedConfluenceEditUrlV1(editui, "not an origin")).toBeUndefined();
});

test("a refresh freezes one trusted link per page under the project policy", () => {
  const relations = [
    { sourceId: "b", webui },
    { sourceId: "a", editui, webui },
    { sourceId: "c" },
    { sourceId: "d", editui: "https://evil.example.test/wiki/pages/9" },
  ];
  expect(planPublicationEditLinksV1({ project: { visibility: "internal", editLink: policy }, trustedOrigin: `${origin}/wiki`, relations })).toEqual({
    origin,
    label: "Edit in Confluence",
    placement: "page-actions",
    fallback: "open-page",
    links: [{ sourceId: "a", href: editui }, { sourceId: "b", href: webui }],
  });
  expect(planPublicationEditLinksV1({ project: { visibility: "internal", editLink: { ...policy, fallback: "omit" } }, trustedOrigin: origin, relations })?.links)
    .toEqual([{ sourceId: "a", href: editui }]);
  // Disabled, or internal-only links on a public site: no links and no tenant origin in the bundle.
  expect(planPublicationEditLinksV1({ project: { visibility: "internal", editLink: { provider: "none" } }, trustedOrigin: origin, relations })).toBeUndefined();
  expect(planPublicationEditLinksV1({ project: { visibility: "public", editLink: { ...policy, visibility: "internal" } }, trustedOrigin: origin, relations })).toBeUndefined();
  expect(() => planPublicationEditLinksV1({ project: { visibility: "public", editLink: policy }, trustedOrigin: origin, relations })).toThrow("tenant disclosure");
  expect(() => planPublicationEditLinksV1({ project: { visibility: "internal", editLink: policy }, trustedOrigin: "http://confluence.example.test", relations })).toThrow("https Confluence site");
});

test("a bundle builds only under the edit-link policy it was refreshed with", () => {
  const frozen = { origin, label: "Edit in Confluence", placement: "page-actions", fallback: "open-page", links: [] } as const;
  const enabled = { visibility: "internal", editLink: policy } as const;
  const disabled = { visibility: "internal", editLink: { provider: "none" } } as const;
  expect(() => assertPublicationEditLinkBuildPolicyV1(enabled, { editLinks: frozen })).not.toThrow();
  expect(() => assertPublicationEditLinkBuildPolicyV1(disabled, {})).not.toThrow();
  expect(() => assertPublicationEditLinkBuildPolicyV1({ visibility: "public", editLink: { ...policy, visibility: "internal" } }, {})).not.toThrow();
  for (const [project, bundle] of [
    [disabled, { editLinks: frozen }],
    [enabled, {}],
    [{ visibility: "public", editLink: { ...policy, visibility: "internal" } }, { editLinks: frozen }],
    [{ visibility: "internal", editLink: { ...policy, label: "Other" } }, { editLinks: frozen }],
    [{ visibility: "internal", editLink: { ...policy, placement: "page-footer" } }, { editLinks: frozen }],
    [{ visibility: "internal", editLink: { ...policy, fallback: "omit" } }, { editLinks: frozen }],
  ] as const) {
    expect(() => assertPublicationEditLinkBuildPolicyV1(project, bundle)).toThrow("different edit-link policy");
  }
});

test("a page template gets only the frozen link of its own page, re-checked against the origin", () => {
  const editLinks = { origin, label: "Edit in Confluence", placement: "page-footer", fallback: "omit", links: [{ sourceId: "a", href: editui }, { sourceId: "x", href: "https://evil.example.test/wiki/pages/1" }] } as const;
  expect(publicationEditLinkV1({ editLinks }, "a")).toEqual({ href: editui, label: "Edit in Confluence", placement: "page-footer" });
  expect(publicationEditLinkV1({ editLinks }, "b")).toBeUndefined();
  expect(publicationEditLinkV1({ editLinks }, "x")).toBeUndefined();
  expect(publicationEditLinkV1({}, "a")).toBeUndefined();
});
