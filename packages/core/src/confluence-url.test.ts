import { describe, expect, test } from "bun:test";
import {
  buildConfluenceUrl,
  decodeTinyLink,
  getConfluenceBaseUrl,
  isConfluencePageUrl,
  parseConfluencePageRef,
  resolveDeploymentType,
} from "./confluence-url.js";
import type { Profile } from "./config.js";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: "test",
    baseUrl: "https://example.atlassian.net",
    deploymentType: "cloud",
    auth: { type: "apiToken", email: "test@example.com", token: "token" },
    ...overrides,
  };
}

describe("Confluence URL handling", () => {
  test("Cloud profiles append /wiki", () => {
    const value = profile();
    expect(getConfluenceBaseUrl(value)).toBe("https://example.atlassian.net/wiki");
    expect(buildConfluenceUrl(value, "/rest/api/content/123")).toBe(
      "https://example.atlassian.net/wiki/rest/api/content/123"
    );
  });

  test("Cloud profiles do not duplicate an existing /wiki path", () => {
    const value = profile({ baseUrl: "https://example.atlassian.net/wiki/" });
    expect(getConfluenceBaseUrl(value)).toBe("https://example.atlassian.net/wiki");
  });

  test("Data Center supports a root deployment", () => {
    const value = profile({
      baseUrl: "https://confluence.example.com/",
      deploymentType: "data-center",
      auth: { type: "bearer", pat: "token" },
    });
    expect(getConfluenceBaseUrl(value)).toBe("https://confluence.example.com");
    expect(buildConfluenceUrl(value, "rest/api/content/123")).toBe(
      "https://confluence.example.com/rest/api/content/123"
    );
  });

  test("Data Center preserves arbitrary context paths, including /wiki", () => {
    for (const contextPath of ["confluence", "wiki", "internal/docs"]) {
      const value = profile({
        baseUrl: `https://confluence.example.com/${contextPath}/`,
        deploymentType: "data-center",
        auth: { type: "bearer", pat: "token" },
      });
      expect(getConfluenceBaseUrl(value)).toBe(`https://confluence.example.com/${contextPath}`);
    }
  });

  test("legacy bearer profiles resolve as Data Center, including at the root", () => {
    const value = profile({
      baseUrl: "https://confluence.example.com",
      deploymentType: undefined,
      auth: { type: "bearer", pat: "token" },
    });
    expect(resolveDeploymentType(value)).toBe("data-center");
    expect(getConfluenceBaseUrl(value)).toBe("https://confluence.example.com");
  });

  test("legacy API-token profiles preserve context-path detection", () => {
    const value = profile({
      baseUrl: "https://confluence.example.com/confluence",
      deploymentType: undefined,
    });
    expect(resolveDeploymentType(value)).toBe("data-center");
  });

  test("session profiles without an explicit deploymentType default to Cloud", () => {
    const value = profile({
      baseUrl: "https://example.atlassian.net",
      deploymentType: undefined,
      auth: { type: "session" },
    });
    expect(resolveDeploymentType(value)).toBe("cloud");
    expect(getConfluenceBaseUrl(value)).toBe("https://example.atlassian.net/wiki");
  });

  test("session profiles default to Cloud even when the base URL carries a path", () => {
    const value = profile({
      baseUrl: "https://confluence.example.com/confluence",
      deploymentType: undefined,
      auth: { type: "session" },
    });
    expect(resolveDeploymentType(value)).toBe("cloud");
  });

  test("session profiles honor an explicit Data Center deploymentType", () => {
    const value = profile({
      baseUrl: "https://confluence.example.com/confluence",
      deploymentType: "data-center",
      auth: { type: "session" },
    });
    expect(resolveDeploymentType(value)).toBe("data-center");
  });

  test("identifies Cloud and Data Center page URLs for a profile", () => {
    const cloud = profile();
    const dataCenter = profile({
      baseUrl: "https://confluence.example.com/confluence",
      deploymentType: "data-center",
      auth: { type: "bearer", pat: "token" },
    });

    expect(isConfluencePageUrl(cloud, "https://example.atlassian.net/wiki/spaces/DOC/pages/123")).toBe(true);
    expect(isConfluencePageUrl(dataCenter, "https://confluence.example.com/confluence/display/DOC/Page")).toBe(true);
    expect(isConfluencePageUrl(dataCenter, "https://confluence.example.com/confluence/browse/DOC-1")).toBe(false);
    expect(isConfluencePageUrl(dataCenter, "https://other.example.com/confluence/spaces/DOC/pages/123")).toBe(false);
  });
});

describe("parseConfluencePageRef", () => {
  const cloud = "https://acme.atlassian.net/wiki";
  const dc = "https://confluence.example.com/confluence";

  test("a page id stays a page id", () => {
    expect(parseConfluencePageRef(cloud, " 10001 ")).toEqual({ pageId: "10001" });
  });

  test("page URLs of the site give the page id, Cloud and Data Center", () => {
    expect(parseConfluencePageRef(cloud, "https://acme.atlassian.net/wiki/spaces/DOCS/pages/10001/Design+Review")).toEqual({ pageId: "10001" });
    expect(parseConfluencePageRef(dc, "https://confluence.example.com/confluence/pages/viewpage.action?pageId=10002")).toEqual({ pageId: "10002" });
  });

  test("focusedCommentId names the comment the link points at", () => {
    expect(parseConfluencePageRef(cloud, "https://acme.atlassian.net/wiki/spaces/DOCS/pages/10001/Design+Review?focusedCommentId=20001#comment-20001")).toEqual({
      pageId: "10001",
      commentId: "20001",
    });
    expect(parseConfluencePageRef(cloud, "https://acme.atlassian.net/wiki/spaces/DOCS/pages/10001?focusedCommentId=abc")).toEqual({ pageId: "10001" });
  });

  test("a tiny link decodes to its page id", () => {
    // 1463517228 = 0x573B802C, little-endian 2C 80 3B 57.
    expect(decodeTinyLink("LIA7Vw")).toBe("1463517228");
    expect(decodeTinyLink("AQ")).toBe("1");
    expect(decodeTinyLink("not a code")).toBeUndefined();
    expect(parseConfluencePageRef(cloud, "https://acme.atlassian.net/wiki/x/LIA7Vw")).toEqual({ pageId: "1463517228" });
  });

  test("a URL of another site is refused, never read as an id of this one", () => {
    const other = parseConfluencePageRef(cloud, "https://other.atlassian.net/wiki/spaces/DOCS/pages/10001/Design+Review");
    expect(other).toEqual({ error: expect.stringContaining("Not on this profile's Confluence site") });
    // The profile's Jira lives on the same origin but outside the Confluence root.
    expect(parseConfluencePageRef(cloud, "https://acme.atlassian.net/browse/DOCS-1")).toHaveProperty("error");
  });

  test("a URL without a page id, or no URL at all, says so", () => {
    expect(parseConfluencePageRef(dc, "https://confluence.example.com/confluence/display/DOCS/Design+Review")).toEqual({ error: expect.stringContaining("no page id") });
    expect(parseConfluencePageRef(cloud, "https://acme.atlassian.net/wiki/spaces/DOCS")).toHaveProperty("error");
    expect(parseConfluencePageRef(cloud, "Design Review")).toEqual({ error: expect.stringContaining("neither a page id nor a page URL") });
    expect(parseConfluencePageRef(cloud, "javascript:alert(1)")).toHaveProperty("error");
  });
});
