import { describe, test, expect } from "bun:test";
import { Buffer } from "node:buffer";
import { buildAuthHeader, encodeBase64, decodeBase64, type TokenResolver } from "./auth.js";
import type { Profile } from "./types.js";

function apiTokenProfile(overrides: Partial<Profile["auth"]> = {}): Profile {
  return {
    name: "test",
    baseUrl: "https://test.atlassian.net",
    auth: { type: "apiToken", email: "user@example.com", token: "t", ...overrides },
  };
}

function bearerProfile(overrides: Partial<Profile["auth"]> = {}): Profile {
  return {
    name: "srv",
    baseUrl: "https://jira.company.com",
    auth: { type: "bearer", pat: "p", ...overrides },
  };
}

const yes: TokenResolver = () => "resolved-token";
const no: TokenResolver = () => null;

describe("encodeBase64", () => {
  test("matches Buffer for ASCII input", () => {
    const s = "user@example.com:my-api-token";
    expect(encodeBase64(s)).toBe(Buffer.from(s, "utf8").toString("base64"));
  });

  test("matches Buffer byte-for-byte for a non-ASCII (umlaut) e-mail", () => {
    const s = "björn@example.de:s3cr3t";
    expect(encodeBase64(s)).toBe(Buffer.from(s, "utf8").toString("base64"));
  });

  test("handles empty string", () => {
    expect(encodeBase64("")).toBe(Buffer.from("", "utf8").toString("base64"));
  });

  test("does not throw on high code points where btoa alone would", () => {
    const s = "grüße:😀";
    expect(() => encodeBase64(s)).not.toThrow();
    expect(encodeBase64(s)).toBe(Buffer.from(s, "utf8").toString("base64"));
  });
});

describe("decodeBase64 (browser-safe, used for unknown-macro preservation)", () => {
  test("matches the node-only Buffer decode byte-for-byte (ASCII + non-ASCII)", () => {
    for (const s of ["hello world", "grüße:😀", "<macro>你好 — €</macro>", ""]) {
      const encoded = Buffer.from(s, "utf8").toString("base64");
      expect(decodeBase64(encoded)).toBe(Buffer.from(encoded, "base64").toString("utf-8"));
      expect(decodeBase64(encoded)).toBe(s);
    }
  });

  test("is the exact inverse of encodeBase64", () => {
    const s = "grüße:😀 <ac:structured-macro/>";
    expect(decodeBase64(encodeBase64(s))).toBe(s);
  });
});

describe("buildAuthHeader (core, injected resolver)", () => {
  test("requires an explicit resolver for non-session browser use", () => {
    expect(() => buildAuthHeader(bearerProfile())).toThrow(/token resolver/i);
  });

  test("bearer → Bearer <token>", () => {
    expect(buildAuthHeader(bearerProfile(), yes)).toBe("Bearer resolved-token");
  });

  test("apiToken → Basic base64(email:token), umlaut-safe", () => {
    const profile = apiTokenProfile({ email: "björn@example.de" });
    const header = buildAuthHeader(profile, yes);
    const expected = "Basic " + Buffer.from("björn@example.de:resolved-token", "utf8").toString("base64");
    expect(header).toBe(expected);
  });

  test("throws when the resolver yields no token, naming the profile", () => {
    expect(() => buildAuthHeader(apiTokenProfile(), no)).toThrow(/No token resolved for profile 'test'/);
  });

  test("throws a non-keychain-flavored message when no token resolved", () => {
    // Browser-safe: must not mention keychain/config file (spec 001 §2.4).
    let msg = "";
    try {
      buildAuthHeader(apiTokenProfile(), no);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toMatch(/keychain/i);
    expect(msg).not.toMatch(/config file/i);
  });

  test("throws when email is missing for Basic auth", () => {
    const profile = apiTokenProfile({ email: undefined });
    expect(() => buildAuthHeader(profile, yes)).toThrow(/email/i);
  });
});
