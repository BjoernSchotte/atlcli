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
    const base = new URL(getConfluenceBaseUrl(profile));
    const url = new URL(candidate);
    if (url.origin !== base.origin) return false;

    const basePath = base.pathname.replace(/\/+$/, "");
    if (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    return extractEntityFromUrl(candidate)?.product === "confluence";
  } catch {
    return false;
  }
}
