import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildEphemeralProfile, engineDeprecationNotice } from "./export.js";

const ENV_KEYS = ["ATLCLI_BASE_URL", "ATLCLI_EMAIL", "ATLCLI_AUTH_TYPE", "ATLCLI_API_TOKEN"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("buildEphemeralProfile — fail-closed profile-free auth (spec 008 T3.4)", () => {
  it("returns null when no ephemeral field is supplied (use named profile)", () => {
    expect(buildEphemeralProfile({})).toBeNull();
  });

  it("builds an api-token Cloud profile from flags + ATLCLI_API_TOKEN", () => {
    process.env.ATLCLI_API_TOKEN = "tok";
    const profile = buildEphemeralProfile({ "base-url": "example.atlassian.net", email: "ci@x.io" });
    expect(profile).toMatchObject({
      name: "ephemeral",
      baseUrl: "https://example.atlassian.net",
      auth: { type: "apiToken", email: "ci@x.io", token: "tok" },
    });
  });

  it("builds a bearer Data Center profile without email", () => {
    process.env.ATLCLI_API_TOKEN = "pat";
    const profile = buildEphemeralProfile({ "base-url": "https://wiki.corp", "auth-type": "bearer", "allow-http": false as unknown as string });
    expect(profile).toMatchObject({
      deploymentType: "data-center",
      auth: { type: "bearer", pat: "pat" },
    });
  });

  it("rejects a partial ephemeral set (email but no base-url)", () => {
    process.env.ATLCLI_API_TOKEN = "tok";
    expect(() => buildEphemeralProfile({ email: "ci@x.io" })).toThrow(/--base-url/);
  });

  it("rejects ephemeral fields mixed with --profile", () => {
    process.env.ATLCLI_API_TOKEN = "tok";
    expect(() => buildEphemeralProfile({ "base-url": "x.atlassian.net", email: "a@b.c", profile: "work" })).toThrow(/--profile/);
  });

  it("requires ATLCLI_API_TOKEN", () => {
    expect(() => buildEphemeralProfile({ "base-url": "x.atlassian.net", email: "a@b.c" })).toThrow(/ATLCLI_API_TOKEN/);
  });

  it("requires email for api-token and forbids it for bearer", () => {
    process.env.ATLCLI_API_TOKEN = "tok";
    expect(() => buildEphemeralProfile({ "base-url": "x.atlassian.net" })).toThrow(/requires --email/);
    expect(() => buildEphemeralProfile({ "base-url": "x", "auth-type": "bearer", email: "a@b.c" })).toThrow(/does not take --email/);
  });

  it("rejects plain HTTP base-url unless --allow-http", () => {
    process.env.ATLCLI_API_TOKEN = "pat";
    expect(() => buildEphemeralProfile({ "base-url": "http://wiki.corp", "auth-type": "bearer" })).toThrow(/HTTPS/);
    const ok = buildEphemeralProfile({ "base-url": "http://wiki.corp", "auth-type": "bearer", "allow-http": true as unknown as string });
    expect(ok?.baseUrl).toBe("http://wiki.corp");
  });

  it("reads base-url/email/auth-type from environment variables", () => {
    process.env.ATLCLI_BASE_URL = "env.atlassian.net";
    process.env.ATLCLI_EMAIL = "env@x.io";
    process.env.ATLCLI_API_TOKEN = "tok";
    expect(buildEphemeralProfile({})).toMatchObject({
      baseUrl: "https://env.atlassian.net",
      auth: { email: "env@x.io" },
    });
  });
});

describe("engineDeprecationNotice (spec 008 T3.5)", () => {
  const base = {
    engine: "python",
    engineFlagPresent: false,
    json: false,
    stderrIsTTY: true,
    suppressed: false,
  };

  it("announces the upcoming default flip for an implicit python default on a TTY", () => {
    const notice = engineDeprecationNotice(base);
    expect(notice).toContain("future release");
    expect(notice).toContain("--engine python");
    expect(notice).toContain("ATLCLI_SUPPRESS_ENGINE_NOTICE");
  });

  it("stays silent when --engine was passed explicitly (either engine)", () => {
    expect(engineDeprecationNotice({ ...base, engineFlagPresent: true })).toBeNull();
    expect(engineDeprecationNotice({ ...base, engine: "ts", engineFlagPresent: true })).toBeNull();
  });

  it("stays silent for the ts engine, under --json, off-TTY, and when suppressed", () => {
    expect(engineDeprecationNotice({ ...base, engine: "ts" })).toBeNull();
    expect(engineDeprecationNotice({ ...base, json: true })).toBeNull();
    expect(engineDeprecationNotice({ ...base, stderrIsTTY: false })).toBeNull();
    expect(engineDeprecationNotice({ ...base, suppressed: true })).toBeNull();
  });
});
