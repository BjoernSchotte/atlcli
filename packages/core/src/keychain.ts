import { spawnSync } from "node:child_process";

/**
 * Mac Keychain integration for secure token storage.
 *
 * Uses the macOS `security` command to interact with the system keychain.
 * Falls back gracefully on non-macOS platforms.
 */

/**
 * Get a token from the Mac Keychain.
 *
 * @param service - Keychain service name (e.g., "atlcli")
 * @param account - Account name (e.g., username)
 * @returns The token if found, null otherwise
 */
export function getKeychainToken(service: string, account: string): string | null {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const result = spawnSync("security", [
      "find-generic-password", "-s", service, "-a", account, "-w"
    ], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

    if (result.status !== 0) {
      return null;
    }
    return result.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Store a token in the Mac Keychain.
 *
 * @param service - Keychain service name (e.g., "atlcli")
 * @param account - Account name (e.g., username)
 * @param token - The token to store
 * @returns true if successful, false otherwise
 */
export function setKeychainToken(service: string, account: string, token: string): boolean {
  if (process.platform !== "darwin") {
    return false;
  }

  try {
    // -U flag updates existing entry or creates new one
    const result = spawnSync("security", [
      "add-generic-password", "-s", service, "-a", account, "-w", token, "-U"
    ], { stdio: "pipe" });

    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Delete a token from the Mac Keychain.
 *
 * @param service - Keychain service name (e.g., "atlcli")
 * @param account - Account name (e.g., username)
 * @returns true if successful, false otherwise
 */
export function deleteKeychainToken(service: string, account: string): boolean {
  if (process.platform !== "darwin") {
    return false;
  }

  try {
    const result = spawnSync("security", [
      "delete-generic-password", "-s", service, "-a", account
    ], { stdio: "pipe" });

    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Check if a token exists in the Mac Keychain.
 *
 * @param service - Keychain service name (e.g., "atlcli")
 * @param account - Account name (e.g., username)
 * @returns true if token exists, false otherwise
 */
export function hasKeychainToken(service: string, account: string): boolean {
  return getKeychainToken(service, account) !== null;
}
