/**
 * Browser-safe authentication core.
 *
 * Holds the pure header-building logic and a non-ASCII-safe base64 helper.
 * Token resolution (env/keychain/config) is Node-only and lives in
 * `auth.node.ts`; here it is an injected `TokenResolver` so this module has
 * zero `node:`/`bun:` imports.
 */

import type { Profile } from "./types.js";

/**
 * Resolves the raw auth token for a profile, or `null` when none is available.
 * Injected into {@link buildAuthHeader} so the browser and Node builds can
 * differ in *how* a token is found without changing the header logic.
 */
export type TokenResolver = (profile: Profile) => string | null;

/**
 * Base64-encode a string, surviving non-ASCII input.
 *
 * `btoa` alone throws on code points > 0xFF (e.g. umlaut e-mails), so we first
 * UTF-8 encode with `TextEncoder`, then base64 the raw bytes. The result is
 * byte-for-byte identical to `Buffer.from(input, "utf8").toString("base64")`.
 */
export function encodeBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Build the Authorization header for a profile.
 *
 * @param profile - The profile to build the header for.
 * @param resolveToken - Injected token resolver (env/keychain/config in Node).
 * @returns The Authorization header value (e.g. `Bearer <token>` or `Basic <encoded>`).
 * @throws Error if the resolver yields no token, or if Basic auth is missing an email.
 */
export function buildAuthHeader(profile: Profile, resolveToken: TokenResolver): string {
  const token = resolveToken(profile);
  if (!token) {
    throw new Error(`No token resolved for profile '${profile.name}' by the configured token resolver.`);
  }

  if (profile.auth.type === "bearer") {
    return `Bearer ${token}`;
  }

  // Basic auth for Cloud (apiToken type)
  const email = profile.auth.email;
  if (!email) {
    throw new Error(
      "Email is required for Basic auth. Set email in profile or re-run `atlcli auth login`."
    );
  }
  return `Basic ${encodeBase64(`${email}:${token}`)}`;
}
