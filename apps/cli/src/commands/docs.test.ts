/**
 * Tests for docs command path resolution helpers.
 *
 * These regression tests cover the fixes for confusing "path duplication"
 * and stale-state errors on `atlcli wiki docs push --page-id <id>`:
 *
 * - The command must find the file when the recorded state path is valid.
 * - The command must find the file when it was renamed/moved locally by
 *   scanning frontmatter IDs, and it must heal state on the fly.
 * - State paths must round-trip as POSIX so lookups work across Windows/Unix.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AtlcliState } from "@atlcli/confluence";

const { resolvePageFile, findMarkdownFileByFrontmatterId } = await import("./docs.js");

function buildState(overrides: Partial<AtlcliState> = {}): AtlcliState {
  return {
    schemaVersion: 1,
    lastSync: null,
    pages: {},
    pathIndex: {},
    ...overrides,
  };
}

function frontmatter(id: string, title = "Test"): string {
  return `---\natlcli:\n  id: "${id}"\n  title: "${title}"\n---\n\n# ${title}\n`;
}

describe("docs path resolution helpers", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "atlcli-docs-test-"));
    await mkdir(join(tempDir, ".atlcli"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("resolvePageFile", () => {
    test("returns the state path when the file exists there", async () => {
      const rel = "guides/install.md";
      await mkdir(join(tempDir, "guides"), { recursive: true });
      await writeFile(join(tempDir, rel), frontmatter("42", "Install"));

      const state = buildState({
        pages: {
          "42": {
            path: rel,
            title: "Install",
            spaceKey: "TEAM",
            version: 1,
            lastSyncedAt: "",
            localHash: "",
            remoteHash: "",
            baseHash: "",
            syncState: "synced",
            parentId: null,
            ancestors: [],
          },
        },
        pathIndex: { [rel]: "42" },
      });

      const resolved = await resolvePageFile(tempDir, "42", state);

      expect(resolved).not.toBeNull();
      expect(resolved!.relativePath).toBe(rel);
      expect(resolved!.absolutePath).toBe(join(tempDir, "guides", "install.md"));
    });

    test("scans the tree by frontmatter ID when the recorded path is stale", async () => {
      const oldRel = "guides/install.md";
      const newRel = "getting-started/install.md";
      await mkdir(join(tempDir, "getting-started"), { recursive: true });
      await writeFile(join(tempDir, newRel), frontmatter("42", "Install"));

      const state = buildState({
        pages: {
          "42": {
            path: oldRel,
            title: "Install",
            spaceKey: "TEAM",
            version: 1,
            lastSyncedAt: "",
            localHash: "",
            remoteHash: "",
            baseHash: "",
            syncState: "synced",
            parentId: null,
            ancestors: [],
          },
        },
        pathIndex: { [oldRel]: "42" },
      });

      const resolved = await resolvePageFile(tempDir, "42", state);

      expect(resolved).not.toBeNull();
      expect(resolved!.relativePath).toBe(newRel);
      // State should have healed: index refreshed, old entry removed.
      expect(state.pages["42"].path).toBe(newRel);
      expect(state.pathIndex[newRel]).toBe("42");
      expect(state.pathIndex[oldRel]).toBeUndefined();
    });

    test("finds files whose page ID is not yet in state at all", async () => {
      const rel = "orphans/loose-page.md";
      await mkdir(join(tempDir, "orphans"), { recursive: true });
      await writeFile(join(tempDir, rel), frontmatter("999", "Loose"));

      const state = buildState();

      const resolved = await resolvePageFile(tempDir, "999", state);

      expect(resolved).not.toBeNull();
      expect(resolved!.relativePath).toBe(rel);
      // No page state to heal, so state stays empty.
      expect(state.pages["999"]).toBeUndefined();
    });

    test("returns null when the page cannot be located anywhere", async () => {
      const state = buildState();
      const resolved = await resolvePageFile(tempDir, "does-not-exist", state);
      expect(resolved).toBeNull();
    });
  });

  describe("findMarkdownFileByFrontmatterId", () => {
    test("locates a matching file and skips non-matches", async () => {
      await mkdir(join(tempDir, "a"), { recursive: true });
      await mkdir(join(tempDir, "b"), { recursive: true });
      await writeFile(join(tempDir, "a", "other.md"), frontmatter("111", "Other"));
      await writeFile(join(tempDir, "b", "target.md"), frontmatter("222", "Target"));

      const found = await findMarkdownFileByFrontmatterId(tempDir, "222");

      expect(found).toBe(join(tempDir, "b", "target.md"));
    });

    test("returns null when nothing matches", async () => {
      await writeFile(join(tempDir, "x.md"), frontmatter("111"));
      const found = await findMarkdownFileByFrontmatterId(tempDir, "nope");
      expect(found).toBeNull();
    });
  });
});
