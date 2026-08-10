import type {
  PublicationBundleV1,
  PublicationPageV1,
  PublicationRefreshPlanV1,
} from "./contracts.js";
import { planPublicationReferencesV1 } from "./references.js";
import { normalizePublicationRouteV1 } from "./routes.js";

const PRIVATE_OR_VOLATILE_KEYS = /(?:^|[-_])(?:access[-_]?token|api[-_]?key|authorization|cookie|credential|password|secret|signed[-_]?url|request[-_]?headers|raw[-_]?adf|storage[-_]?xhtml|absolute[-_]?path|project[-_]?dir|bundle[-_]?path|active[-_]?bundle[-_]?digest|created[-_]?at|updated[-_]?at|generated[-_]?at)$/iu;

export type PublicationDigestErrorCodeV1 =
  | "unsupported-value"
  | "cyclic-value"
  | "missing-web-crypto"
  | "duplicate-page"
  | "duplicate-bundle-page"
  | "bundle-page-mismatch"
  | "incomplete-source-snapshot"
  | "duplicate-source-snapshot"
  | "missing-source-snapshot"
  | "non-included-source"
  | "missing-active-route"
  | "route-mismatch"
  | "duplicate-route-record"
  | "active-route-without-page";

export class PublicationDigestErrorV1 extends Error {
  constructor(
    public readonly code: PublicationDigestErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "PublicationDigestErrorV1";
  }
}

function fail(code: PublicationDigestErrorCodeV1, message: string): never {
  throw new PublicationDigestErrorV1(code, message);
}

function isPrivateOrVolatileKey(key: string): boolean {
  return PRIVATE_OR_VOLATILE_KEYS.test(key);
}

/**
 * Canonical JSON for publication identities. Object keys are sorted, arrays
 * deliberately retain their semantic order, cycles and JSON-ambiguous values
 * fail, and recognized private/volatile fields are omitted recursively. The
 * typed helpers remove only their own self-digest before calling this function;
 * nested digest references remain part of a parent identity.
 */
export function canonicalPublicationJsonV1(value: unknown): string {
  const ancestors = new Set<object>();

  function encode(candidate: unknown): string {
    if (candidate === null) return "null";
    switch (typeof candidate) {
      case "string":
        return JSON.stringify(candidate);
      case "boolean":
        return candidate ? "true" : "false";
      case "number":
        if (!Number.isFinite(candidate)) fail("unsupported-value", "Digest input contains a non-finite number");
        return JSON.stringify(candidate);
      case "undefined":
      case "bigint":
      case "function":
      case "symbol":
        return fail("unsupported-value", `Digest input contains unsupported ${typeof candidate}`);
      case "object":
        break;
      default:
        return fail("unsupported-value", "Digest input contains an unsupported value");
    }

    if (ancestors.has(candidate)) fail("cyclic-value", "Digest input must not contain a cycle");
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const parts: string[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          if (!Object.hasOwn(candidate, index)) {
            fail("unsupported-value", "Digest input must not contain sparse arrays");
          }
          parts.push(encode(candidate[index]));
        }
        return `[${parts.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        fail("unsupported-value", "Digest input must contain only plain objects");
      }
      const record = candidate as Record<string, unknown>;
      const entries = Object.keys(record)
        .filter((key) => !isPrivateOrVolatileKey(key))
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`);
      return `{${entries.join(",")}}`;
    } finally {
      ancestors.delete(candidate);
    }
  }

  return encode(value);
}

/** Return a browser-safe lowercase SHA-256 over canonical publication JSON. */
export async function digestPublicationJsonV1(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) fail("missing-web-crypto", "Web Crypto SubtleCrypto is required for publication digests");
  const bytes = new TextEncoder().encode(canonicalPublicationJsonV1(value));
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Digest a page without recursively trusting its self-referential pageDigest. */
export function publicationPageDigestInputV1(page: PublicationPageV1): Omit<PublicationPageV1, "pageDigest"> {
  const { pageDigest: _pageDigest, ...identity } = page;
  return identity;
}

export async function digestPublicationPageV1(page: PublicationPageV1): Promise<string> {
  return digestPublicationJsonV1(publicationPageDigestInputV1(page));
}

/** Digest a refresh plan without its mutable predecessor or self digest. */
export function publicationRefreshPlanDigestInputV1(
  plan: PublicationRefreshPlanV1,
): Omit<PublicationRefreshPlanV1, "previousBundleDigest" | "planDigest"> {
  const { previousBundleDigest: _previousBundleDigest, planDigest: _planDigest, ...identity } = plan;
  return identity;
}

