import { describe, expect, test } from "bun:test";
import {
  buildConfluenceUrl,
  getConfluenceBaseUrl,
  isConfluencePageUrl,
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
