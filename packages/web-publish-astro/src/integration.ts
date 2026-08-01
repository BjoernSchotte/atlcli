import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalPublicationJsonV1,
  negotiatePublicationExperienceV1,
  normalizePublicationRoutePrefixV1,
  planPublicationNavigationV1,
  type PublicationDesignTokenValidatorV1,
  type PublicationExperienceDescriptorV1,
  type PublicationExperienceSelectionV1,
  type PublicationOutputProfileV1,
  type PublicationBundleV1,
  type PublicationPageV1,
  validatePublicationOutputPathV1,
} from "@atlcli/web-publish";
import { readPublicationBundlePagesV1, type AtlcliPublicationLoaderOptionsV1 } from "./loader.js";
import { buildPagefindIndexV1 } from "./pagefind.js";

/** Directory owned by the static Pagefind post-build stage. */
export const PAGEFIND_OWNED_OUTPUT_PATH_PREFIX_V1 = "pagefind";
/** Neutral semantic regions a conforming search experience must expose. */
export const PUBLICATION_SEARCH_SEMANTIC_SLOTS_V1 = ["search-trigger", "search-modal", "main-content"] as const;

export interface AstroPublicationConfigExpectationV1 {
  /** The public URL base declared by the operator-owned Astro project. */
  base: string;
  /** The static output URL/file convention selected by the publication project. */
  outputProfile: PublicationOutputProfileV1;
  /** Optional canonical-site authority. Omit it only for intentionally non-public builds. */
  site?: string;
  /** Operator-owned public build directory, checked but never rewritten. */
  outDir: string;
  /** Operator-owned Astro public-assets directory, checked but never rewritten. */
  publicDir: string;
}

export interface AtlcliPublishingIntegrationOptionsV1 extends AtlcliPublicationLoaderOptionsV1 {
  /** A private JSON inventory path outside Astro's public output directory. */
  manifestPath: string;
  /** Route namespace owned by the publishing integration. */
  routePrefix: string;
  /** Explicit expectation for the operator-owned Astro configuration. */
  expectedConfig: AstroPublicationConfigExpectationV1;
  /**
   * Operator-owned Astro route component. It is optional because an existing
   * project may declare its route manually, and never comes from page content.
   */
  trustedLayoutEntrypoint?: string;
  /** Namespace for generated label landing routes. Defaults to `/topics`. */
  labelRoutePrefix?: string;
  /**
   * An already imported, operator-selected experience. The integration never
   * resolves a package name, path, or content-supplied module on its own.
   */
  experience?: {
    selection: PublicationExperienceSelectionV1;
    descriptor: unknown;
    tokenValidator: PublicationDesignTokenValidatorV1;
  };
}

/**
 * Minimal structural representation of Astro's stable integration hooks. It
 * intentionally avoids importing Astro's optional adapter type graph; the
 * returned object remains directly consumable by `integrations: [...]`.
 */
/** Structural subset of Astro's documented resolved configuration hook input. */
export interface ResolvedAstroPublishingConfigV1 {
  output: string;
  base: string;
  site?: URL;
  outDir: URL;
  publicDir: URL;
  build: { format: string };
  trailingSlash: string;
}

export interface AtlcliAstroPublishingIntegrationV1 {
  name: string;
  hooks: {
    "astro:config:setup"?(context: {
      injectRoute(route: {
        pattern: string;
        entrypoint: string;
        prerender: boolean;
      }): void;
      updateConfig(config: unknown): void;
    }): void;
    "astro:config:done"(context: {
      config: ResolvedAstroPublishingConfigV1;
    }): void;
    "astro:routes:resolved"(context: {
      routes: readonly { pathname?: string }[];
    }): Promise<void>;
    "astro:build:done"(context: {
      dir: URL;
      pages: readonly { pathname: string }[];
    }): Promise<void>;
  };
}

export type PublicationStaticPathV1 =
  | { params: { slug?: string }; props: { kind: "page"; sourceId: string } }
  | { params: { slug: string }; props: { kind: "label"; slug: string } };

export interface LoadedPublicationNavigationV1 {
  bundle: PublicationBundleV1;
  pages: readonly PublicationPageV1[];
  navigation: ReturnType<typeof planPublicationNavigationV1>;
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

function assertExpectedConfig(value: AstroPublicationConfigExpectationV1): void {
  assertNonEmptyPath(value.base, "expectedConfig.base");
  assertNonEmptyPath(value.outDir, "expectedConfig.outDir");
  assertNonEmptyPath(value.publicDir, "expectedConfig.publicDir");
  if (value.outputProfile !== "directory" && value.outputProfile !== "portable-file") {
    throw new TypeError("expectedConfig.outputProfile must be directory or portable-file");
  }
  if (value.site !== undefined) {
    try {
      const parsed = new URL(value.site);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new TypeError("expectedConfig.site must use http or https");
      }
    } catch (error) {
      if (error instanceof TypeError && error.message === "expectedConfig.site must use http or https") throw error;
      throw new TypeError("expectedConfig.site must be an absolute http(s) URL");
    }
  }
}

