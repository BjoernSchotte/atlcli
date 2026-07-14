/**
 * Browser-safe URL → Atlassian entity extractor (spec 001 §5).
 *
 * Maps Confluence and Jira URLs (Cloud + Data Center variants) to typed
 * entities via a versioned, data-driven pattern registry. The registry is
 * *data* (`{ version, patterns }`) so the Phase 1 extension can inject an
 * updated registry (remote config) without a core release. First matching
 * pattern wins; patterns are ordered most-specific-first.
 *
 * This module is DOM-free and has zero `node:`/`bun:` imports.
 */

/** A typed Atlassian entity extracted from a URL. */
export type AtlassianEntity =
  | { product: "confluence"; type: "page"; pageId: string; spaceKey?: string }
  | { product: "confluence"; type: "blogpost"; contentId: string; spaceKey?: string }
  | { product: "confluence"; type: "space"; spaceKey: string }
  | { product: "jira"; type: "issue"; issueKey: string; projectKey: string }
  | { product: "jira"; type: "board"; projectKey: string; boardId: string };

type Product = AtlassianEntity["product"];
type EntityType = AtlassianEntity["type"];

/**
 * A single, declarative extraction rule.
 *
 * The `regex` (with named capture groups) is tested against a target derived
 * from the URL; `fields` maps entity-field names to capture-group names. This
 * keeps a pattern pure data — no per-pattern code.
 */
export interface EntityPattern {
  /** Stable identifier, e.g. `"confluence-page-cloud"`. */
  id: string;
  product: Product;
  type: EntityType;
  /** Regex with named groups, tested against the chosen `target`. */
  regex: RegExp;
  /** Which URL slice to test. `"path"` (default) or `"pathAndSearch"`. */
  target?: "path" | "pathAndSearch";
  /** Map of entity-field name → regex capture-group name. */
  fields: Record<string, string>;
}

/** A versioned, ordered set of extraction patterns. */
export interface PatternRegistry {
  version: number;
  patterns: EntityPattern[];
}

/**
 * Registry v1 — the normative pattern set from spec 001 §5.2.
 *
 * Ordering is significant (first match wins), so more specific patterns come
 * first. Data Center variants are matched via unanchored path fragments so an
 * arbitrary context path (e.g. `/confluence`) is tolerated.
 *
 * Note (deviation, spec 001 §5.1 type constraint): the `page` entity requires a
 * numeric `pageId`. Legacy/DC `/display/{spaceKey}/{title}` URLs carry no page
 * id, so they resolve to a `space` entity (the only reliably typed datum). Page
 * entities are produced only when a numeric id is present in the URL
 * (`/pages/{id}`, `?pageId={id}`, `viewpage.action?pageId={id}`).
 */
