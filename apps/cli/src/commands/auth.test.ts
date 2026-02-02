import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

type AuthType = "apiToken" | "bearer" | "oauth";

type AuthConfig = {
  type: AuthType;
  email?: string;
  token?: string;
  pat?: string;
  username?: string;
};

type Profile = {
  name: string;
  baseUrl: string;
  auth: AuthConfig;
};

type Config = {
  currentProfile?: string;
  profiles: Record<string, Profile>;
};

const utils = await import("../../../../packages/core/src/utils.ts");
const { ERROR_CODES, getFlag, hasFlag, normalizeBaseUrl, slugify } = utils;

let config: Config;

const promptInput = mock<() => Promise<string>>(async () => "");
const promptConfirm = mock<() => Promise<boolean>>(async () => false);
const setKeychainToken = mock<() => boolean>(() => false);
const deleteKeychainToken = mock<() => boolean>(() => false);
const hasKeychainToken = mock<() => boolean>(() => false);
const loggerAuth = mock<() => void>(() => {});
const output = mock((data: unknown) => {
  lastOutput = data;
});
const fail = mock((_: unknown, __: number, ___: string, message: string) => {
  throw new Error(message);
});
let lastOutput: unknown;

mock.module("@atlcli/core", () => ({
  ERROR_CODES,
  output,
  getFlag,
  hasFlag,
  normalizeBaseUrl,
  slugify,
  loadConfig: async () => config,
  saveConfig: async (next: Config) => {
    config = next;
  },
  getConfigPath: () => join(tmpdir(), "atlcli-test", "config.json"),
  setProfile: (cfg: Config, profile: Profile) => {
    cfg.profiles[profile.name] = profile;
  },
  setCurrentProfile: (cfg: Config, name: string) => {
    cfg.currentProfile = name;
  },
  getActiveProfile: (cfg: Config, requested?: string) => {
    if (requested) return cfg.profiles[requested];
    if (cfg.currentProfile) return cfg.profiles[cfg.currentProfile];
    return undefined;
  },
  clearProfileAuth: (cfg: Config, name: string) => {
    const profile = cfg.profiles[name];
    if (!profile) return false;
    profile.auth = { type: profile.auth.type };
    return true;
  },
  removeProfile: (cfg: Config, name: string) => {
    delete cfg.profiles[name];
    if (cfg.currentProfile === name) {
      cfg.currentProfile = undefined;
    }
  },
  renameProfile: (cfg: Config, oldName: string, newName: string) => {
    const profile = cfg.profiles[oldName];
    if (!profile) return false;
    if (cfg.profiles[newName]) return false;
    profile.name = newName;
    cfg.profiles[newName] = profile;
    delete cfg.profiles[oldName];
    if (cfg.currentProfile === oldName) {
      cfg.currentProfile = newName;
    }
    return true;
  },
  promptInput,
  promptConfirm,
  setKeychainToken,
  deleteKeychainToken,
  hasKeychainToken,
  getKeychainService: () => "atlcli",
  getLogger: () => ({ auth: loggerAuth }),
  fail,
}));

const { handleAuth } = await import("./auth.js");

const opts = { json: true };

describe("auth command", () => {
  const originalEnv = process.env.ATLCLI_API_TOKEN;

  beforeEach(() => {
    config = { profiles: {} };
    promptInput.mockReset();
    promptConfirm.mockReset();
    setKeychainToken.mockReset();
    deleteKeychainToken.mockReset();
    hasKeychainToken.mockReset();
    loggerAuth.mockReset();
    output.mockReset();
    output.mockImplementation((data: unknown) => {
      lastOutput = data;
    });
    fail.mockReset();
    lastOutput = undefined;
    promptInput.mockResolvedValue("");
    promptConfirm.mockResolvedValue(false);
    setKeychainToken.mockReturnValue(false);
    deleteKeychainToken.mockReturnValue(false);
    hasKeychainToken.mockReturnValue(false);
    fail.mockImplementation((_: unknown, __: number, ___: string, message: string) => {
      throw new Error(message);
    });
    delete process.env.ATLCLI_API_TOKEN;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ATLCLI_API_TOKEN = originalEnv;
    } else {
      delete process.env.ATLCLI_API_TOKEN;
    }
  });

  const testIfMac = process.platform === "darwin" ? test : test.skip;

  testIfMac("keeps PAT in config when keychain write fails", async () => {
    promptConfirm.mockResolvedValueOnce(true);
    promptInput.mockResolvedValueOnce("pat-123");
    setKeychainToken.mockReturnValueOnce(false);

    await handleAuth(
      ["login"],
      { bearer: true, username: "testuser", site: "https://jira.example.com" },
      opts
    );

    const profiles = Object.values(config.profiles);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.auth.pat).toBe("pat-123");
  });

  test("fails bearer login when no token or keychain entry exists", async () => {
    promptConfirm.mockResolvedValueOnce(false);
    promptInput.mockResolvedValueOnce("");

    await expect(
      handleAuth(
        ["login"],
        { bearer: true, username: "testuser", site: "https://jira.example.com" },
        opts
      )
    ).rejects.toThrow(/token/i);
  });

  testIfMac("preserves username when keychain deletion fails on logout", async () => {
    config = {
      currentProfile: "work",
      profiles: {
        work: {
          name: "work",
          baseUrl: "https://jira.example.com",
          auth: { type: "bearer", username: "testuser" },
        },
      },
    };
    deleteKeychainToken.mockReturnValueOnce(false);

    await handleAuth(["logout"], {}, opts);

    expect(config.profiles.work?.auth.username).toBe("testuser");
  });

  test("warns that keychain credentials may remain when deleting a profile", async () => {
    config = {
      profiles: {
        work: {
          name: "work",
          baseUrl: "https://jira.example.com",
          auth: { type: "bearer", username: "testuser" },
        },
      },
    };

    await handleAuth(["delete", "work"], {}, opts);

    expect(deleteKeychainToken).not.toHaveBeenCalled();
    const result = lastOutput as { warning?: string };
    expect(result?.warning).toMatch(/delete-keychain/i);
  });

  testIfMac("deletes keychain credentials when flag is set", async () => {
    config = {
      profiles: {
        work: {
          name: "work",
          baseUrl: "https://jira.example.com",
          auth: { type: "bearer", username: "testuser" },
        },
      },
    };
    deleteKeychainToken.mockReturnValueOnce(true);

    await handleAuth(["delete", "work"], { "delete-keychain": true }, opts);

    expect(deleteKeychainToken).toHaveBeenCalledWith("atlcli", "testuser");
    const result = lastOutput as { warning?: string };
    expect(result?.warning).toBeUndefined();
  });
});
