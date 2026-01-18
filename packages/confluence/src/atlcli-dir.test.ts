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
  getAtlcliPath,
  AtlcliConfigV1,
  AtlcliConfigV2,
  ConfigScope,
  setPageEditorVersion,
  getPageEditorVersion,
  getAllEditorVersions,
} from "./atlcli-dir.js";
import { createSyncDb } from "./sync-db/index.js";
import { createPageRecord } from "./sync-db/types.js";

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

  describe("getAtlcliPath", () => {
    test("returns .atlcli path from project root", () => {
      const projectRoot = "/home/user/project";
      const atlcliPath = getAtlcliPath(projectRoot);
      expect(atlcliPath).toBe("/home/user/project/.atlcli");
    });

    test("works with findAtlcliDir result", async () => {
      // Initialize a project
      await initAtlcliDir(tempDir, {
        space: "TEAM",
        baseUrl: "https://example.atlassian.net",
      });

      // findAtlcliDir returns project root
      const projectRoot = findAtlcliDir(tempDir);
      expect(projectRoot).toBe(tempDir);

      // getAtlcliPath converts to .atlcli path
      const atlcliPath = getAtlcliPath(projectRoot!);
      expect(atlcliPath).toBe(join(tempDir, ".atlcli"));
      expect(existsSync(atlcliPath)).toBe(true);
    });
  });

  describe("editor version tracking", () => {
    beforeEach(async () => {
      await initAtlcliDir(tempDir, {
        space: "TEAM",
        baseUrl: "https://example.atlassian.net",
      });
      const atlcliPath = getAtlcliPath(tempDir);

      // Create sync.db and add a test page
      const adapter = await createSyncDb(atlcliPath, { autoMigrate: true });
      await adapter.upsertPage(
        createPageRecord({
          pageId: "123",
          path: "test.md",
          title: "Test Page",
          spaceKey: "TEAM",
        })
      );
      await adapter.close();
    });

    test("setPageEditorVersion stores v2 editor version", async () => {
      await setPageEditorVersion(tempDir, "123", "v2");
      const version = await getPageEditorVersion(tempDir, "123");
      expect(version).toBe("v2");
    });

    test("setPageEditorVersion stores v1 editor version", async () => {
      await setPageEditorVersion(tempDir, "123", "v1");
      const version = await getPageEditorVersion(tempDir, "123");
      expect(version).toBe("v1");
    });

    test("getPageEditorVersion returns null when not set", async () => {
      const version = await getPageEditorVersion(tempDir, "123");
      expect(version).toBeNull();
    });

    test("setPageEditorVersion with null removes the property", async () => {
      await setPageEditorVersion(tempDir, "123", "v2");
      expect(await getPageEditorVersion(tempDir, "123")).toBe("v2");

      await setPageEditorVersion(tempDir, "123", null);
      expect(await getPageEditorVersion(tempDir, "123")).toBeNull();
    });

    test("getAllEditorVersions returns map of all pages", async () => {
      // Add another page
      const atlcliPath = getAtlcliPath(tempDir);
      const adapter = await createSyncDb(atlcliPath, { autoMigrate: false });
      await adapter.upsertPage(
        createPageRecord({
          pageId: "456",
          path: "another.md",
          title: "Another Page",
          spaceKey: "TEAM",
        })
      );
      await adapter.close();

      // Set editor versions
      await setPageEditorVersion(tempDir, "123", "v2");
      await setPageEditorVersion(tempDir, "456", "v1");

      const versions = await getAllEditorVersions(tempDir);
      expect(versions.get("123")).toBe("v2");
      expect(versions.get("456")).toBe("v1");
    });

    test("getAllEditorVersions returns null for pages without editor property", async () => {
      // Only set one page's editor version
      await setPageEditorVersion(tempDir, "123", "v2");

      // Add another page without setting editor version
      const atlcliPath = getAtlcliPath(tempDir);
      const adapter = await createSyncDb(atlcliPath, { autoMigrate: false });
      await adapter.upsertPage(
        createPageRecord({
          pageId: "789",
          path: "noeditor.md",
          title: "No Editor",
          spaceKey: "TEAM",
        })
      );
      await adapter.close();

      const versions = await getAllEditorVersions(tempDir);
      expect(versions.get("123")).toBe("v2");
      expect(versions.get("789")).toBeNull();
    });

    test("functions handle missing sync.db gracefully", async () => {
      // Use a directory without sync.db
      const noDbDir = await mkdtemp(join(tmpdir(), "atlcli-nodb-test-"));
      await mkdir(join(noDbDir, ".atlcli"), { recursive: true });

      // Should not throw, just return default values (pass project root, not .atlcli)
      const version = await getPageEditorVersion(noDbDir, "123");
      expect(version).toBeNull();

      const versions = await getAllEditorVersions(noDbDir);
      expect(versions.size).toBe(0);

      // Cleanup
      await rm(noDbDir, { recursive: true, force: true });
    });
  });
});