export const DEFAULT_PATTERN_REGISTRY: PatternRegistry = {
  version: 1,
  patterns: [
    // --- Confluence ---
    {
      id: "confluence-blogpost-cloud",
      product: "confluence",
      type: "blogpost",
      // /wiki/spaces/{spaceKey}/blog/{yyyy}/{mm}/{dd}/{contentId}/…
      regex: /\/spaces\/(?<spaceKey>[^/]+)\/blog\/\d{4}\/\d{2}\/\d{2}\/(?<contentId>\d+)/,
      fields: { spaceKey: "spaceKey", contentId: "contentId" },
    },
    {
      id: "confluence-page-cloud",
      product: "confluence",
      type: "page",
      // /wiki/spaces/{spaceKey}/pages/{pageId}/{slug?}
      regex: /\/spaces\/(?<spaceKey>[^/]+)\/pages\/(?<pageId>\d+)/,
      fields: { spaceKey: "spaceKey", pageId: "pageId" },
    },
    {
      id: "confluence-space-overview",
      product: "confluence",
      type: "space",
      // /wiki/spaces/{spaceKey} (overview), optionally /overview
      regex: /\/spaces\/(?<spaceKey>[^/]+?)(?:\/overview)?\/?$/,
      fields: { spaceKey: "spaceKey" },
    },
    {
      id: "confluence-page-display",
      product: "confluence",
      type: "space",
      // Legacy `/wiki/display/{spaceKey}/{title}` and DC `/display/{spaceKey}/{title}`
      // (with optional context path). No page id in the URL → space entity.
      regex: /(?:^|\/)display\/(?<spaceKey>[^/]+)(?:\/|$)/,
      fields: { spaceKey: "spaceKey" },
    },
    // --- Jira ---
    {
      id: "jira-issue-browse",
      product: "jira",
      type: "issue",
      // /browse/{ISSUE-KEY} (with optional context path)
      regex: /(?:^|\/)browse\/(?<issueKey>(?<projectKey>[A-Z][A-Z0-9]+)-\d+)/,
      fields: { issueKey: "issueKey", projectKey: "projectKey" },
    },
    {
      id: "jira-board",
      product: "jira",
      type: "board",
      // /jira/software/(c/)?projects/{projectKey}/boards/{boardId}
      regex: /\/jira\/software\/(?:c\/)?projects\/(?<projectKey>[A-Z][A-Z0-9]+)\/boards\/(?<boardId>\d+)/,
      fields: { projectKey: "projectKey", boardId: "boardId" },
    },
    {
      id: "jira-issue-selected",
      product: "jira",
      type: "issue",
      // …?selectedIssue={KEY}
      target: "pathAndSearch",
      regex: /[?&]selectedIssue=(?<issueKey>(?<projectKey>[A-Z][A-Z0-9]+)-\d+)/,
      fields: { issueKey: "issueKey", projectKey: "projectKey" },
    },
    // --- Confluence, query-param form (deliberately after the Jira patterns) ---
    {
      id: "confluence-page-pageid-query",
      product: "confluence",
      type: "page",
      // Legacy Cloud `?pageId={id}` and DC `/pages/viewpage.action?pageId={id}`
      // (with optional context path). The path must be Confluence-shaped
      // (`/wiki/`, `/pages/`, `/display/`, or `viewpage.action`) so a stray
      // `?pageId=` on a Jira URL (`/browse/…`, board URLs) never misclassifies;
      // ordering after the Jira patterns is the second line of defense.
      target: "pathAndSearch",
      regex: /(?:\/wiki\/|\/pages\/|\/display\/|viewpage\.action)[^?#]*[?&][^#]*?\bpageId=(?<pageId>\d+)/,
      fields: { pageId: "pageId" },
    },
  ],
};

/**
 * Extract a typed Atlassian entity from a URL.
 *
 * Returns `null` for non-matching or malformed input; never throws.
 *
 * @param url - Absolute URL string (e.g. from the browser tab).
 * @param registry - Optional pattern registry override; defaults to
 *   {@link DEFAULT_PATTERN_REGISTRY}. Lets the extension inject remote config.
 */
export function extractEntityFromUrl(
  url: string,
  registry: PatternRegistry = DEFAULT_PATTERN_REGISTRY
): AtlassianEntity | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const path = parsed.pathname;
  const pathAndSearch = `${parsed.pathname}${parsed.search}`;

  for (const pattern of registry.patterns) {
    const target = pattern.target === "pathAndSearch" ? pathAndSearch : path;
    const match = pattern.regex.exec(target);
    if (!match) continue;

    const groups = match.groups ?? {};
    const entity: Record<string, string> = {
      product: pattern.product,
      type: pattern.type,
    };
    let complete = true;
    for (const [field, group] of Object.entries(pattern.fields)) {
      const value = groups[group];
      if (value === undefined || value === "") {
        complete = false;
        break;
      }
      entity[field] = value;
    }
    if (!complete) continue;

    return entity as unknown as AtlassianEntity;
  }

  return null;
}
