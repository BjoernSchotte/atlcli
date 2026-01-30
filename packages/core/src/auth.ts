import { Buffer } from "node:buffer";
import { getKeychainToken } from "./keychain.js";
import type { Profile } from "./config.js";

const KEYCHAIN_SERVICE = "atlcli";

/**
 * Resolve the authentication token for a profile.
 *
 * Token priority (like jira-cli):
 * 1. Environment variable: ATLCLI_API_TOKEN (highest priority)
 * 2. Mac Keychain: Entry named "atlcli" with account = username
 * 3. Config file: profile.auth.pat or profile.auth.token (lowest priority)
 *
 * @param profile - The profile to resolve the token for
 * @returns The resolved token, or null if not found
 */
export function resolveToken(profile: Profile): string | null {
  // 1. Environment variable (highest priority)
  const envToken = process.env.ATLCLI_API_TOKEN;
  if (envToken) {
    return envToken;
  }

  // 2. Mac Keychain
  if (profile.auth.username) {
    const keychainToken = getKeychainToken(KEYCHAIN_SERVICE, profile.auth.username);
    if (keychainToken) {
      return keychainToken;
    }
  }

  // 3. Config file (lowest priority)
  if (profile.auth.type === "bearer" && profile.auth.pat) {
    return profile.auth.pat;
  }
  if (profile.auth.type === "apiToken" && profile.auth.token) {
    return profile.auth.token;
  }

  return null;
}

/**
 * Build the Authorization header for a profile.
 *
 * @param profile - The profile to build the header for
 * @returns The Authorization header value (e.g., "Bearer <token>" or "Basic <encoded>")
 * @throws Error if no token is found
 */
export function buildAuthHeader(profile: Profile): string {
  const token = resolveToken(profile);
  if (!token) {
    throw new Error(
      "No token found. Set ATLCLI_API_TOKEN environment variable, " +
      "store token in Mac Keychain, or configure token in profile."
    );
  }

  if (profile.auth.type === "bearer") {
    return `Bearer ${token}`;
  }

  // Basic auth for Cloud (apiToken type)
  const email = profile.auth.email ?? "";
  const encoded = Buffer.from(`${email}:${token}`).toString("base64");
  return `Basic ${encoded}`;
}

/**
 * Get the keychain service name used by atlcli.
 */
export function getKeychainService(): string {
  return KEYCHAIN_SERVICE;
}
