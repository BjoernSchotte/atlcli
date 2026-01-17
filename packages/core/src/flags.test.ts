import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  flagNameToEnvVar,
  envVarToFlagName,
  findProjectConfigPath,
  getFlagValue,
  listFlags,
  loadFlags,
  setGlobalFlag,
  setProjectFlag,
  unsetFlag,
} from "./flags.js";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

describe("flags", () => {
  describe("flagNameToEnvVar", () => {
    it("should convert dot notation to FLAG_ env var", () => {
      expect(flagNameToEnvVar("uno.service")).toBe("FLAG_UNO_SERVICE");
      expect(flagNameToEnvVar("export.backend")).toBe("FLAG_EXPORT_BACKEND");
      expect(flagNameToEnvVar("simple")).toBe("FLAG_SIMPLE");
    });

    it("should handle nested dot notation", () => {
      expect(flagNameToEnvVar("feature.sub.option")).toBe("FLAG_FEATURE_SUB_OPTION");
    });
  });

  describe("envVarToFlagName", () => {
    it("should convert FLAG_ env var to dot notation", () => {
      expect(envVarToFlagName("FLAG_UNO_SERVICE")).toBe("uno.service");
      expect(envVarToFlagName("FLAG_EXPORT_BACKEND")).toBe("export.backend");
      expect(envVarToFlagName("FLAG_SIMPLE")).toBe("simple");
    });

    it("should handle nested underscores", () => {
      expect(envVarToFlagName("FLAG_FEATURE_SUB_OPTION")).toBe("feature.sub.option");
    });
  });

  describe("getFlag with env vars", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should get boolean true from env var", async () => {
      process.env.FLAG_TEST_BOOL = "true";
      const value = await getFlagValue("test.bool");
      expect(value).toBe(true);
    });

    it("should get boolean false from env var", async () => {
      process.env.FLAG_TEST_BOOL = "false";
      const value = await getFlagValue("test.bool");
      expect(value).toBe(false);
    });

    it("should get number from env var", async () => {
      process.env.FLAG_TEST_NUM = "42";
      const value = await getFlagValue("test.num");
      expect(value).toBe(42);
    });

    it("should get float from env var", async () => {
      process.env.FLAG_TEST_FLOAT = "3.14";
      const value = await getFlagValue("test.float");
      expect(value).toBe(3.14);
    });

    it("should get string from env var", async () => {
      process.env.FLAG_TEST_STR = "hello";
      const value = await getFlagValue("test.str");
      expect(value).toBe("hello");
    });

    it("should return default value when flag not set", async () => {
      const value = await getFlagValue("nonexistent.flag", "default");
      expect(value).toBe("default");
    });

    it("should return undefined when flag not set and no default", async () => {
      const value = await getFlagValue("nonexistent.flag");
      expect(value).toBeUndefined();
    });
  });

  describe("listFlags with env vars", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should list flags from env vars", async () => {
      process.env.FLAG_TEST_A = "true";
      process.env.FLAG_TEST_B = "42";

      const flags = await listFlags();
      const testA = flags.find((f) => f.name === "test.a");
      const testB = flags.find((f) => f.name === "test.b");

      expect(testA).toBeDefined();
      expect(testA?.value).toBe(true);
      expect(testA?.source).toBe("env");

      expect(testB).toBeDefined();
      expect(testB?.value).toBe(42);
      expect(testB?.source).toBe("env");
    });
  });

  describe("loadFlags with env vars", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should load flags from env vars", async () => {
      process.env.FLAG_LOAD_TEST = "value";

      const flags = await loadFlags();
      expect(flags["load.test"]).toBe("value");
    });
  });

  describe("findProjectConfigPath", () => {
    const testDir = join(os.tmpdir(), "atlcli-flags-test-" + Date.now());
    const configDir = join(testDir, ".atlcli");
    const configPath = join(configDir, "config.json");

    beforeEach(() => {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ flags: {} }));
    });

    afterEach(() => {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true });
      }
    });

    it("should find project config in current directory", () => {
      const found = findProjectConfigPath(testDir);
      expect(found).toBe(configPath);
    });

    it("should find project config in parent directory", () => {
      const subDir = join(testDir, "sub", "nested");
      mkdirSync(subDir, { recursive: true });
      const found = findProjectConfigPath(subDir);
      expect(found).toBe(configPath);
    });

    it("should return undefined when no config found", () => {
      const emptyDir = join(os.tmpdir(), "atlcli-empty-" + Date.now());
      mkdirSync(emptyDir, { recursive: true });
      try {
        const found = findProjectConfigPath(emptyDir);
        expect(found).toBeUndefined();
      } finally {
        rmSync(emptyDir, { recursive: true });
      }
    });
  });

  describe("project flag operations", () => {
    const testDir = join(os.tmpdir(), "atlcli-proj-flags-" + Date.now());
    const configDir = join(testDir, ".atlcli");
    const configPath = join(configDir, "config.json");
    const originalCwd = process.cwd();

    beforeEach(() => {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ flags: {} }));
      process.chdir(testDir);
    });

    afterEach(() => {
      process.chdir(originalCwd);
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true });
      }
    });

    it("should set and get project flag", async () => {
      await setProjectFlag("test.project", "project-value");
      const value = await getFlagValue("test.project");
      expect(value).toBe("project-value");
    });

    it("should unset project flag", async () => {
      await setProjectFlag("test.unset", true);
      let value = await getFlagValue("test.unset");
      expect(value).toBe(true);

      const removed = await unsetFlag("test.unset", "project");
      expect(removed).toBe(true);

      value = await getFlagValue("test.unset");
      expect(value).toBeUndefined();
    });

    it("should return false when unsetting non-existent flag", async () => {
      const removed = await unsetFlag("nonexistent", "project");
      expect(removed).toBe(false);
    });
  });

  describe("precedence", () => {
    const testDir = join(os.tmpdir(), "atlcli-prec-" + Date.now());
    const configDir = join(testDir, ".atlcli");
    const configPath = join(configDir, "config.json");
    const originalCwd = process.cwd();
    const originalEnv = process.env;

    beforeEach(() => {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({ flags: { "prec.test": "project" } })
      );
      process.chdir(testDir);
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.chdir(originalCwd);
      process.env = originalEnv;
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true });
      }
    });

    it("should prioritize env var over project config", async () => {
      // Project config has "project"
      let value = await getFlagValue("prec.test");
      expect(value).toBe("project");

      // ENV should override
      process.env.FLAG_PREC_TEST = "env-override";
      value = await getFlagValue("prec.test");
      expect(value).toBe("env-override");
    });
  });
});
