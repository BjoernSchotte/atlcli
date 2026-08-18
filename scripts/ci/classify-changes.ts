/**
 * Conservative CI routing for GitHub Actions.
 *
 * Documentation-only changes may skip product gates. Anything unknown, global,
 * or workflow-related fails open and runs every gate. Capability closures are
 * explicit so an unrelated product surface does not silently acquire an
 * expensive platform gate merely because it lives below `packages/`.
 */

export interface CiRoutes {
  /** Compatibility aggregate for callers that have not adopted granular routes. */
  code: boolean;
  /** Compatibility aggregate for the pinned package-consumer gate. */
  consumer: boolean;
  staticQuality: boolean;
  unitTests: boolean;
  packageContracts: boolean;
  astroPublishing: boolean;
  astroPlatform: boolean;
  pdfPlatform: boolean;
  browserHarness: boolean;
  docs: boolean;
  readmeMedia: boolean;
  researchPrivacy: boolean;
}

const SITE_DOC_PREFIXES = ["src/content/", "src/components/", "src/styles/", "public/"];
const SITE_DOC_FILES = new Set(["astro.config.mjs", "src/content.config.ts", "tsconfig.docs.json"]);
const GLOBAL_FILES = new Set(["package.json", "bun.lock", "turbo.json", "tsconfig.json"]);
const DOCUMENTATION_PREFIXES = ["docs/", "spec/", "specs/", ".github/ISSUE_TEMPLATE/"];
const DOCUMENTATION_FILES = new Set(["README.md", "CHANGELOG.md", "LICENSE", "NOTICE", ".impeccable.md"]);
const README_MEDIA_PREFIX = "assets/readme/";
const PRODUCT_PREFIXES = ["apps/", "packages/", "patches/", "plugins/", "scripts/", "services/"];

/** Transitive workspace inputs of the three Astro publishing packages. */
const ASTRO_PACKAGE_PREFIXES = [
  "packages/confluence/",
  "packages/core/",
  "packages/export-blocks/",
  "packages/export-blocks-astro/",
  "packages/export-charts-tanstack/",
  "packages/export-macros/",
  "packages/web-publish/",
  "packages/web-publish-astro/",
  "packages/web-publish-starlight/",
];

/** Transitive workspace inputs of the PDF/compiler/template platform surface. */
const PDF_PACKAGE_PREFIXES = [
  "packages/code-highlight/",
  "packages/confluence/",
  "packages/core/",
  "packages/diagram/",
  "packages/docx/",
  "packages/docx-template-intake/",
  "packages/export-blocks/",
  "packages/export-charts-tanstack/",
  "packages/export-fixtures/",
  "packages/export-jobs/",
  "packages/export-macros/",
  "packages/export-media/",
  "packages/export-node/",
  "packages/export-wiring/",
  "packages/pdf/",
  "packages/pdf-compiler-browser/",
  "packages/pdf-template-authoring/",
  "packages/template-pack/",
];

/** Transitive workspace inputs of the extension and browser export harness. */
const BROWSER_PACKAGE_PREFIXES = [
  "packages/action-palette-react/",
  "packages/action-registry/",
  "packages/code-highlight/",
  "packages/confluence/",
  "packages/core/",
  "packages/diagram/",
  "packages/docx/",
  "packages/docx-template-intake/",
  "packages/export-blocks/",
  "packages/export-charts-tanstack/",
  "packages/export-fixtures/",
  "packages/export-jobs/",
  "packages/export-macros/",
  "packages/export-media/",
  "packages/export-wiring/",
  "packages/jira/",
  "packages/pdf/",
  "packages/pdf-compiler-browser/",
  "packages/pdf-template-authoring/",
  "packages/research/",
  "packages/template-pack/",
  "packages/web-publish/",
];

function noRoutes(): CiRoutes {
  return {
    code: false,
    consumer: false,
    staticQuality: false,
    unitTests: false,
    packageContracts: false,
    astroPublishing: false,
    astroPlatform: false,
    pdfPlatform: false,
    browserHarness: false,
    docs: false,
    readmeMedia: false,
    researchPrivacy: false,
  };
}

function allRoutes(): CiRoutes {
  return Object.fromEntries(
    Object.keys(noRoutes()).map((name) => [name, true]),
  ) as unknown as CiRoutes;
}

