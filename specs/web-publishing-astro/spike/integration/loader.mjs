import { readFile } from "node:fs/promises";

function assertString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

export async function readT0PublicationBundle(bundlePath) {
  const parsed = JSON.parse(await readFile(bundlePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || parsed.schema !== "atlcli.publication-bundle/1-t0") {
    throw new TypeError("unsupported T0 publication bundle schema");
  }
  assertString(parsed.revision, "revision");
  if (!Array.isArray(parsed.providerOrigins)) throw new TypeError("providerOrigins must be an array");
  for (const [index, origin] of parsed.providerOrigins.entries()) {
    assertString(origin, `providerOrigins[${index}]`);
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.origin !== origin || !["http:", "https:"].includes(parsedOrigin.protocol)) {
      throw new TypeError(`providerOrigins[${index}] must be a canonical HTTP(S) origin`);
    }
  }
  if (!Array.isArray(parsed.pages)) throw new TypeError("pages must be an array");
  const ids = new Set();
  const routes = new Set();
  for (const [index, page] of parsed.pages.entries()) {
    if (!page || typeof page !== "object" || Array.isArray(page)) {
      throw new TypeError(`pages[${index}] must be an object`);
    }
    assertString(page.id, `pages[${index}].id`);
    assertString(page.route, `pages[${index}].route`);
    assertString(page.title, `pages[${index}].title`);
    if (!/^\/(?:[a-z0-9][a-z0-9-]*\/)*[a-z0-9][a-z0-9-]*\/?$|^\/$/u.test(page.route)) {
      throw new TypeError(`pages[${index}].route is not canonical`);
    }
    if (ids.has(page.id)) throw new TypeError(`duplicate page id ${page.id}`);
    if (routes.has(page.route)) throw new TypeError(`duplicate page route ${page.route}`);
    ids.add(page.id);
    routes.add(page.route);
    if (!Array.isArray(page.blocks)) throw new TypeError(`pages[${index}].blocks must be an array`);
  }
  return parsed;
}

export function trustedConfluenceAction(relation, providerOrigins) {
  if (!relation || typeof relation !== "object" || !["edit", "webui"].includes(relation.kind)) return undefined;
  if (typeof relation.href !== "string" || relation.href.length === 0 || relation.href.length > 2048) return undefined;
  try {
    const url = new URL(relation.href);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    if (!providerOrigins.includes(url.origin)) return undefined;
    return {
      href: url.href,
      label: relation.kind === "edit" ? "Edit in Confluence" : "Open in Confluence",
    };
  } catch {
    return undefined;
  }
}

export function trustedAnalyticsConfig(config, allowedOrigins) {
  if (!config || typeof config !== "object") return undefined;
  if (typeof config.domain !== "string" || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(config.domain)) {
    return undefined;
  }
  if (typeof config.endpoint !== "string" || config.endpoint.length > 2048) return undefined;
  try {
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return undefined;
    if (!allowedOrigins.includes(endpoint.origin) || endpoint.pathname !== "/api/event") return undefined;
    return { domain: config.domain, endpoint: endpoint.href };
  } catch {
    return undefined;
  }
}

export function publicationLoader({ bundlePath }) {
  return {
    name: "atlcli-t0-publication-loader",
    async load({ store, parseData, logger }) {
      const bundle = await readT0PublicationBundle(bundlePath);
      store.clear();
      for (const page of bundle.pages) {
        const action = trustedConfluenceAction(page.editRelation, bundle.providerOrigins);
        const data = await parseData({
          id: page.id,
          data: {
            ...page,
            editLabel: action?.label,
            editUrl: action?.href,
          },
        });
        store.set({ id: page.id, data });
      }
      logger.info(`loaded ${bundle.pages.length} structured publication pages (${bundle.revision})`);
    },
  };
}