export async function digestPublicationRefreshPlanV1(
  plan: PublicationRefreshPlanV1,
): Promise<string> {
  return digestPublicationJsonV1(publicationRefreshPlanDigestInputV1(plan));
}

/**
 * Prove the bundle index agrees with its typed page documents before computing
 * an identity. `planPublicationReferencesV1` also rejects dangling links and
 * asset references, so no builder gets an unresolved internal relation.
 */
export function assertPublicationBundleReferencesV1(
  bundle: PublicationBundleV1,
  pages: readonly PublicationPageV1[],
): void {
  if (!bundle.sourceSnapshot.complete) {
    fail("incomplete-source-snapshot", "Bundle source snapshot must be complete before publication");
  }
  const sourceStateById = new Map<string, PublicationBundleV1["sourceSnapshot"]["pages"][number]["state"]>();
  for (const source of bundle.sourceSnapshot.pages) {
    if (sourceStateById.has(source.sourceId)) {
      fail("duplicate-source-snapshot", `Source snapshot lists page '${source.sourceId}' more than once`);
    }
    sourceStateById.set(source.sourceId, source.state);
  }
  const pageById = new Map<string, PublicationPageV1>();
  for (const page of pages) {
    if (pageById.has(page.sourceId)) fail("duplicate-page", `Duplicate page '${page.sourceId}'`);
    pageById.set(page.sourceId, page);
  }

  const activeRouteById = new Map<string, string>();
  for (const route of bundle.routes) {
    if (route.state !== "active") continue;
    if (activeRouteById.has(route.sourceId)) {
      fail("duplicate-route-record", `Bundle has more than one active route for '${route.sourceId}'`);
    }
    activeRouteById.set(route.sourceId, normalizePublicationRouteV1(route.route));
  }

  const bundlePageIds = new Set<string>();
  for (const entry of bundle.pages) {
    if (bundlePageIds.has(entry.sourceId)) {
      fail("duplicate-bundle-page", `Bundle lists page '${entry.sourceId}' more than once`);
    }
    bundlePageIds.add(entry.sourceId);
    const page = pageById.get(entry.sourceId);
    if (page === undefined || page.pageDigest !== entry.pageDigest) {
      fail("bundle-page-mismatch", `Bundle page '${entry.sourceId}' has no matching typed page document`);
    }
    const sourceState = sourceStateById.get(page.sourceId);
    if (sourceState === undefined) {
      fail("missing-source-snapshot", `Bundle page '${page.sourceId}' has no source snapshot entry`);
    }
    if (sourceState !== "included") {
      fail("non-included-source", `Bundle page '${page.sourceId}' has source state '${sourceState}' instead of included`);
    }
    const route = activeRouteById.get(page.sourceId);
    if (route === undefined) fail("missing-active-route", `Bundle page '${page.sourceId}' has no active route`);
    if (route !== normalizePublicationRouteV1(page.route)) {
      fail("route-mismatch", `Bundle route for '${page.sourceId}' differs from the page route`);
    }
  }

  for (const [sourceId] of activeRouteById) {
    if (!bundlePageIds.has(sourceId)) {
      fail("active-route-without-page", `Active publication route '${sourceId}' has no bundle page`);
    }
  }

  planPublicationReferencesV1({
    pages: pages.map((page) => ({
      sourceId: page.sourceId,
      route: page.route,
      ...(page.locale === undefined ? {} : { locale: page.locale }),
      blocks: page.blocks,
      links: page.links,
      assetIds: page.assetIds,
    })),
    assets: bundle.assets,
  });
}

/** Digest a verified bundle without its self digest or creation provenance. */
export function publicationBundleDigestInputV1(
  bundle: PublicationBundleV1,
): Omit<PublicationBundleV1, "bundleDigest" | "createdBy"> {
  const { bundleDigest: _bundleDigest, createdBy: _createdBy, ...identity } = bundle;
  return identity;
}

export async function digestPublicationBundleV1(
  bundle: PublicationBundleV1,
  pages: readonly PublicationPageV1[],
): Promise<string> {
  assertPublicationBundleReferencesV1(bundle, pages);
  return digestPublicationJsonV1(publicationBundleDigestInputV1(bundle));
}
