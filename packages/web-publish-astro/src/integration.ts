import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePublicationRoutePrefixV1 } from "@atlcli/web-publish";
import { readPublicationBundlePagesV1, type AtlcliPublicationLoaderOptionsV1 } from "./loader.js";

export interface AtlcliPublishingIntegrationOptionsV1 extends AtlcliPublicationLoaderOptionsV1 {
  /** A private JSON inventory path outside Astro's public output directory. */
  manifestPath: string;
  /** Route namespace owned by the publishing integration. */
  routePrefix: string;
}

/**
 * Minimal structural representation of Astro's stable integration hooks. It
 * intentionally avoids importing Astro's optional adapter type graph; the
 * returned object remains directly consumable by `integrations: [...]`.
 */
export interface AtlcliAstroPublishingIntegrationV1 {
  name: string;
  hooks: {
    "astro:config:done"(context: { config: { output: string } }): void;
    "astro:routes:resolved"(context: {
      routes: readonly { pathname?: string }[];
    }): Promise<void>;
    "astro:build:done"(context: {
      dir: URL;
      pages: readonly { pathname: string }[];
    }): Promise<void>;
  };
}

interface OutputFileV1 {
  path: string;
  byteLength: number;
  sha256: string;
}

function assertNonEmptyPath(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

/** Convert a canonical logical bundle route to a namespace-owned Astro route. */
export function publicationRoutePathV1(route: string, routePrefix: string): string {
  const prefix = normalizePublicationRoutePrefixV1(routePrefix);
  if (route === "/") return prefix;
  return `${prefix}${route}`.replace(/\/$/u, "");
}

async function inventory(root: string): Promise<readonly OutputFileV1[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  await walk(root);
  return Promise.all(files.sort().map(async (absolute) => {
    const bytes = await readFile(absolute);
    return {
      path: relative(root, absolute).replaceAll("\\", "/"),
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }));
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
}

/**
 * Documented-hook-only Astro integration. It owns no routes or page renderer:
 * a selected trusted experience supplies those, while this integration validates
 * the immutable data boundary and records the static output inventory.
 */
export function atlcliPublishingIntegration(
  options: AtlcliPublishingIntegrationOptionsV1,
): AtlcliAstroPublishingIntegrationV1 {
  assertNonEmptyPath(options.bundlePath, "bundlePath");
  assertNonEmptyPath(options.manifestPath, "manifestPath");
  const routePrefix = normalizePublicationRoutePrefixV1(options.routePrefix);
  let routeInventory: readonly {
    pathname?: string;
  }[] = [];

  return {
    name: "atlcli-publishing",
    hooks: {
      "astro:config:done": ({ config }) => {
        if (config.output !== "static") {
          throw new Error("atlcli publishing requires Astro static output");
        }
      },
      "astro:routes:resolved": async ({ routes }) => {
        const { pages } = await readPublicationBundlePagesV1(options);
        const publicationRoutes = new Set(pages.map((page) => publicationRoutePathV1(page.route, routePrefix)));
        const collisions = routes
          .filter((route) => route.pathname !== undefined && publicationRoutes.has(route.pathname))
          .map((route) => route.pathname!)
          .sort();
        if (collisions.length > 0) {
          throw new Error(`publication route collision: ${[...new Set(collisions)].join(", ")}`);
        }
        routeInventory = routes.map((route) =>
          route.pathname === undefined ? {} : { pathname: route.pathname },
        );
      },
      "astro:build:done": async ({ dir, pages }) => {
        const outputRoot = fileURLToPath(dir);
        const manifestPath = resolve(options.manifestPath);
        const outputRelative = relative(outputRoot, manifestPath);
        if (outputRelative === "" || (!outputRelative.startsWith("..") && !outputRelative.startsWith("/"))) {
          throw new Error("atlcli publishing manifestPath must be outside Astro's public output directory");
        }
        await writePrivateJson(manifestPath, {
          schema: "atlcli.astro-build-inventory/1",
          bundlePath: "<private>",
          outputRoot: "<private>",
          pages: pages.map((page) => page.pathname).sort(),
          routes: routeInventory,
          output: await inventory(outputRoot),
        });
      },
    },
  };
}
