import type {
  PublicationBundleEditLinksV1,
  PublicationBundleV1,
  PublicationProjectV1,
} from "./contracts.js";

export interface ConfluenceEditRelationV1 {
  sourceId: string;
  /** Absolute `_links.editui` relation returned by the provider. */
  editui?: string;
  /** Absolute `_links.webui` relation returned by the provider. */
  webui?: string;
}

export interface PublicationEditLinkV1 {
  sourceId: string;
  href: string;
  label: string;
}

/**
 * The one trusted-origin filter for edit links: an absolute https URL on
 * exactly `origin`, with a path, and without credentials, fragment, or a
 * secret-bearing query. Returns the normalized URL, or `undefined`.
 */
export function trustedConfluenceEditUrlV1(value: string | undefined, origin: string): string | undefined {
  if (value === undefined) return undefined;
  let candidate: URL;
  let trusted: URL;
  try {
    candidate = new URL(value);
    trusted = new URL(origin);
  } catch {
    return undefined;
  }
  const sensitiveQuery = [...candidate.searchParams.keys()].some((key) => /(?:token|secret|password|apikey|api-key)/iu.test(key));
  if (
    candidate.protocol !== "https:" || candidate.origin !== trusted.origin || candidate.username || candidate.password ||
    candidate.hash || sensitiveQuery || candidate.pathname === "/" ||
    // Never an API route: the output verifier rejects these as private Confluence URLs.
    /\/rest\//iu.test(candidate.pathname)
  ) {
    return undefined;
  }
  return candidate.href;
}

function nonEmptyLabel(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError("edit-link label must be a non-empty safe string");
  return value.trim();
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
  const href = trustedConfluenceEditUrlV1(options.relation.editui, options.trustedOrigin) ??
    (options.fallback === "open-page" ? trustedConfluenceEditUrlV1(options.relation.webui, options.trustedOrigin) : undefined);
  if (href === undefined) return undefined;
  return Object.freeze({ sourceId: options.relation.sourceId, href, label: nonEmptyLabel(options.label) });
}

type EditLinkProjectV1 = Pick<PublicationProjectV1, "visibility" | "editLink">;

/** True when the project policy emits edit links at all. */
function editLinksEnabled(project: EditLinkProjectV1): boolean {
  return project.editLink.provider === "confluence" &&
    !(project.visibility === "public" && project.editLink.visibility === "internal");
}

/**
 * Freeze the edit links of one refresh. `trustedOrigin` is the Confluence
 * origin of the authenticated profile; pages without a usable relation on it
 * get no link. Returns `undefined` when the policy emits no edit links.
 */
export function planPublicationEditLinksV1(options: {
  project: EditLinkProjectV1;
  trustedOrigin: string;
  relations: readonly ConfluenceEditRelationV1[];
}): PublicationBundleEditLinksV1 | undefined {
  const { project } = options;
  if (project.editLink.provider !== "confluence" || !editLinksEnabled(project)) return undefined;
  const policy = project.editLink;
  let origin: URL | undefined;
  try {
    origin = new URL(options.trustedOrigin);
  } catch {
    origin = undefined;
  }
  if (origin?.protocol !== "https:") {
    throw new TypeError("Confluence edit links require an https Confluence site; set editLink.provider to \"none\" for this profile");
  }
  const links: { sourceId: string; href: string }[] = [];
  for (const relation of options.relations) {
    const link = resolveConfluenceEditLinkV1({
      relation,
      trustedOrigin: origin.origin,
      label: policy.label,
      fallback: policy.fallback,
      visibility: policy.visibility,
      publicationVisibility: project.visibility,
      ...(policy.publicTenantDisclosureAcknowledged === true ? { publicTenantDisclosureAcknowledged: true as const } : {}),
    });
    if (link !== undefined) links.push({ sourceId: link.sourceId, href: link.href });
  }
  return {
    origin: origin.origin,
    label: nonEmptyLabel(policy.label),
    placement: policy.placement,
    fallback: policy.fallback,
    links: links.sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
  };
}

/**
 * A bundle freezes the edit-link policy of its refresh. Building it under a
 * different policy would publish links the project no longer allows (or drop
 * ones it now asks for), so the build fails until the bundle is refreshed.
 */
export function assertPublicationEditLinkBuildPolicyV1(
  project: EditLinkProjectV1,
  bundle: Pick<PublicationBundleV1, "editLinks">,
): void {
  const frozen = bundle.editLinks;
  const policy = project.editLink;
  const matches = policy.provider === "confluence" && editLinksEnabled(project)
    ? frozen !== undefined && frozen.label === policy.label.trim() && frozen.placement === policy.placement && frozen.fallback === policy.fallback
    : frozen === undefined;
  if (!matches) {
    throw new TypeError("The active bundle was refreshed under a different edit-link policy; run `wiki publish refresh` before building");
  }
}

/** The frozen edit action of one page, for the trusted page template; never derived from page content. */
export function publicationEditLinkV1(
  bundle: Pick<PublicationBundleV1, "editLinks">,
  sourceId: string,
): { href: string; label: string; placement: "page-footer" | "page-actions" } | undefined {
  const frozen = bundle.editLinks;
  const link = frozen?.links.find((entry) => entry.sourceId === sourceId);
  if (frozen === undefined || link === undefined) return undefined;
  const href = trustedConfluenceEditUrlV1(link.href, frozen.origin);
  return href === undefined ? undefined : { href, label: frozen.label, placement: frozen.placement };
}
