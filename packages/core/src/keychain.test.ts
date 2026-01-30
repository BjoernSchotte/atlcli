import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";

// We can't easily mock execSync in bun:test, so we'll test the functions
// with the real keychain on macOS and skip on other platforms

describe("keychain", () => {
  const isMac = process.platform === "darwin";

  // Import dynamically to test platform checks
  let keychain: typeof import("./keychain.js");

  beforeEach(async () => {
    keychain = await import("./keychain.js");
  });

  describe("getKeychainToken", () => {
    test("returns null on non-darwin platforms", () => {
      if (isMac) {
        // On Mac, this will try the real keychain
        // A non-existent entry should return null
        const result = keychain.getKeychainToken("atlcli-test-nonexistent", "nonexistent-user");
        expect(result).toBeNull();
      } else {
        // On non-Mac, should always return null
        const result = keychain.getKeychainToken("atlcli", "testuser");
        expect(result).toBeNull();
      }
    });
  });

  describe("setKeychainToken", () => {
    test("returns false on non-darwin platforms", () => {
      if (!isMac) {
        const result = keychain.setKeychainToken("atlcli", "testuser", "testtoken");
        expect(result).toBe(false);
      }
    });
  });

  describe("deleteKeychainToken", () => {
    test("returns false on non-darwin platforms", () => {
      if (!isMac) {
        const result = keychain.deleteKeychainToken("atlcli", "testuser");
        expect(result).toBe(false);
      }
    });
  });

  describe("hasKeychainToken", () => {
    test("returns false for non-existent token", () => {
      const result = keychain.hasKeychainToken("atlcli-test-nonexistent", "nonexistent-user");
      expect(result).toBe(false);
    });
  });

  // Integration test that actually uses the keychain (Mac only)
  // This test creates, reads, and deletes a real keychain entry
  if (isMac) {
    describe("integration (Mac only)", () => {
      const testService = "atlcli-test-integration";
      const testAccount = "test-user-" + Date.now();
      const testToken = "test-token-" + Math.random().toString(36);

      afterEach(() => {
        // Clean up: try to delete the test entry
        try {
          execSync(
            `security delete-generic-password -s "${testService}" -a "${testAccount}"`,
            { stdio: "pipe" }
          );
        } catch {
          // Ignore if already deleted
        }
      });

      test("roundtrip: set, get, has, delete", () => {
        // Initially should not exist
        expect(keychain.hasKeychainToken(testService, testAccount)).toBe(false);
        expect(keychain.getKeychainToken(testService, testAccount)).toBeNull();

        // Set the token
        const setResult = keychain.setKeychainToken(testService, testAccount, testToken);
        expect(setResult).toBe(true);

        // Should now exist and have correct value
        expect(keychain.hasKeychainToken(testService, testAccount)).toBe(true);
        expect(keychain.getKeychainToken(testService, testAccount)).toBe(testToken);

        // Update the token
        const newToken = "updated-token-" + Math.random().toString(36);
        const updateResult = keychain.setKeychainToken(testService, testAccount, newToken);
        expect(updateResult).toBe(true);
        expect(keychain.getKeychainToken(testService, testAccount)).toBe(newToken);

        // Delete the token
        const deleteResult = keychain.deleteKeychainToken(testService, testAccount);
        expect(deleteResult).toBe(true);

        // Should no longer exist
        expect(keychain.hasKeychainToken(testService, testAccount)).toBe(false);
        expect(keychain.getKeychainToken(testService, testAccount)).toBeNull();
      });
    });
  }
});
