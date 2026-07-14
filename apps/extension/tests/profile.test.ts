import { describe, expect, it } from "bun:test";
import {
  isAtlassianCloudHost,
  isAtlassianCloudUrl,
  profileFromTabUrl,
} from "../utils/profile.js";

describe("isAtlassianCloudHost", () => {
  it("accepts a site subdomain of atlassian.net", () => {
    expect(isAtlassianCloudHost("mayflower.atlassian.net")).toBe(true);
    expect(isAtlassianCloudHost("my-co.atlassian.net")).toBe(true);
  });

  it("rejects the bare apex and look-alikes", () => {
    expect(isAtlassianCloudHost("atlassian.net")).toBe(false);
    expect(isAtlassianCloudHost("atlassian.net.evil.com")).toBe(false);
    expect(isAtlassianCloudHost("notatlassian.net")).toBe(false);
    expect(isAtlassianCloudHost("example.com")).toBe(false);
  });
});

describe("isAtlassianCloudUrl (shared origin gate — finding #3)", () => {
  it("accepts well-formed http(s) URLs on an Atlassian Cloud host", () => {
    expect(isAtlassianCloudUrl("https://mayflower.atlassian.net/wiki/spaces/D/pages/1")).toBe(true);
    expect(isAtlassianCloudUrl("https://x.atlassian.net/browse/ATLCLI-1")).toBe(true);
  });

  it("rejects foreign origins that merely LOOK Atlassian, and malformed URLs", () => {
    // Same gate profileFromTabUrl uses, so detection + profile stay consistent.
    expect(isAtlassianCloudUrl("https://evil-atlassian.net/wiki/spaces/D/pages/123/A")).toBe(false);
    expect(isAtlassianCloudUrl("https://atlassian.net.evil.com/wiki/spaces/D/pages/1")).toBe(false);
    expect(isAtlassianCloudUrl("https://example.com/wiki/spaces/D/pages/1")).toBe(false);
    expect(isAtlassianCloudUrl("chrome://extensions")).toBe(false);
    expect(isAtlassianCloudUrl("not a url")).toBe(false);
  });
});

describe("profileFromTabUrl", () => {
  it("builds a session profile from an Atlassian Cloud page URL", () => {
    const profile = profileFromTabUrl(
      "https://mayflower.atlassian.net/wiki/spaces/DOCSY/pages/12345/Home"
    );
    expect(profile).toEqual({
      name: "session",
      baseUrl: "https://mayflower.atlassian.net",
      deploymentType: "cloud",
      auth: { type: "session" },
    });
  });

  it("uses the origin only (drops path/query/hash)", () => {
    const profile = profileFromTabUrl(
      "https://x.atlassian.net/wiki/spaces/D/pages/9/T?foo=bar#frag"
    );
    expect(profile?.baseUrl).toBe("https://x.atlassian.net");
  });

  it("returns a session profile for any Atlassian origin (incl. Jira tabs)", () => {
    // The profile is origin-scoped; whether the entity is exportable is decided
    // by the extractor, not here.
    expect(profileFromTabUrl("https://x.atlassian.net/browse/ATLCLI-1")?.auth.type).toBe(
      "session"
    );
  });

  it("returns null for non-Atlassian origins", () => {
    expect(profileFromTabUrl("https://example.com/wiki/spaces/D/pages/1")).toBeNull();
    expect(profileFromTabUrl("https://atlassian.net.evil.com/x")).toBeNull();
  });

  it("returns null for malformed or non-http(s) URLs", () => {
    expect(profileFromTabUrl("not a url")).toBeNull();
    expect(profileFromTabUrl("chrome://extensions")).toBeNull();
    expect(profileFromTabUrl("file:///etc/passwd")).toBeNull();
  });
});
