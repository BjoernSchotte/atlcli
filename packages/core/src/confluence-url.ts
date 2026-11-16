import type { DeploymentType, Profile } from "./types.js";
import { extractEntityFromUrl } from "./entity-url.js";

type ConfluenceProfile = Pick<Profile, "baseUrl" | "auth" | "deploymentType">;

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function hasConfiguredPath(baseUrl: string): boolean {
  return new URL(baseUrl).pathname.replace(/\/+$/, "") !== "";
}

/**
 * Resolve the hosting model for new and legacy profiles.
 *
 * New profiles persist an explicit value. Legacy bearer profiles are Data
 * Center profiles by convention; legacy profiles with a configured path keep
 * the context-path behavior introduced in #14. Everything else retains the
 * historical Cloud default.
 */
export function resolveDeploymentType(profile: ConfluenceProfile): DeploymentType {
  if (profile.deploymentType) return profile.deploymentType;
  // Session profiles (browser cookie auth) carry no deployment heuristic of their
  // own: absent an explicit deploymentType they default to Cloud. A DC browser
  // session is conceivable but must be made explicit (spec 001 §3.3).
  if (profile.auth.type === "session") return "cloud";
  if (profile.auth.type === "bearer") return "data-center";
  return hasConfiguredPath(normalizeUrl(profile.baseUrl)) ? "data-center" : "cloud";
}

/** Return the exact browser/API root for Confluence. */
export function getConfluenceBaseUrl(profile: ConfluenceProfile): string {
  const baseUrl = normalizeUrl(profile.baseUrl);
  if (resolveDeploymentType(profile) === "data-center") return baseUrl;

  const pathname = new URL(baseUrl).pathname.replace(/\/+$/, "");
  return pathname.endsWith("/wiki") ? baseUrl : `${baseUrl}/wiki`;
}

/** Build an absolute URL below the resolved Confluence root. */
export function buildConfluenceUrl(profile: ConfluenceProfile, path = ""): string {
  const baseUrl = getConfluenceBaseUrl(profile);
  if (!path) return baseUrl;
  return `${baseUrl}/${path.replace(/^\/+/, "")}`;
}

/** Whether `url` lives under the Confluence root `base` (same origin, below its path). */
function isUnderBase(base: URL, url: URL): boolean {
  if (url.origin !== base.origin) return false;
  const basePath = base.pathname.replace(/\/+$/, "");
  return !basePath || url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
}

/**
 * Identify a Confluence page URL belonging to this profile.
 *
 * Reimplemented on top of {@link extractEntityFromUrl} (spec 001 §5.1): the URL
 * must live under the profile's Confluence base and resolve to a Confluence
 * entity. Base-origin/path scoping stays here so URLs on other hosts (or the
 * profile's Jira `/browse/…` paths) are rejected.
 */
export function isConfluencePageUrl(profile: ConfluenceProfile, candidate: string): boolean {
  try {
    if (!isUnderBase(new URL(getConfluenceBaseUrl(profile)), new URL(candidate))) return false;
    return extractEntityFromUrl(candidate)?.product === "confluence";
  } catch {
    return false;
  }
}

/** A page, and the comment a link points at (`?focusedCommentId=`), if any. */
export interface ConfluencePageRef {
  pageId: string;
  commentId?: string;
}

/**
 * The page id a tiny link (`/x/{code}`) stands for: the code is the id's
 * little-endian bytes in URL-safe base64 with the trailing zero bytes dropped.
 */
export function decodeTinyLink(code: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,12}$/.test(code)) return undefined;
  try {
    // Confluence swaps "+" for "_" and "/" for "-" (not the RFC 4648 alphabet).
    const bytes = atob(code.replace(/_/g, "+").replace(/-/g, "/"));
    let id = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) id = (id << 8n) | BigInt(bytes.charCodeAt(i));
    return id > 0n ? id.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A page id, or a page URL of the Confluence site at `confluenceBaseUrl`
 * ({@link getConfluenceBaseUrl}), as the page it names and the comment the
 * link focuses. A URL of another site, or one without a page id in it, is an
 * error that says so: the id must never be looked up on the wrong site.
 */
export function parseConfluencePageRef(confluenceBaseUrl: string, input: string): ConfluencePageRef | { error: string } {
  const ref = input.trim();
  if (/^\d+$/.test(ref)) return { pageId: ref };
  let url: URL;
  let base: URL;
  try {
    base = new URL(confluenceBaseUrl);
    url = new URL(ref);
  } catch {
    return { error: `"${ref}" is neither a page id nor a page URL.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: `"${ref}" is neither a page id nor a page URL.` };
  if (!isUnderBase(base, url)) {
    return { error: `Not on this profile's Confluence site (${normalizeUrl(confluenceBaseUrl)}): ${url.origin}${url.pathname}. Use the profile of that site.` };
  }
  const tiny = /^\/x\/([^/]+)\/?$/.exec(url.pathname.slice(base.pathname.replace(/\/+$/, "").length));
  const entity = extractEntityFromUrl(ref);
  const pageId = tiny ? decodeTinyLink(tiny[1]!) : entity?.product === "confluence" && entity.type === "page" ? entity.pageId : undefined;
  if (!pageId) return { error: `That URL carries no page id (${url.pathname}). Use a page URL like …/pages/<id>/…, or the page id.` };
  const commentId = url.searchParams.get("focusedCommentId") ?? "";
  return /^\d+$/.test(commentId) ? { pageId, commentId } : { pageId };
}