interface ValidatedExperienceV1 {
  id: string;
  version: string;
  digest: string;
  descriptor: PublicationExperienceDescriptorV1;
}

function validateInstalledExperience(
  value: AtlcliPublishingIntegrationOptionsV1["experience"],
): ValidatedExperienceV1 | undefined {
  if (value === undefined) return undefined;
  const negotiation = negotiatePublicationExperienceV1(
    value.selection,
    value.descriptor,
    value.tokenValidator,
  );
  if (!negotiation.compatible) {
    throw new Error(`atlcli publishing experience is incompatible: ${negotiation.issues.map((issue) => issue.message).join(" ")}`);
  }
  const descriptor = negotiation.descriptor;
  return {
    id: descriptor.id,
    version: descriptor.version,
    digest: createHash("sha256").update(canonicalPublicationJsonV1({
      descriptor,
      selection: value.selection,
    })).digest("hex"),
    descriptor,
  };
}

function assertResolvedAstroConfig(
  config: ResolvedAstroPublishingConfigV1,
  expected: AstroPublicationConfigExpectationV1,
): void {
  if (config.output !== "static") {
    throw new Error("atlcli publishing requires Astro static output");
  }
  const suppliedBase = expected.base.length > 1 && expected.base.endsWith("/")
    ? expected.base.slice(0, -1)
    : expected.base;
  const normalizedBase = normalizePublicationRoutePrefixV1(suppliedBase);
  // Astro's resolved config follows the selected URL profile: directory output
  // retains the non-root trailing slash, while portable-file output removes it.
  const expectedBase = normalizedBase === "/" ? "/" : expected.outputProfile === "directory"
    ? `${normalizedBase}/`
    : normalizedBase;
  if (config.base !== expectedBase) {
    throw new Error(`atlcli publishing base mismatch: expected ${expectedBase}, received ${config.base}`);
  }
  const profile = expected.outputProfile === "directory"
    ? { format: "directory", trailingSlash: "always" }
    : { format: "file", trailingSlash: "never" };
  if (config.build.format !== profile.format || config.trailingSlash !== profile.trailingSlash) {
    throw new Error(
      `atlcli publishing ${expected.outputProfile} profile requires build.format ${profile.format} and trailingSlash ${profile.trailingSlash}`,
    );
  }
  const expectedSite = expected.site === undefined ? undefined : new URL(expected.site).href;
  const actualSite = config.site?.href;
  if (actualSite !== expectedSite) {
    throw new Error(`atlcli publishing site mismatch: expected ${expectedSite ?? "undefined"}, received ${actualSite ?? "undefined"}`);
  }
  const expectedOutDir = resolve(expected.outDir);
  const expectedPublicDir = resolve(expected.publicDir);
  const actualOutDir = resolve(fileURLToPath(config.outDir));
  const actualPublicDir = resolve(fileURLToPath(config.publicDir));
  if (actualOutDir !== expectedOutDir) {
    throw new Error(`atlcli publishing outDir mismatch: expected ${expectedOutDir}, received ${actualOutDir}`);
  }
  if (actualPublicDir !== expectedPublicDir) {
    throw new Error(`atlcli publishing publicDir mismatch: expected ${expectedPublicDir}, received ${actualPublicDir}`);
  }
}

/** Convert a canonical logical bundle route to a namespace-owned Astro route. */
export function publicationRoutePathV1(route: string, routePrefix: string): string {
  const prefix = normalizePublicationRoutePrefixV1(routePrefix);
  if (route === "/") return prefix;
  return `${prefix}${route}`.replace(/\/$/u, "");
}

/**
 * Static path records for an operator-owned `[...slug].astro` route. The
 * immutable source ID is the sole prop; the component loads its structured
 * collection entry by this ID rather than trusting a URL as page identity.
 */
export async function readPublicationNavigationV1(
  options: AtlcliPublicationLoaderOptionsV1 & { labelRoutePrefix?: string },
): Promise<LoadedPublicationNavigationV1> {
  const loaded = await readPublicationBundlePagesV1(options);
  return {
    ...loaded,
    navigation: planPublicationNavigationV1({
      pages: loaded.pages,
      rootIds: loaded.bundle.rootIds,
      ...(options.labelRoutePrefix === undefined ? {} : { labelRoutePrefix: options.labelRoutePrefix }),
    }),
  };
}

