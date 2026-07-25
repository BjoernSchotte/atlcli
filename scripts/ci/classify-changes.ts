/**
 * Conservative CI routing for GitHub Actions.
 *
 * Documentation-only changes may skip product gates. Anything unknown, global,
 * or workflow-related fails open and runs every gate. Keep this module pure so
 * path policy changes are reviewable and covered by unit tests.
 */

export interface CiRoutes {
  code: boolean;
  consumer: boolean;
  docs: boolean;
  readmeMedia: boolean;
}

const SITE_DOC_PREFIXES = ["src/content/", "src/components/", "src/styles/", "public/"];
const SITE_DOC_FILES = new Set(["astro.config.mjs", "src/content.config.ts", "tsconfig.docs.json"]);
const GLOBAL_FILES = new Set(["package.json", "bun.lock", "turbo.json", "tsconfig.json"]);
const DOCUMENTATION_PREFIXES = ["docs/", "spec/", "specs/", ".github/ISSUE_TEMPLATE/"];
const DOCUMENTATION_FILES = new Set(["README.md", "CHANGELOG.md", "LICENSE", "NOTICE", ".impeccable.md"]);
const README_MEDIA_PREFIX = "assets/readme/";
const PRODUCT_PREFIXES = ["apps/", "packages/", "patches/", "plugins/", "scripts/", "services/"];

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
  return SITE_DOC_FILES.has(path) || startsWithAny(path, SITE_DOC_PREFIXES) || GLOBAL_FILES.has(path);
}

function affectsConsumers(path: string): boolean {
  return (
    startsWithAny(path, ["packages/", "patches/", "scripts/"]) ||
    GLOBAL_FILES.has(path) ||
    path === ".github/workflows/ci.yml" ||
    path === ".github/workflows/consumer-smoke.yml" ||
    path === ".github/workflows/reusable-consumer-smoke.yml"
  );
}

export function classifyChanges(paths: readonly string[], full = false): CiRoutes {
  if (full || paths.length === 0) {
    return { code: true, consumer: true, docs: true, readmeMedia: true };
  }

  const routes: CiRoutes = { code: false, consumer: false, docs: false, readmeMedia: false };
  for (const rawPath of paths) {
    const path = normalized(rawPath);
    if (!path) continue;

    if (path.startsWith(".github/workflows/")) {
      return { code: true, consumer: true, docs: true, readmeMedia: true };
    }

    if (path === "README.md" || path.startsWith(README_MEDIA_PREFIX)) routes.readmeMedia = true;
    if (affectsSiteDocs(path)) routes.docs = true;
    if (affectsConsumers(path)) routes.consumer = true;

    if (GLOBAL_FILES.has(path) || startsWithAny(path, PRODUCT_PREFIXES)) {
      routes.code = true;
      continue;
    }

    if (affectsSiteDocs(path) || isDocumentationOnly(path)) continue;

    // Unknown paths are deliberately fail-open. A new top-level build surface
    // must receive full CI until this policy explicitly classifies it.
    return { code: true, consumer: true, docs: true, readmeMedia: true };
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
