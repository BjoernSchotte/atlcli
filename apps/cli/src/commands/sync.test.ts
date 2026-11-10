/**
 * Tests for sync command configuration.
 *
 * These tests verify critical configuration defaults that prevent
 * path-related bugs in the sync daemon.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { labelScopeCql, pageInScope, StateWrites, webhookSettings } from "./sync.js";

describe("sync command", () => {
  describe("default directory configuration", () => {
    /**
     * Regression test for the "docs/docs/" path doubling bug.
     *
     * The sync command previously defaulted to "./docs" which caused
     * nested directory creation when run from a docs directory:
     * - User runs `cd ~/project/docs && atlcli wiki docs sync`
     * - Sync defaulted to "./docs" → ~/project/docs/docs/
     * - Created nested .atlcli/ and duplicate files
     *
     * The fix changed the default to "." (current directory).
     */
    test("default directory should be current directory, not ./docs", () => {
      // Read the sync.ts source file
      const syncPath = join(import.meta.dir, "sync.ts");
      const syncSource = readFileSync(syncPath, "utf-8");

      // Find the line that sets the default directory
      // Expected: const dir = resolve(args[0] ?? getFlag(flags, "dir") ?? ".");
      const dirDefaultMatch = syncSource.match(
        /const\s+dir\s*=\s*resolve\(args\[0\]\s*\?\?\s*getFlag\(flags,\s*["']dir["']\)\s*\?\?\s*["']([^"']+)["']/
      );

      expect(dirDefaultMatch).not.toBeNull();
      expect(dirDefaultMatch![1]).toBe(".");

      // Also verify it's NOT "./docs" which was the bug
      expect(dirDefaultMatch![1]).not.toBe("./docs");
      expect(dirDefaultMatch![1]).not.toBe("docs");
    });

    test("sync help text should not mention ./docs as default", () => {
      const syncPath = join(import.meta.dir, "sync.ts");
      const syncSource = readFileSync(syncPath, "utf-8");

      // Find the syncHelp function
      const helpMatch = syncSource.match(/export function syncHelp\(\)[^{]*\{[\s\S]*?^}/m);

      if (helpMatch) {
        // Verify help text doesn't advertise ./docs as default
        expect(helpMatch[0]).not.toContain("default: ./docs");
        expect(helpMatch[0]).not.toContain("defaults to ./docs");
      }
    });
  });
});

describe("initial sync state writes", () => {
  test("a batch writes every 100th save and once at the end, not once per page", async () => {
    const log: string[] = [];
    const writes = new StateWrites(async () => void log.push("write"));
    writes.begin();
    for (let i = 0; i < 250; i++) await writes.save(async () => void log.push(`links ${i}`));
    expect(log.filter((entry) => entry === "write").length).toBe(2);
    // Links wait for the write that stores their page row.
    expect(log.slice(0, 3)).toEqual(["write", "links 0", "links 1"]);
    expect(log).not.toContain("links 200");
    await writes.end();
    expect(log.filter((entry) => entry === "write").length).toBe(3);
    expect(log.at(-1)).toBe("links 249");
    await writes.end();
    expect(log.filter((entry) => entry === "write").length).toBe(3);
  });

  test("outside a batch every save writes at once", async () => {
    const log: string[] = [];
    const writes = new StateWrites(async () => void log.push("write"));
    await writes.save(async () => void log.push("links"));
    await writes.save();
    expect(log).toEqual(["write", "links", "write"]);
  });
});

describe("sync --label", () => {
  test("the label and space are CQL string literals", () => {
    expect(labelScopeCql('a"b', "DOC")).toBe('label = "a\\"b" AND type = page AND space = "DOC"');
  });
});

describe("sync webhook server settings", () => {
  test("binds loopback without a secret", () => {
    expect(webhookSettings({}, {})).toEqual({ host: "127.0.0.1", secret: undefined });
  });

  test("another interface without a secret is a usage error", () => {
    for (const host of ["0.0.0.0", "::", "192.0.2.10"]) {
      expect(webhookSettings({ host }, {})).toEqual({ error: expect.stringContaining("needs a webhook secret") });
    }
  });

  test("the secret comes from the flag or ATLCLI_WEBHOOK_SECRET", () => {
    expect(webhookSettings({ host: "0.0.0.0" }, { ATLCLI_WEBHOOK_SECRET: "from-env" })).toEqual({
      host: "0.0.0.0",
      secret: "from-env",
    });
    expect(webhookSettings({ secret: "from-flag" }, { ATLCLI_WEBHOOK_SECRET: "from-env" })).toEqual({
      host: "127.0.0.1",
      secret: "from-flag",
    });
    // An empty value is no secret.
    expect(webhookSettings({ host: "0.0.0.0", secret: "" }, { ATLCLI_WEBHOOK_SECRET: "" })).toHaveProperty("error");
  });
});

describe("sync webhook scope check", () => {
  // What Confluence says about the page; the webhook request is never consulted.
  const client = {
    getPageMetadata: async (id: string) => ({
      id,
      title: "Stub",
      spaceKey: id === "500" ? "OTHER" : "DOC",
      ancestors: id === "300" ? [{ id: "1", title: "Home" }, { id: "200", title: "Root" }] : [{ id: "1", title: "Home" }],
    }),
  };

  test("page scope: only that page", async () => {
    expect(await pageInScope(client, { type: "page", pageId: "300" }, "300")).toBe(true);
    expect(await pageInScope(client, { type: "page", pageId: "300" }, "500")).toBe(false);
  });

  test("tree scope: the root and its descendants", async () => {
    const scope = { type: "tree", ancestorId: "200" } as const;
    expect(await pageInScope(client, scope, "200")).toBe(true);
    expect(await pageInScope(client, scope, "300")).toBe(true);
    expect(await pageInScope(client, scope, "400")).toBe(false);
  });

  test("space scope: the space Confluence reports", async () => {
    const scope = { type: "space", spaceKey: "DOC" } as const;
    expect(await pageInScope(client, scope, "300")).toBe(true);
    expect(await pageInScope(client, scope, "500")).toBe(false);
  });
});
