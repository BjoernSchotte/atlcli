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
 * This helper lives in the EXTENSION (not core): it encodes the extension's
 * host scope (`https://*.atlassian.net`, PLAN §6 risk 3). Non-Atlassian
 * origins (or malformed URLs) resolve to `null` so the panel never attempts a
 * cross-origin session fetch the manifest wouldn't permit.
 */
import type { Profile } from "@atlcli/core";

const ATLASSIAN_CLOUD_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/i;

/**
 * True when `hostname` is an Atlassian Cloud site host. One DNS label (no
 * leading or trailing hyphen) plus the `atlassian.net` apex is required — bare
 * `atlassian.net`, deeper subdomains and look-alikes such as
 * `atlassian.net.evil.com` are rejected.
 */
export function isAtlassianCloudHost(hostname: string): boolean {
  return ATLASSIAN_CLOUD_HOST.test(hostname);
}

/**
 * True when `origin` is exactly the serialized origin of an Atlassian Cloud
 * site: `https`, default port, a host accepted by {@link isAtlassianCloudHost}.
 *
 * This is the single rule for "is this an Atlassian site we act on". Session
 * fetches, entity detection, the action palette's context binding, its
 * side-panel gesture and its frame handshake all gate on it, so they cannot
 * disagree about a tab. Plain `http` is refused: a session cookie must never
 * ride an unencrypted request, and Atlassian Cloud does not serve it.
 */
export function isAtlassianCloudOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.port === "" &&
    isAtlassianCloudHost(parsed.hostname) && parsed.origin === origin;
}

/**
 * True when `url` is a well-formed URL on an Atlassian Cloud origin (see
 * {@link isAtlassianCloudOrigin}). A Confluence-shaped path served from a
 * FOREIGN origin (e.g. `https://evil-atlassian.net/wiki/spaces/D/pages/123/A`)
 * is classified as a non-entity from the very start — never a page we try to
 * fetch, and never a confusing "unknown error" state (spec 003, finding:
 * foreign-origin gating).
 */
export function isAtlassianCloudUrl(url: string): boolean {
  try {
    return isAtlassianCloudOrigin(new URL(url).origin);
  } catch {
    return false;
  }
}

/**
 * Build a session `Profile` from a tab URL, or `null` for non-Atlassian /
 * malformed URLs.
 *
 * @param url - the active tab's URL (from `chrome.tabs`).
 */
export function profileFromTabUrl(url: string): Profile | null {
  if (!isAtlassianCloudUrl(url)) return null;
  const parsed = new URL(url);

  return {
    name: "session",
    baseUrl: parsed.origin,
    deploymentType: "cloud",
    auth: { type: "session" },
  };
}
