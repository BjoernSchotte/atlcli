import { normalizePublicationRouteV1 } from "@atlcli/web-publish";

export interface PublicationPrefetchOptionsV1 {
  /** Trusted same-origin authority of the candidate site. */
  origin: string;
  /** Route paths proven by the immutable build inventory, including base. */
  verifiedRoutes: readonly string[];
  /** Candidate links from trusted navigation data. */
  hrefs: readonly string[];
}

function normalizedPath(value: string): string | undefined {
  try {
    const parsed = new URL(value, "https://atlcli-prefetch.invalid");
    if (parsed.search || parsed.hash || parsed.username || parsed.password) return undefined;
    return normalizePublicationRouteV1(parsed.pathname);
  } catch {
    return undefined;
  }
}

/**
 * Return only verified same-origin links for a progressive `rel=prefetch`
 * hint. No route is inferred from a title or from an arbitrary URL.
 */
export function planPublicationPrefetchLinksV1(options: PublicationPrefetchOptionsV1): readonly string[] {
  const configuredOrigin = new URL(options.origin);
  if ((configuredOrigin.protocol !== "https:" && configuredOrigin.protocol !== "http:") || configuredOrigin.username || configuredOrigin.password || configuredOrigin.pathname !== "/" && configuredOrigin.pathname !== "") {
    throw new TypeError("prefetch origin must be a credential-free HTTP(S) origin");
  }
  const origin = configuredOrigin.origin;
  const routes = new Set(options.verifiedRoutes.map((route) => normalizedPath(route)).filter((route): route is string => route !== undefined));
  return Object.freeze([...new Set(options.hrefs.flatMap((href) => {
    let parsed: URL;
    try {
      parsed = new URL(href, origin);
    } catch {
      return [];
    }
    if (parsed.origin !== origin || parsed.protocol !== "https:" && parsed.protocol !== "http:") return [];
    const pathname = normalizedPath(parsed.pathname);
    if (pathname === undefined || !routes.has(pathname)) return [];
    return [parsed.pathname];
  }))]);
}
