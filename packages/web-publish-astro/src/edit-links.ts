export interface ConfluenceEditRelationV1 {
  sourceId: string;
  /** Cloud `_links.editui` returned by the provider. */
  editui?: string;
  /** Data Center `webui`/edit relation returned by the provider. */
  webui?: string;
}

export interface PublicationEditLinkV1 {
  sourceId: string;
  href: string;
  label: string;
}

function trustedProviderUrl(value: string | undefined, origin: string): string | undefined {
  if (value === undefined) return undefined;
  let candidate: URL;
  try {
    candidate = new URL(value);
  } catch {
    return undefined;
  }
  let trusted: URL;
  try {
    trusted = new URL(origin);
  } catch {
    return undefined;
  }
  const sensitiveQuery = [...candidate.searchParams.keys()].some((key) => /(?:token|secret|password|apikey|api-key)/iu.test(key));
  if (candidate.protocol !== "https:" || candidate.origin !== trusted.origin || candidate.username || candidate.password || candidate.hash || sensitiveQuery || candidate.pathname === "/") {
    return undefined;
  }
  return candidate.href;
}

/**
 * Resolve only a provider-returned edit relation. The fallback chooses another
 * returned relation; it never builds a Confluence URL from a page ID/title.
 */
export function resolveConfluenceEditLinkV1(options: {
  relation: ConfluenceEditRelationV1;
  trustedOrigin: string;
  label: string;
  fallback: "open-page" | "omit";
  visibility: "internal" | "all";
  publicationVisibility: "internal" | "public";
  publicTenantDisclosureAcknowledged?: true;
}): PublicationEditLinkV1 | undefined {
  if (options.publicationVisibility === "public" && options.visibility === "all" && options.publicTenantDisclosureAcknowledged !== true) {
    throw new TypeError("public Confluence edit links require tenant disclosure acknowledgement");
  }
  if (options.publicationVisibility === "public" && options.visibility === "internal") return undefined;
  const href = trustedProviderUrl(options.relation.editui, options.trustedOrigin) ??
    (options.fallback === "open-page" ? trustedProviderUrl(options.relation.webui, options.trustedOrigin) : undefined);
  if (href === undefined) return undefined;
  return Object.freeze({ sourceId: options.relation.sourceId, href, label: nonEmptyLabel(options.label) });
}

function nonEmptyLabel(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError("edit-link label must be a non-empty safe string");
  return value.trim();
}
