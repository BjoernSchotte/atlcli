import { describe, test, expect, beforeEach, mock } from "bun:test";

const utils = await import("../../../../packages/core/src/utils");
const { ERROR_CODES, getFlag, hasFlag } = utils;

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
}));

// The client must never be constructed for a session profile; make it explode
// if the guard ever lets execution through.
mock.module("@atlcli/confluence", () => ({
  ConfluenceClient: class {
    constructor() {
      throw new Error("ConfluenceClient should not be constructed for a session profile");
    }
  },
}));

const { handleSpace } = await import("./space.js");
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
});
