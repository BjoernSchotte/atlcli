import { expect, test } from "bun:test";
import { planPublicationPrefetchLinksV1 } from "./prefetch.js";

test("plans only verified same-origin prefetch links", () => {
  expect(planPublicationPrefetchLinksV1({
    origin: "https://docs.example.test",
    verifiedRoutes: ["/docs/publish/guide/", "/docs/publish/next/"],
    hrefs: [
      "https://docs.example.test/docs/publish/guide/",
      "/docs/publish/next/",
      "https://evil.example.test/",
      "/docs/publish/missing/",
      "/docs/publish/guide/?private=1",
      "javascript:alert(1)",
    ],
  })).toEqual(["/docs/publish/guide/", "/docs/publish/next/"]);
});

test("rejects malformed or credentialed origin configuration", () => {
  expect(() => planPublicationPrefetchLinksV1({ origin: "https://user:pass@example.test", verifiedRoutes: [], hrefs: [] })).toThrow();
});
