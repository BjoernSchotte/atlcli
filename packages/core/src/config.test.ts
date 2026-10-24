import { describe, test, expect } from "bun:test";
import { lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Config,
  Profile,
  getProfile,
  setProfile,
  removeProfile,
  renameProfile,
  clearProfileAuth,
  setCurrentProfile,
  getActiveProfile,
} from "./config.js";

function createTestConfig(): Config {
  return {
    currentProfile: "work",
    profiles: {
      work: {
        name: "work",
        baseUrl: "https://work.atlassian.net",
        auth: { type: "apiToken", email: "user@work.com", token: "work-token" },
      },
      personal: {
        name: "personal",
        baseUrl: "https://personal.atlassian.net",
        auth: { type: "apiToken", email: "me@example.com", token: "personal-token" },
      },
    },
  };
}

describe("config", () => {
  describe("getProfile", () => {
    test("returns profile by name", () => {
      const config = createTestConfig();
      const profile = getProfile(config, "work");
      expect(profile?.name).toBe("work");
      expect(profile?.baseUrl).toBe("https://work.atlassian.net");
    });

    test("returns undefined for non-existent profile", () => {
      const config = createTestConfig();
      const profile = getProfile(config, "nonexistent");
      expect(profile).toBeUndefined();
    });
  });

  describe("setProfile", () => {
    test("adds new profile", () => {
      const config = createTestConfig();
      const newProfile: Profile = {
        name: "test",
        baseUrl: "https://test.atlassian.net",
        auth: { type: "apiToken", email: "test@example.com", token: "test-token" },
      };
      setProfile(config, newProfile);
      expect(config.profiles["test"]).toBeDefined();
      expect(config.profiles["test"].baseUrl).toBe("https://test.atlassian.net");
    });

    test("updates existing profile", () => {
      const config = createTestConfig();
      const updatedProfile: Profile = {
        name: "work",
        baseUrl: "https://new-work.atlassian.net",
        auth: { type: "apiToken", email: "new@work.com", token: "new-token" },
      };
      setProfile(config, updatedProfile);
      expect(config.profiles["work"].baseUrl).toBe("https://new-work.atlassian.net");
    });
  });

  describe("removeProfile", () => {
    test("removes profile", () => {
      const config = createTestConfig();
      removeProfile(config, "personal");
      expect(config.profiles["personal"]).toBeUndefined();
      expect(config.profiles["work"]).toBeDefined();
    });

    test("clears currentProfile if removed profile was active", () => {
      const config = createTestConfig();
      expect(config.currentProfile).toBe("work");
      removeProfile(config, "work");
      expect(config.currentProfile).toBeUndefined();
    });

    test("does not affect currentProfile when removing non-active profile", () => {
      const config = createTestConfig();
      expect(config.currentProfile).toBe("work");
      removeProfile(config, "personal");
      expect(config.currentProfile).toBe("work");
    });

    test("handles removing non-existent profile gracefully", () => {
      const config = createTestConfig();
      removeProfile(config, "nonexistent");
      expect(Object.keys(config.profiles)).toHaveLength(2);
    });
  });

  describe("renameProfile", () => {
    test("renames profile", () => {
      const config = createTestConfig();
      const result = renameProfile(config, "personal", "home");
      expect(result).toBe(true);
      expect(config.profiles["personal"]).toBeUndefined();
      expect(config.profiles["home"]).toBeDefined();
      expect(config.profiles["home"].name).toBe("home");
      expect(config.profiles["home"].baseUrl).toBe("https://personal.atlassian.net");
    });

    test("updates currentProfile if renamed profile was active", () => {
      const config = createTestConfig();
      expect(config.currentProfile).toBe("work");
      const result = renameProfile(config, "work", "office");
      expect(result).toBe(true);
      expect(config.currentProfile).toBe("office");
    });

    test("does not affect currentProfile when renaming non-active profile", () => {
      const config = createTestConfig();
      expect(config.currentProfile).toBe("work");
      renameProfile(config, "personal", "home");
      expect(config.currentProfile).toBe("work");
    });

    test("returns false for non-existent profile", () => {
      const config = createTestConfig();
      const result = renameProfile(config, "nonexistent", "new-name");
      expect(result).toBe(false);
    });

    test("returns false if target name already exists", () => {
      const config = createTestConfig();
      const result = renameProfile(config, "work", "personal");
      expect(result).toBe(false);
      // Original profiles should remain unchanged
      expect(config.profiles["work"]).toBeDefined();
      expect(config.profiles["personal"]).toBeDefined();
    });

    test("preserves all profile data when renaming", () => {
      const config = createTestConfig();
      renameProfile(config, "work", "office");
      const profile = config.profiles["office"];
      expect(profile.auth.email).toBe("user@work.com");
      expect(profile.auth.token).toBe("work-token");
    });
  });

  describe("clearProfileAuth", () => {
    test("clears auth credentials", () => {
      const config = createTestConfig();
      const result = clearProfileAuth(config, "work");
      expect(result).toBe(true);
      expect(config.profiles["work"].auth.type).toBe("apiToken");
      expect(config.profiles["work"].auth.email).toBeUndefined();
      expect(config.profiles["work"].auth.token).toBeUndefined();
    });

    test("keeps profile after clearing auth", () => {
      const config = createTestConfig();
      clearProfileAuth(config, "work");
      expect(config.profiles["work"]).toBeDefined();
      expect(config.profiles["work"].baseUrl).toBe("https://work.atlassian.net");
    });

    test("returns false for non-existent profile", () => {
      const config = createTestConfig();
      const result = clearProfileAuth(config, "nonexistent");
      expect(result).toBe(false);
    });

    test("does not affect other profiles", () => {
      const config = createTestConfig();
      clearProfileAuth(config, "work");
      expect(config.profiles["personal"].auth.email).toBe("me@example.com");
      expect(config.profiles["personal"].auth.token).toBe("personal-token");
    });
  });

  describe("setCurrentProfile", () => {
    test("sets current profile", () => {
      const config = createTestConfig();
      setCurrentProfile(config, "personal");
      expect(config.currentProfile).toBe("personal");
    });
  });

  describe("getActiveProfile", () => {
    test("returns requested profile when specified", () => {
      const config = createTestConfig();
      const profile = getActiveProfile(config, "personal");
      expect(profile?.name).toBe("personal");
    });

    test("returns current profile when no name specified", () => {
      const config = createTestConfig();
      const profile = getActiveProfile(config);
      expect(profile?.name).toBe("work");
    });

    test("returns undefined when no current profile and no name specified", () => {
      const config: Config = { profiles: {} };
      const profile = getActiveProfile(config);
      expect(profile).toBeUndefined();
    });
  });

  describe("Profile TLS fields", () => {
    test("profile accepts tlsCaFile field", () => {
      const profile: Profile = {
        name: "dc",
        baseUrl: "https://jira.company.com",
        auth: { type: "bearer", pat: "token" },
        tlsCaFile: "/etc/ssl/certs/company-ca.pem",
      };
      expect(profile.tlsCaFile).toBe("/etc/ssl/certs/company-ca.pem");
    });

    test("profile accepts tlsSkipVerify field", () => {
      const profile: Profile = {
        name: "dc",
        baseUrl: "https://jira.company.com",
        auth: { type: "bearer", pat: "token" },
        tlsSkipVerify: true,
      };
      expect(profile.tlsSkipVerify).toBe(true);
    });

    test("TLS fields are preserved through setProfile and getProfile", () => {
      const config = createTestConfig();
      const newProfile: Profile = {
        name: "dc",
        baseUrl: "https://jira.company.com",
        auth: { type: "bearer", pat: "token" },
        tlsCaFile: "/path/to/ca.pem",
        tlsSkipVerify: false,
      };
      setProfile(config, newProfile);
      const retrieved = getProfile(config, "dc");
      expect(retrieved?.tlsCaFile).toBe("/path/to/ca.pem");
      expect(retrieved?.tlsSkipVerify).toBe(false);
    });
  });
});

describe("saveConfig", () => {
  // In a child process: the config path comes from ATLCLI_CONFIG when the module loads.
  async function save(path: string): Promise<void> {
    const script = `import { saveConfig } from ${JSON.stringify(fileURLToPath(new URL("./config.ts", import.meta.url)))}; await saveConfig({ profiles: {}, tui: { refresh: 30 } });`;
    const proc = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, ATLCLI_CONFIG: path }, stderr: "pipe" });
    expect(await proc.exited).toBe(0);
  }

  test("writes atomically and owner-only, leaving no temp file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlcli-config-"));
    try {
      const file = join(dir, "config.json");
      await save(file);
      expect(JSON.parse(await readFile(file, "utf8")).tui).toEqual({ refresh: 30 });
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readdir(dir)).toEqual(["config.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a symlinked config stays a symlink; the file it points to is replaced", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(join(tmpdir(), "atlcli-config-"));
    try {
      const real = join(dir, "dotfiles-config.json");
      const link = join(dir, "config.json");
      await writeFile(real, "{}");
      await symlink(real, link);
      await save(link);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await readFile(real, "utf8")).tui).toEqual({ refresh: 30 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
