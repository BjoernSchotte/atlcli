import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readT0PublicationBundle } from "./loader.mjs";
export { trustedAnalyticsConfig, trustedConfluenceAction } from "./loader.mjs";

export function publicationRoutePath(page, routePrefix = "/publish", defaultLocale = "en") {
  const route = typeof page === "string" ? page : page.route;
  const locale = typeof page === "string" ? defaultLocale : page.locale;
  const prefix = `/${routePrefix.split("/").filter(Boolean).join("/")}`;
  if (locale === defaultLocale) {
    if (route === "/") return prefix;
    return `${prefix}${route}`.replace(/\/$/u, "");
  }
  const localePrefix = `/${locale}`;
  const localizedRoute = route === localePrefix ? "/" : route.startsWith(`${localePrefix}/`)
    ? route.slice(localePrefix.length)
    : route;
  if (localizedRoute === "/") return `${localePrefix}${prefix}`;
  return `${localePrefix}${prefix}${localizedRoute}`.replace(/\/$/u, "");
}

export function findRouteCollisions(sourceRoutes, resolvedRoutes, routePrefix = "/publish") {
  const owned = new Set(sourceRoutes.map((page) => publicationRoutePath(page, routePrefix)));
  const collisions = [];
  for (const route of resolvedRoutes) {
    if (typeof route.pathname !== "string") continue;
    const pathname = route.pathname === "/" ? "/" : route.pathname.replace(/\/$/u, "");
    if (owned.has(pathname)) collisions.push(pathname);
  }
  return [...new Set(collisions)].sort();
}

export async function loadT0PublicationBundle(bundlePath) {
  return readT0PublicationBundle(bundlePath);
}

async function inventory(root) {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  await walk(root);
  const records = [];
  for (const absolute of files.sort()) {
    const bytes = await readFile(absolute);
    records.push({
      path: relative(root, absolute).split("\\").join("/"),
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return records;
}

export function publicationIntegration({ bundlePath, manifestPath, routePrefix = "/publish" }) {
  let resolvedRouteInventory = [];
  return {
    name: "atlcli-t0-publication-integration",
    hooks: {
      "astro:config:done": ({ config }) => {
        if (config.output !== "static") throw new Error("T0 publication requires Astro static output");
        if (config.base.replace(/\/$/u, "") !== "/docs") {
          throw new Error(`T0 nested-base proof requires /docs, received ${config.base}`);
        }
      },
      "astro:routes:resolved": async ({ routes }) => {
        const bundle = await readT0PublicationBundle(bundlePath);
        const collisions = findRouteCollisions(bundle.pages, routes, routePrefix);
        if (collisions.length > 0) {
          throw new Error(`publication route collision: ${collisions.join(", ")}`);
        }
        resolvedRouteInventory = routes.map((route) => ({
          component: route.component,
          pathname: route.pathname,
          prerender: route.prerender,
          type: route.type,
        }));
      },
      "astro:build:done": async ({ dir, pages }) => {
        const outputRoot = fileURLToPath(dir);
        const output = await inventory(outputRoot);
        const manifest = {
          schema: "atlcli.astro-build-hook-manifest/1-t0",
          outputRoot: "<private>",
          pages: pages.map((page) => page.pathname).sort(),
          routes: resolvedRouteInventory,
          output,
        };
        await mkdir(dirname(manifestPath), { recursive: true });
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "w" });
      },
    },
  };
}