function staticSlug(route: string): string | undefined {
  return route === "/" ? undefined : route.slice(1).replace(/\/$/u, "");
}

function routeKey(pathname: string): string {
  return pathname.replace(/^\/+|\/+$/gu, "");
}

/**
 * Static path records for the operator-owned catch-all route. Every record is
 * identity-first: a page uses its immutable source ID and a label uses its
 * collision-checked planner slug, never a source-derived route lookup.
 */
export async function publicationStaticPathsV1(
  options: AtlcliPublicationLoaderOptionsV1 & { labelRoutePrefix?: string },
): Promise<readonly PublicationStaticPathV1[]> {
  const { pages, navigation } = await readPublicationNavigationV1(options);
  return [
    ...pages.map((page): PublicationStaticPathV1 => {
      const slug = staticSlug(page.route);
      return {
        params: slug === undefined ? {} : { slug },
        props: { kind: "page", sourceId: page.sourceId },
      };
    }),
    ...navigation.labels.map((label): PublicationStaticPathV1 => ({
      params: { slug: staticSlug(label.route)! },
      props: { kind: "label", slug: label.slug },
    })),
  ];
}

async function inventory(root: string): Promise<readonly OutputFileV1[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new TypeError(`Astro output contains a non-regular entry: ${absolute}`);
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

function assetPath(bundlePath: string, relativeAssetPath: string): string {
  const root = resolve(dirname(bundlePath));
  const normalized = validatePublicationOutputPathV1(relativeAssetPath);
  const candidate = resolve(root, normalized);
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith("../")) {
    throw new TypeError(`publication asset path escapes bundle directory: ${relativeAssetPath}`);
  }
  return candidate;
}

async function digestRegularFile(path: string, expectedByteLength: number): Promise<string> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new TypeError(`publication asset is not a regular file: ${path}`);
  if (before.size !== expectedByteLength) throw new TypeError(`publication asset has an unexpected byte length: ${path}`);
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    byteLength += chunk.byteLength;
    if (byteLength > expectedByteLength) {
      throw new TypeError(`publication asset grew while it was read: ${path}`);
    }
    hash.update(chunk);
  }
  const after = await lstat(path);
  if (
    byteLength !== expectedByteLength ||
    after.isSymbolicLink() || !after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs
  ) {
    throw new TypeError(`publication asset changed while it was read: ${path}`);
  }
  return hash.digest("hex");
}

