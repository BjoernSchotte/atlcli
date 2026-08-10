export const PLAUSIBLE_TRACKER_VERSION_V1 = "0.4.5";

export interface PlausibleAnalyticsConfigV1 {
  provider: "plausible";
  endpoint: string;
  siteDomain: string;
  respectDoNotTrack: true;
  events: readonly ("outbound-link" | "download" | "search-open")[];
  searchTerms: false;
}

export interface PublicationAnalyticsPrivacyDeclarationV1 {
  provider: "plausible";
  trackerVersion: string;
  collected: readonly ["pageview-pathname"];
  excluded: readonly ["query", "fragment", "title", "source-id", "confluence-url", "account-data", "search-terms"];
  persistentQueue: false;
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} must be a non-empty safe string`);
  }
  return value.trim();
}

/** Validate an explicit Plausible endpoint; no endpoint is synthesized. */
export function normalizePlausibleAnalyticsConfigV1(input: {
  endpoint: string;
  siteDomain: string;
  events?: readonly ("outbound-link" | "download" | "search-open")[];
}): PlausibleAnalyticsConfigV1 {
  const endpoint = new URL(nonEmpty(input.endpoint, "analytics.endpoint"));
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/api/event") {
    throw new TypeError("analytics.endpoint must be a credential-free HTTPS /api/event URL");
  }
  const events = [...new Set(input.events ?? [])];
  if (events.some((event) => !["outbound-link", "download", "search-open"].includes(event))) {
    throw new TypeError("analytics.events contains an unsupported event");
  }
  return Object.freeze({
    provider: "plausible",
    endpoint: endpoint.href,
    siteDomain: nonEmpty(input.siteDomain, "analytics.siteDomain"),
    respectDoNotTrack: true,
    events: Object.freeze(events),
    searchTerms: false,
  });
}

/**
 * A small pinned, privacy-bounded runtime. It emits pageviews only, strips
 * query/fragment/referrer/properties, uses credentials-omit, and has no queue
 * or replay path. The endpoint is supplied by trusted project configuration.
 */
export function createPlausibleAnalyticsRuntimeV1(config: PlausibleAnalyticsConfigV1): string {
  const encoded = JSON.stringify({ endpoint: config.endpoint, domain: config.siteDomain, version: PLAUSIBLE_TRACKER_VERSION_V1 });
  return `(()=>{const c=${encoded};if(c===null||navigator.doNotTrack==="1")return;const u=location.origin+location.pathname;void fetch(c.endpoint,{method:"POST",credentials:"omit",keepalive:true,headers:{"content-type":"application/json"},body:JSON.stringify({n:"pageview",d:c.domain,u,v:c.version})}).catch(()=>{});})();`;
}

export function createPublicationAnalyticsPrivacyDeclarationV1(): PublicationAnalyticsPrivacyDeclarationV1 {
  return Object.freeze({
    provider: "plausible",
    trackerVersion: PLAUSIBLE_TRACKER_VERSION_V1,
    collected: ["pageview-pathname"] as const,
    excluded: ["query", "fragment", "title", "source-id", "confluence-url", "account-data", "search-terms"] as const,
    persistentQueue: false,
  });
}

/** Exact CSP additions required for the optional external endpoint. */
export function createPublicationAnalyticsCspV1(config: PlausibleAnalyticsConfigV1): string {
  return `default-src 'self'; script-src 'self'; connect-src 'self' ${new URL(config.endpoint).origin}; object-src 'none'; base-uri 'none'; form-action 'none'`;
}
