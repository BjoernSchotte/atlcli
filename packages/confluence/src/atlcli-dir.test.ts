import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import {
  initAtlcliDir,
  initAtlcliDirV2,
  readConfig,
  writeConfig,
  isConfigV2,
  getConfigScope,
  migrateConfigToV2,
  isInitialized,
  findAtlcliDir,
  AtlcliConfigV1,
  AtlcliConfigV2,
  ConfigScope,
} from "./atlcli-dir.js";

describe("atlcli-dir", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "atlcli-dir-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("initAtlcliDir (v1)", () => {
    test("creates .atlcli directory structure", async () => {
      await initAtlcliDir(tempDir, {
        space: "TEAM",
        baseUrl: "https://example.atlassian.net",
        profile: "default",
      });

      expect(existsSync(join(tempDir, ".atlcli"))).toBe(true);
      expect(existsSync(join(tempDir, ".atlcli", "config.json"))).toBe(true);
      expect(existsSync(join(tempDir, ".atlcli", "state.json"))).toBe(true);
      expect(existsSync(join(tempDir, ".atlcli", "cache"))).toBe(true);
    });

    test("creates v1 config", async () => {
      await initAtlcliDir(tempDir, {
        space: "TEAM",
        baseUrl: "https://example.atlassian.net",
      });

      const config = await readConfig(tempDir);
      expect(config.schemaVersion).toBe(1);
      expect(config.space).toBe("TEAM");
    });
  });

  describe("initAtlcliDirV2", () => {
    test("creates v2 config with space scope", async () => {
      await initAtlcliDirV2(tempDir, {
        scope: { type: "space" },
        space: "TEAM",
        baseUrl: "https://example.atlassian.net",
      });

      const config = await readConfig(tempDir);
      expect(config.schemaVersion).toBe(2);
      expect(isConfigV2(config)).toBe(true);
      if (isConfigV2(config)) {
        expect(config.scope).toEqual({ type: "space" });
      }
    });

    test("creates v2 config with page scope", async () => {
      await initAtlcliDirV2(tempDir, {
        scope: { type: "page", pageId: "12345" },
        space: "TEAM",
        baseUrl: "https://example.atlassian.net",
      });

      const config = await readConfig(tempDir);
      expect(isConfigV2(config)).toBe(true);
      if (isConfigV2(config)) {
        expect(config.scope).toEqual({ type: "page", pageId: "12345" });
      }
    });

    test("creates v2 config with tree scope", async () => {
      await initAtlcliDirV2(tempDir, {
        scope: { type: "tree", ancestorId: "67890" },
        space: "TEAM",
        baseUrl: "https://example.atlassian.net",
      });

      const config = await readConfig(tempDir);
      expect(isConfigV2(config)).toBe(true);
      if (isConfigV2(config)) {
        expect(config.scope).toEqual({ type: "tree", ancestorId: "67890" });
      }
    });
  });

  describe("isConfigV2", () => {
    test("returns true for v2 config", () => {
      const config: AtlcliConfigV2 = {
        schemaVersion: 2,
        scope: { type: "space" },
        space: "TEAM",
        baseUrl: "https://example.atlassian.net",
      };
      expect(isConfigV2(config)).toBe(true);
    });

    test("returns false for v1 config", () => {
      const config: AtlcliConfigV1 = {
        schemaVersion: 1,
        space: "TEAM",
        baseUrl: "https://example.atlassian.net",
      };
      expect(isConfigV2(config)).toBe(false);
    });
  });

  describe("getConfigScope", () => {
    test("returns scope from v2 config", () => {
      const config: AtlcliConfigV2 = {
        schemaVersion: 2,
        scope: { type: "tree", ancestorId: "12345" },
        space: "TEAM",
        baseUrl: "https://example.atlassian.net",
      };
      expect(getConfigScope(config)).toEqual({ type: "tree", ancestorId: "12345" });
    });

    test("returns space scope for v1 config", () => {
      const config: AtlcliConfigV1 = {
        schemaVersion: 1,
        space: "TEAM",
        baseUrl: "https://example.atlassian.net",
      };
      expect(getConfigScope(config)).toEqual({ type: "space" });
    });
  });

  describe("migrateConfigToV2", () => {
    test("converts v1 config to v2", () => {
      const v1: AtlcliConfigV1 = {
        schemaVersion: 1,
        space: "TEAM",
        baseUrl: "https://example.atlassian.net",
        profile: "default",
        settings: {
          autoCreatePages: true,
        },
      };

      const v2 = migrateConfigToV2(v1);

      expect(v2.schemaVersion).toBe(2);
      expect(v2.scope).toEqual({ type: "space" });
      expect(v2.space).toBe("TEAM");
      expect(v2.baseUrl).toBe("https://example.atlassian.net");
      expect(v2.profile).toBe("default");
      expect(v2.settings?.autoCreatePages).toBe(true);
    });
  });

  describe("isInitialized", () => {
    test("returns false for uninitialized directory", () => {
      expect(isInitialized(tempDir)).toBe(false);
    });

    test("returns true after initialization", async () => {
      await initAtlcliDir(tempDir, {
        space: "TEAM",
        baseUrl: "https://example.atlassian.net",
      });
      expect(isInitialized(tempDir)).toBe(true);
    });
  });

  describe("findAtlcliDir", () => {
    test("finds .atlcli in current directory", async () => {
      await initAtlcliDir(tempDir, {
        space: "TEAM",
        baseUrl: "https://example.atlassian.net",
      });

      const found = findAtlcliDir(tempDir);
      expect(found).toBe(tempDir);
    });

    test("finds .atlcli in parent directory", async () => {
      await initAtlcliDir(tempDir, {
        space: "TEAM",
        baseUrl: "https://example.atlassian.net",
      });

      const subDir = join(tempDir, "subdir", "nested");
      await mkdir(subDir, { recursive: true });

      const found = findAtlcliDir(subDir);
      expect(found).toBe(tempDir);
    });

    test("returns null when not found", () => {
      const found = findAtlcliDir(tempDir);
      expect(found).toBeNull();
    });
  });

  describe("writeConfig and readConfig", () => {
    test("round-trips v2 config", async () => {
      await initAtlcliDirV2(tempDir, {
        scope: { type: "page", pageId: "12345" },
        space: "TEAM",
        baseUrl: "https://example.atlassian.net",
      });

      const config = await readConfig(tempDir);
      expect(config.schemaVersion).toBe(2);

      // Modify and write back
      if (isConfigV2(config)) {
        config.scope = { type: "tree", ancestorId: "67890" };
        await writeConfig(tempDir, config);
      }

      const updated = await readConfig(tempDir);
      expect(isConfigV2(updated)).toBe(true);
      if (isConfigV2(updated)) {
        expect(updated.scope).toEqual({ type: "tree", ancestorId: "67890" });
      }
    });
  });
});
