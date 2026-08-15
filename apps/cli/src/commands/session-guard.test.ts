import { describe, test, expect, afterAll, beforeEach, mock } from "bun:test";

const utils = await import("../../../../packages/core/src/utils");
const { ERROR_CODES, getFlag, hasFlag } = utils;

// `mock.module` mutates the process-wide module registry, so without restoring
// it these stubs leak into every test file that runs after this one — silently
// replacing `@atlcli/core` with the handful of names stubbed below and making
// the real clients throw on construction. Capture the genuine modules first and
// put them back in `afterAll`.
const realCore = { ...(await import("@atlcli/core")) };
const realConfluence = { ...(await import("@atlcli/confluence")) };
const realJira = { ...(await import("@atlcli/jira")) };

afterAll(() => {
  mock.module("@atlcli/core", () => realCore);
  mock.module("@atlcli/confluence", () => realConfluence);
  mock.module("@atlcli/jira", () => realJira);
});

type Profile = {
  name: string;
  baseUrl: string;
  auth: { type: string; email?: string; token?: string };
};

type Config = { currentProfile?: string; profiles: Record<string, Profile> };

let config: Config;

const output = mock((_: unknown) => {});
const fail = mock((_: unknown, __: number, ___: string, message: string) => {
  throw new Error(message);
});

mock.module("@atlcli/core", () => ({
  ERROR_CODES,
  getFlag,
  hasFlag,
  output,
  fail,
  loadConfig: async () => config,
  getActiveProfile: (cfg: Config, requested?: string) => {
    if (requested) return cfg.profiles[requested];
    if (cfg.currentProfile) return cfg.profiles[cfg.currentProfile];
    return undefined;
  },
  getConfluenceBaseUrl: (profile: Profile) => profile.baseUrl,
}));

// The clients must never be constructed for a session profile; make them explode
// if the guard ever lets execution through.
mock.module("@atlcli/confluence", () => ({
  ConfluenceClient: class {
    constructor() {
      throw new Error("ConfluenceClient should not be constructed for a session profile");
    }
  },
}));
mock.module("@atlcli/jira", () => ({
  JiraClient: class {
    constructor() {
      throw new Error("JiraClient should not be constructed for a session profile");
    }
  },
}));

const { handleSpace } = await import("./space.js");
const { checkConfluenceApi, checkJiraApi } = await import("./doctor.js");
const { SESSION_CLI_ERROR, assertCliAuthSupported } = await import("./session-guard.js");

const opts = { json: true };

describe("session auth CLI guard (spec 001 task 5)", () => {
  beforeEach(() => {
    output.mockReset();
    fail.mockReset();
    fail.mockImplementation((_: unknown, __: number, ___: string, message: string) => {
      throw new Error(message);
    });
  });

  test("assertCliAuthSupported fails with the exact §2.4 message for a session profile", () => {
    expect(() =>
      assertCliAuthSupported({ auth: { type: "session" } } as never, opts as never)
    ).toThrow(SESSION_CLI_ERROR);
    expect(fail).toHaveBeenCalledWith(opts, 1, ERROR_CODES.AUTH, SESSION_CLI_ERROR);
  });

  test("assertCliAuthSupported passes through non-session profiles", () => {
    expect(() =>
      assertCliAuthSupported({ auth: { type: "apiToken" } } as never, opts as never)
    ).not.toThrow();
    expect(fail).not.toHaveBeenCalled();
  });

  test("space command handler rejects a session profile before any API call", async () => {
    config = {
      currentProfile: "browser",
      profiles: {
        browser: { name: "browser", baseUrl: "https://x.atlassian.net", auth: { type: "session" } },
      },
    };

    await expect(handleSpace(["list"], {}, opts as never)).rejects.toThrow(SESSION_CLI_ERROR);
  });

  // Regression (spec 001 review): doctor's connectivity checks bypassed the
  // session guard, constructing real clients and reporting a misleading
  // "auth failed". Doctor must instead report a failed check carrying the
  // exact §2.4 message — without constructing any client.
  test("doctor confluence check reports the §2.4 message for a session profile without constructing a client", async () => {
    const profile = {
      name: "browser",
      baseUrl: "https://x.atlassian.net",
      auth: { type: "session" },
    };

    const result = await checkConfluenceApi(profile as never);

    expect(result.status).toBe("fail");
    expect(result.message).toBe(SESSION_CLI_ERROR);
    expect(result.name).toBe("confluence_api");
  });

  test("doctor jira check reports the §2.4 message for a session profile without constructing a client", async () => {
    const profile = {
      name: "browser",
      baseUrl: "https://x.atlassian.net",
      auth: { type: "session" },
    };

    const result = await checkJiraApi(profile as never);

    expect(result.status).toBe("fail");
    expect(result.message).toBe(SESSION_CLI_ERROR);
    expect(result.name).toBe("jira_api");
  });
});
