import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolveToken, buildAuthHeader, getKeychainService } from "./auth.js";
import type { Profile } from "./config.js";

function createApiTokenProfile(overrides: Partial<Profile["auth"]> = {}): Profile {
  return {
    name: "test",
    baseUrl: "https://test.atlassian.net",
    auth: {
      type: "apiToken",
      email: "user@example.com",
      token: "test-api-token",
      ...overrides,
    },
  };
}

function createBearerProfile(overrides: Partial<Profile["auth"]> = {}): Profile {
  return {
    name: "test-server",
    baseUrl: "https://jira.company.com",
    auth: {
      type: "bearer",
      username: "testuser",
      pat: "test-pat-token",
      ...overrides,
    },
  };
}

describe("auth", () => {
  describe("getKeychainService", () => {
    test("returns atlcli", () => {
      expect(getKeychainService()).toBe("atlcli");
    });
  });

  describe("resolveToken", () => {
    const originalEnv = process.env.ATLCLI_API_TOKEN;

    beforeEach(() => {
      delete process.env.ATLCLI_API_TOKEN;
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.ATLCLI_API_TOKEN = originalEnv;
      } else {
        delete process.env.ATLCLI_API_TOKEN;
      }
    });

    test("returns env token for apiToken profile", () => {
      process.env.ATLCLI_API_TOKEN = "env-token";
      const profile = createApiTokenProfile();
      expect(resolveToken(profile)).toBe("env-token");
    });

    test("returns env token for bearer profile", () => {
      process.env.ATLCLI_API_TOKEN = "env-token";
      const profile = createBearerProfile();
      expect(resolveToken(profile)).toBe("env-token");
    });

    test("returns config token for apiToken profile when no env token", () => {
      const profile = createApiTokenProfile({ token: "config-token" });
      expect(resolveToken(profile)).toBe("config-token");
    });

    test("returns config pat for bearer profile when no env token", () => {
      const profile = createBearerProfile({ pat: "config-pat" });
      expect(resolveToken(profile)).toBe("config-pat");
    });

    test("returns null when no token found for apiToken profile", () => {
      const profile = createApiTokenProfile({ token: undefined });
      expect(resolveToken(profile)).toBeNull();
    });

    test("returns null when no token found for bearer profile", () => {
      const profile = createBearerProfile({ pat: undefined, username: undefined });
      expect(resolveToken(profile)).toBeNull();
    });

    test("env token takes priority over config token", () => {
      process.env.ATLCLI_API_TOKEN = "env-token";
      const profile = createApiTokenProfile({ token: "config-token" });
      expect(resolveToken(profile)).toBe("env-token");
    });
  });

  describe("buildAuthHeader", () => {
    const originalEnv = process.env.ATLCLI_API_TOKEN;

    beforeEach(() => {
      delete process.env.ATLCLI_API_TOKEN;
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.ATLCLI_API_TOKEN = originalEnv;
      } else {
        delete process.env.ATLCLI_API_TOKEN;
      }
    });

    test("builds Basic header for apiToken profile", () => {
      const profile = createApiTokenProfile({
        email: "user@example.com",
        token: "my-api-token",
      });
      const header = buildAuthHeader(profile);
      // Basic auth: base64(email:token)
      const expected = "Basic " + Buffer.from("user@example.com:my-api-token").toString("base64");
      expect(header).toBe(expected);
    });

    test("builds Bearer header for bearer profile", () => {
      const profile = createBearerProfile({ pat: "my-pat-token" });
      const header = buildAuthHeader(profile);
      expect(header).toBe("Bearer my-pat-token");
    });

    test("uses env token for Basic auth", () => {
      process.env.ATLCLI_API_TOKEN = "env-token";
      const profile = createApiTokenProfile({ email: "user@example.com" });
      const header = buildAuthHeader(profile);
      const expected = "Basic " + Buffer.from("user@example.com:env-token").toString("base64");
      expect(header).toBe(expected);
    });

    test("uses env token for Bearer auth", () => {
      process.env.ATLCLI_API_TOKEN = "env-pat";
      const profile = createBearerProfile();
      const header = buildAuthHeader(profile);
      expect(header).toBe("Bearer env-pat");
    });

    test("throws when no token found", () => {
      const profile = createApiTokenProfile({ token: undefined });
      expect(() => buildAuthHeader(profile)).toThrow("No token found");
    });

    test("throws with helpful message when no token found", () => {
      const profile = createBearerProfile({ pat: undefined, username: undefined });
      expect(() => buildAuthHeader(profile)).toThrow(/ATLCLI_API_TOKEN/);
    });
  });
});