async function ensureOutputParents(outputRoot: string, path: string): Promise<void> {
  const root = await lstat(outputRoot);
  if (root.isSymbolicLink() || !root.isDirectory()) throw new TypeError("Astro output root must be a real directory");
  let current = outputRoot;
  for (const segment of validatePublicationOutputPathV1(path).split("/").slice(0, -1)) {
    current = resolve(current, segment);
    try {
      const state = await lstat(current);
      if (state.isSymbolicLink() || !state.isDirectory()) {
        throw new TypeError(`publication asset output parent is not a real directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
}

/**
 * Copy only verified content-addressed bundle assets into an Astro candidate.
 * Existing output files are a collision, never an overwrite of project public
 * data. On a failed batch, only files created by this invocation are removed.
 */
async function materializePublicationAssets(
  bundlePath: string,
  outputRoot: string,
  assets: readonly { path: string; sha256: string; byteLength: number }[],
): Promise<void> {
  const written: string[] = [];
  const seen = new Set<string>();
  try {
    for (const asset of assets) {
      const relativeAssetPath = validatePublicationOutputPathV1(asset.path);
      if (!seen.add(relativeAssetPath)) throw new TypeError(`duplicate publication asset output path: ${relativeAssetPath}`);
      const source = assetPath(bundlePath, relativeAssetPath);
      if (await digestRegularFile(source, asset.byteLength) !== asset.sha256) {
        throw new TypeError(`publication asset digest does not match bundle entry: ${relativeAssetPath}`);
      }
      await ensureOutputParents(outputRoot, relativeAssetPath);
      const destination = resolve(outputRoot, relativeAssetPath);
      try {
        await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new TypeError(`publication asset output collides with existing Astro output: ${relativeAssetPath}`);
        }
        throw error;
      }
      written.push(destination);
      if (await digestRegularFile(destination, asset.byteLength) !== asset.sha256) {
        throw new TypeError(`copied publication asset digest does not match bundle entry: ${relativeAssetPath}`);
      }
    }
  } catch (error) {
    await Promise.all(written.map(async (path) => { await unlink(path).catch(() => undefined); }));
    throw error;
  }
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
  assertExpectedConfig(options.expectedConfig);
  const installedExperience = validateInstalledExperience(options.experience);
  const routePrefix = normalizePublicationRoutePrefixV1(options.routePrefix);
  if (
    options.trustedLayoutEntrypoint !== undefined &&
    (typeof options.trustedLayoutEntrypoint !== "string" || options.trustedLayoutEntrypoint.length === 0)
  ) {
    throw new TypeError("trustedLayoutEntrypoint must be a non-empty string when configured");
  }
  let routeInventory: readonly {
    pathname?: string;
  }[] = [];

  return {
    name: "atlcli-publishing",
    hooks: {
      "astro:config:setup": ({ injectRoute, updateConfig }: {
        injectRoute(route: { pattern: string; entrypoint: string; prerender: boolean }): void;
        updateConfig(config: unknown): void;
      }) => {
        // The virtual module contains only an operator-configured absolute path.
        // It is consumed during the Node build and never copied into published
        // page data or static output.
        updateConfig({
          vite: {
            plugins: [{
              name: "atlcli-publication-bundle-path",
              resolveId(id: string) {
                return id === "virtual:atlcli-publication" ? "\0virtual:atlcli-publication" : undefined;
              },
              load(id: string) {
                return id === "\0virtual:atlcli-publication"
                  ? [
                    `export const bundlePath = ${JSON.stringify(resolve(options.bundlePath))};`,
                    `export const labelRoutePrefix = ${JSON.stringify(options.labelRoutePrefix)};`,
                  ].join("\n")
                  : undefined;
              },
            }],
          },
        });
        if (options.trustedLayoutEntrypoint !== undefined) {
          injectRoute({
            pattern: `${routePrefix}/[...slug]`,
            entrypoint: options.trustedLayoutEntrypoint,
            prerender: true,
          });
        }
      },
      "astro:config:done": ({ config }) => assertResolvedAstroConfig(config, options.expectedConfig),
      "astro:routes:resolved": async ({ routes }) => {
        const { pages, navigation } = await readPublicationNavigationV1(options);
        const publicationRoutes = new Set([
          ...pages.map((page) => publicationRoutePathV1(page.route, routePrefix)),
          ...navigation.labels.map((label) => publicationRoutePathV1(label.route, routePrefix)),
        ]);
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
        const loaded = await readPublicationNavigationV1(options);
        const sourceByRoute = new Map(loaded.pages.map((page) => [
          routeKey(publicationRoutePathV1(page.route, routePrefix)),
          { kind: "page" as const, sourceId: page.sourceId, route: page.route },
        ]));
        const labelByRoute = new Map(loaded.navigation.labels.map((label) => [
          routeKey(publicationRoutePathV1(label.route, routePrefix)),
          { kind: "label" as const, label: label.label, slug: label.slug, route: label.route, sourceIds: label.sourceIds },
        ]));
        const builtRoutes = pages.map((page) => {
          const normalizedPathname = routeKey(page.pathname);
          const source = sourceByRoute.get(normalizedPathname) ?? labelByRoute.get(normalizedPathname);
          if (source === undefined) {
            throw new Error(`Astro built an unexplained publication page: ${page.pathname}`);
          }
          return { ...source, pathname: page.pathname };
        }).sort((left, right) => left.route.localeCompare(right.route));
        const builtSourcePages = builtRoutes.filter((page) => page.kind === "page");
        const builtLabelLandings = builtRoutes.filter((page) => page.kind === "label");
        if (builtSourcePages.length !== loaded.pages.length || builtLabelLandings.length !== loaded.navigation.labels.length) {
          throw new Error("Astro did not build exactly one route for every publication page and label landing");
        }
        await materializePublicationAssets(options.bundlePath, outputRoot, loaded.bundle.assets);
        await buildPagefindIndexV1({
          outputDirectory: outputRoot,
          pageOutputPaths: builtRoutes.map((page) => {
            const stem = page.pathname.replace(/^\/+|\/+$/gu, "");
            return options.expectedConfig.outputProfile === "directory"
              ? `${stem}/index.html`
              : `${stem}.html`;
          }),
        });
        await writePrivateJson(manifestPath, {
          schema: "atlcli.astro-build-inventory/1",
          bundlePath: "<private>",
          outputRoot: "<private>",
          bundleDigest: loaded.bundle.bundleDigest,
          ...(installedExperience === undefined ? {} : {
            experience: {
              id: installedExperience.id,
              version: installedExperience.version,
              digest: installedExperience.digest,
            },
          }),
          pages: builtSourcePages,
          labelLandings: builtLabelLandings,
          routes: routeInventory,
          output: await inventory(outputRoot),
        });
      },
    },
  };
}
