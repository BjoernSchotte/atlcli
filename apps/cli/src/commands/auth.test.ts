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
  deploymentType?: "cloud" | "data-center";
  auth: AuthConfig;
  tlsCaFile?: string;
  tlsSkipVerify?: boolean;
};

type Config = {
  currentProfile?: string;
  profiles: Record<string, Profile>;
};

const utils = await import("../../../../packages/core/src/utils");
const { ERROR_CODES, getFlag, hasFlag, normalizeBaseUrl, slugify } = utils;

/**
 * Load the REAL barrel before mocking it. `mock.module` semantics depend on
 * whether the target module is already evaluated: if it is, only the factory's
 * keys are patched and every other export stays real; if it is NOT, the factory
 * result becomes the COMPLETE export set — and any name missing from it (e.g.
 * `resolveDeploymentType`, imported by ./auth.ts) is a load-time SyntaxError.
 * That made this file order-dependent: it passed only when some earlier test
 * happened to import @atlcli/core first. Importing the real module here and
 * spreading it into the factory removes the order dependence entirely — the
 * factory always carries the full real surface plus the intended overrides.
 */
const actualCore = await import("@atlcli/core");

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
  ...actualCore,
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

  test("saves tlsCaFile to profile when --ca-file is provided", async () => {
    await handleAuth(
      ["login"],
      { bearer: true, site: "https://jira.company.com", token: "mytoken", "ca-file": "/path/to/ca.pem" },
      opts
    );

    const profiles = Object.values(config.profiles);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.tlsCaFile).toBe("/path/to/ca.pem");
  });

  test("saves tlsSkipVerify to profile when --insecure is provided", async () => {
    await handleAuth(
      ["login"],
      { bearer: true, site: "https://jira.company.com", token: "mytoken", insecure: true },
      opts
    );

    const profiles = Object.values(config.profiles);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.tlsSkipVerify).toBe(true);
  });

  test("does not set tlsCaFile or tlsSkipVerify when TLS flags are absent", async () => {
    await handleAuth(
      ["login"],
      { bearer: true, site: "https://jira.company.com", token: "mytoken" },
      opts
    );

    const profiles = Object.values(config.profiles);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.tlsCaFile).toBeUndefined();
    expect(profiles[0]?.tlsSkipVerify).toBeUndefined();
  });

  test("defaults bearer profiles to Data Center deployment", async () => {
    await handleAuth(
      ["login"],
      { bearer: true, site: "https://confluence.company.com", token: "mytoken" },
      opts
    );

    expect(Object.values(config.profiles)[0]?.deploymentType).toBe("data-center");
  });

  test("defaults API-token profiles to Cloud deployment", async () => {
    await handleAuth(
      ["login"],
      {
        site: "https://company.atlassian.net",
        email: "user@example.com",
        token: "mytoken",
      },
      opts
    );

    expect(Object.values(config.profiles)[0]?.deploymentType).toBe("cloud");
  });

  test("allows an explicit deployment override", async () => {
    await handleAuth(
      ["login"],
      {
        bearer: true,
        site: "https://confluence.company.com/wiki",
        token: "mytoken",
        deployment: "cloud",
      },
      opts
    );

    expect(Object.values(config.profiles)[0]?.deploymentType).toBe("cloud");
  });

  test("rejects an invalid deployment type", async () => {
    await expect(
      handleAuth(
        ["login"],
        { site: "https://company.atlassian.net", deployment: "server" },
        opts
      )
    ).rejects.toThrow(/deployment/i);
  });
});
