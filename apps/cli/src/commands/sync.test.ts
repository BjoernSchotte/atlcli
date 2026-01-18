/**
 * Tests for sync command configuration.
 *
 * These tests verify critical configuration defaults that prevent
 * path-related bugs in the sync daemon.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
      // Expected: const dir = args[0] ?? getFlag(flags, "dir") ?? ".";
      const dirDefaultMatch = syncSource.match(
        /const\s+dir\s*=\s*args\[0\]\s*\?\?\s*getFlag\(flags,\s*["']dir["']\)\s*\?\?\s*["']([^"']+)["']/
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