function normalized(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function startsWithAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

function isDocumentationOnly(path: string): boolean {
  if (
    DOCUMENTATION_FILES.has(path) ||
    path.startsWith(README_MEDIA_PREFIX) ||
    startsWithAny(path, DOCUMENTATION_PREFIXES)
  ) {
    return true;
  }
  return path.endsWith(".md") && !startsWithAny(path, PRODUCT_PREFIXES);
}

function affectsSiteDocs(path: string): boolean {
  return SITE_DOC_FILES.has(path) || startsWithAny(path, SITE_DOC_PREFIXES);
}

function affectsConsumers(path: string): boolean {
  return startsWithAny(path, ["packages/", "patches/", "scripts/"]);
}

function enableProductQuality(routes: CiRoutes): void {
  routes.code = true;
  routes.staticQuality = true;
  routes.unitTests = true;
}

function enablePackageContracts(routes: CiRoutes): void {
  routes.consumer = true;
  routes.packageContracts = true;
}

function enableAstro(routes: CiRoutes): void {
  routes.astroPublishing = true;
  routes.astroPlatform = true;
}

function enableEveryProductCapability(routes: CiRoutes): void {
  enableProductQuality(routes);
  enablePackageContracts(routes);
  enableAstro(routes);
  routes.pdfPlatform = true;
  routes.browserHarness = true;
}

function classifyProductCapability(path: string, routes: CiRoutes): void {
  enableProductQuality(routes);
  if (affectsConsumers(path)) enablePackageContracts(routes);

  if (startsWithAny(path, ASTRO_PACKAGE_PREFIXES)) enableAstro(routes);
  if (startsWithAny(path, PDF_PACKAGE_PREFIXES)) routes.pdfPlatform = true;
  if (startsWithAny(path, BROWSER_PACKAGE_PREFIXES)) routes.browserHarness = true;

  if (path.startsWith("apps/extension/") || path.startsWith("apps/browser-export-harness/")) {
    routes.browserHarness = true;
  }
  if (
    path.startsWith("apps/cli/src/commands/export-pdf") ||
    path.startsWith("apps/cli/src/commands/export-rasterizer") ||
    path.startsWith("apps/cli/build") ||
    path === "apps/cli/package.json" ||
    path === "apps/cli/turbo.json"
  ) {
    routes.pdfPlatform = true;
  }

  // Dependency patches can affect any runtime even when their package name is
  // not represented by a workspace directory.
  if (path.startsWith("patches/")) {
    enableEveryProductCapability(routes);
  }

  // CI orchestration changes must exercise every candidate capability. Other
  // scripts stay on static/unit/package proof unless they own a named surface.
  if (path.startsWith("scripts/ci/")) {
    enableEveryProductCapability(routes);
  }
  if (
    path.startsWith("scripts/check-browser-build") ||
    path.startsWith("scripts/clean-browser-artifacts")
  ) {
    routes.browserHarness = true;
  }
  if (path.startsWith("scripts/verapdf/")) routes.pdfPlatform = true;
}

export function classifyChanges(paths: readonly string[], full = false): CiRoutes {
  if (full || paths.length === 0) return allRoutes();

  const routes = noRoutes();
  for (const rawPath of paths) {
    const path = normalized(rawPath);
    if (!path) continue;

    // The privacy scanner protects the complete tracked tree, so every real
    // change receives the lightweight gate irrespective of its product route.
    routes.researchPrivacy = true;

    if (path.startsWith(".github/workflows/") || GLOBAL_FILES.has(path)) {
      return allRoutes();
    }

    if (path === "README.md" || path.startsWith(README_MEDIA_PREFIX)) {
      routes.readmeMedia = true;
    }
    if (affectsSiteDocs(path)) routes.docs = true;

    if (startsWithAny(path, PRODUCT_PREFIXES)) {
      classifyProductCapability(path, routes);
      continue;
    }

    if (affectsSiteDocs(path) || isDocumentationOnly(path)) continue;

    // Unknown paths are deliberately fail-open. A new top-level build surface
    // must receive full CI until this policy explicitly classifies it.
    return allRoutes();
  }

  return routes;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const separator = args.has("--null") ? "\0" : "\n";
  const input = await Bun.stdin.text();
  const paths = input
    .split(separator)
    .map(normalized)
    .filter(Boolean);
  const routes = classifyChanges(paths, args.has("--full"));

  for (const [name, enabled] of Object.entries(routes)) {
    process.stdout.write(`${name}=${enabled}\n`);
  }
}

if (import.meta.main) await main();
