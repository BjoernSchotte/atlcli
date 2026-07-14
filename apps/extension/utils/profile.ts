/**
 * Session-auth profile synthesis (spec 003 §2.1 / Task 2).
 *
 * Session mode needs zero stored config: from the active tab's URL we build an
 * in-memory `Profile` that rides the user's ambient Atlassian browser session
 * (`auth: { type: "session" }` → `credentials: "include"`, no Authorization
 * header — see ConfluenceClient). The base URL is the tab's origin, and the
 * deployment type is pinned to `"cloud"` explicitly (spec 001 §3.3: session
 * profiles carry no deployment heuristic of their own).
 *
 * This helper lives in the EXTENSION (not core): it encodes the PoC's
 * host-permission scope (`*.atlassian.net`, PLAN §6 risk 3). Non-Atlassian
 * origins (or malformed URLs) resolve to `null` so the panel never attempts a
 * cross-origin session fetch the manifest wouldn't permit.
 */
import type { Profile } from "@atlcli/core";

/**
 * True when `hostname` is an Atlassian Cloud host covered by the manifest's
 * `host_permissions` (`*://*.atlassian.net/*`). A leaf label plus the
 * `atlassian.net` apex is required — bare `atlassian.net` and look-alikes such
 * as `atlassian.net.evil.com` are rejected.
 */
export function isAtlassianCloudHost(hostname: string): boolean {
  return /^[a-z0-9-]+\.atlassian\.net$/i.test(hostname);
}

/**
 * Build a session `Profile` from a tab URL, or `null` for non-Atlassian /
 * malformed URLs.
 *
 * @param url - the active tab's URL (from `chrome.tabs`).
 */
export function profileFromTabUrl(url: string): Profile | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!isAtlassianCloudHost(parsed.hostname)) return null;

  return {
    name: "session",
    baseUrl: parsed.origin,
    deploymentType: "cloud",
    auth: { type: "session" },
  };
}
