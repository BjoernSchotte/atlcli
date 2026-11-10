import { describe, expect, it } from "bun:test";
import {
  isAtlassianCloudHost,
  isAtlassianCloudOrigin,
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

describe("isAtlassianCloudHost label rules", () => {
  it("rejects labels with a leading or trailing hyphen, and nested subdomains", () => {
    expect(isAtlassianCloudHost("-tenant.atlassian.net")).toBe(false);
    expect(isAtlassianCloudHost("tenant-.atlassian.net")).toBe(false);
    expect(isAtlassianCloudHost("-.atlassian.net")).toBe(false);
    expect(isAtlassianCloudHost("a.b.atlassian.net")).toBe(false);
    expect(isAtlassianCloudHost(".atlassian.net")).toBe(false);
    expect(isAtlassianCloudHost("tenant.atlassian.net.")).toBe(false);
    expect(isAtlassianCloudHost("a.atlassian.net")).toBe(true);
    expect(isAtlassianCloudHost("TENANT-1.Atlassian.NET")).toBe(true);
  });
});

describe("isAtlassianCloudOrigin (the one site gate)", () => {
  it("accepts exactly the serialized https origin of a site", () => {
    expect(isAtlassianCloudOrigin("https://tenant-a.atlassian.net")).toBe(true);
  });

  it("rejects http, ports, paths, look-alikes and non-origins", () => {
    for (const origin of [
      "http://tenant-a.atlassian.net",
      "https://tenant-a.atlassian.net:8443",
      "https://tenant-a.atlassian.net:443",
      "https://tenant-a.atlassian.net/",
      "https://tenant-a.atlassian.net/wiki",
      "https://user@tenant-a.atlassian.net",
      "https://TENANT-A.atlassian.net",
      "https://atlassian.net",
      "https://evil-atlassian.net",
      "https://tenant-a.atlassian.net.evil.example",
      "https://-tenant.atlassian.net",
      "wss://tenant-a.atlassian.net",
      "chrome-extension://tenant-a.atlassian.net",
      "tenant-a.atlassian.net",
      "null",
      "",
    ]) {
      expect(isAtlassianCloudOrigin(origin), origin).toBe(false);
    }
  });
});

describe("isAtlassianCloudUrl (shared origin gate — finding #3)", () => {
  it("is https-only and port-free, like every other gate", () => {
    expect(isAtlassianCloudUrl("http://tenant-a.atlassian.net/wiki/spaces/D/pages/1")).toBe(false);
    expect(isAtlassianCloudUrl("https://tenant-a.atlassian.net:8443/wiki")).toBe(false);
    expect(isAtlassianCloudUrl("https://tenant-.atlassian.net/wiki")).toBe(false);
    expect(isAtlassianCloudUrl("https://user:pw@tenant-a.atlassian.net/wiki")).toBe(true);
    expect(profileFromTabUrl("http://tenant-a.atlassian.net/wiki")).toBeNull();
  });


  it("accepts well-formed http(s) URLs on an Atlassian Cloud host", () => {
    expect(isAtlassianCloudUrl("https://tenant-a.atlassian.net/wiki/spaces/D/pages/1")).toBe(true);
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
      "https://tenant-a.atlassian.net/wiki/spaces/DOCSY/pages/12345/Home"
    );
    expect(profile).toEqual({
      name: "session",
      baseUrl: "https://tenant-a.atlassian.net",
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
