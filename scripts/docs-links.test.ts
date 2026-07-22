/**
 * Every internal docs link resolves — to a real page, and to a real heading.
 *
 * Docs are first-class here (CLAUDE.md): docs land in the same PR as the feature
 * and cross-link heavily ("Related topics" on every page is a house rule). That
 * makes a stale link the most likely docs defect and the least likely to be
 * noticed: Astro/Starlight build a broken `#anchor` without complaint, and the
 * reader lands at the top of the page instead of the section they were sent to.
 *
 * `#the-bundled-default-template-engine-ts` was wrong on four lines of
 * `confluence/export.md` from the commit that introduced the section until this
 * test was written, because nothing checked. The real slug is
 * `the-bundled-default-template---engine-ts` — the `(--engine ts)` in the
 * heading contributes three hyphens, which is exactly the kind of detail a
 * human writing a cross-reference gets wrong and a machine never does.
 *
 * This runs over the SOURCE markdown, not a built site, so it needs no
 * `astro build` and fails in the ordinary `bun run test` loop. Heading ids are
 * computed with the same `github-slugger` Astro's `rehype-slug` uses; the
 * agreement is not assumed but demonstrated — see the `docs/` corpus assertions
 * below, which would light up everywhere if the two disagreed.
 */
import { describe, expect, it } from "bun:test";
import GithubSlugger from "github-slugger";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, relative, resolve } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS_ROOT = join(REPO_ROOT, "src", "content", "docs");

interface DocPage {
  /** Absolute path of the source file. */
  file: string;
  /** Route the file is served at, always with a trailing slash (`/confluence/export/`). */
  route: string;
  /** Heading ids on the page. */
  anchors: Set<string>;
  /** Raw text, for link extraction. */
  text: string;
}

async function markdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await markdownFiles(full)));
    else if (/\.mdx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** `docs/confluence/export.md` → `/confluence/export/`; `docs/index.mdx` → `/`. */
function routeOf(file: string): string {
  const rel = relative(DOCS_ROOT, file).replace(/\\/g, "/").replace(/\.mdx?$/, "");
  const withoutIndex = rel === "index" ? "" : rel.replace(/(^|\/)index$/, "");
  return `/${withoutIndex}${withoutIndex ? "/" : ""}`;
}

/**
 * Heading ids, skipping fenced code blocks.
 *
 * The skip is load-bearing, not defensive: the docs are full of shell examples
 * whose comments start with `#`, and counting `# Fail the build on any warning`
 * as a heading would invent anchors that do not exist and hide ones that do
 * (github-slugger de-duplicates by appending `-1`, so one phantom heading can
 * silently renumber a later real one).
 */
function anchorsOf(text: string): Set<string> {
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  let inFence = false;
  let fence = "";
  for (const line of text.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!inFence) {
        inFence = true;
        fence = marker[0]!;
      } else if (marker[0] === fence) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!heading) continue;
    anchors.add(slugger.slug(stripInlineMarkup(heading[2]!)));
  }
  return anchors;
}

/** What rehype-slug sees: the heading's rendered TEXT, not its markdown source. */
function stripInlineMarkup(heading: string): string {
  return heading
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_)/g, "");
}

/** Links worth checking: markdown destinations plus raw `href="…"`. */
function linksOf(text: string): string[] {
  const links: string[] = [];
  let inFence = false;
  let fence = "";
  for (const line of text.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!inFence) {
        inFence = true;
        fence = marker[0]!;
      } else if (marker[0] === fence) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    // Strip inline code so a `--flag` example cannot look like a destination.
    const clean = line.replace(/`[^`]*`/g, "");
    for (const m of clean.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) links.push(m[1]!);
    for (const m of clean.matchAll(/href="([^"]+)"/g)) links.push(m[1]!);
  }
  return links;
}

const EXTERNAL = /^(https?:|mailto:|tel:|#!|data:)/;

const pages: DocPage[] = await Promise.all(
  (await markdownFiles(DOCS_ROOT)).map(async (file) => {
    const text = await readFile(file, "utf8");
    return { file, route: routeOf(file), anchors: anchorsOf(text), text };
  })
);

const byRoute = new Map(pages.map((p) => [p.route, p]));

/** Resolve a link to `{ page, anchor }`, or `null` when it leaves the docs. */
function resolveLink(from: DocPage, href: string): { page: DocPage | null; anchor?: string } | null {
  if (EXTERNAL.test(href)) return null;
  const [target, rawAnchor] = href.split("#");
  const anchor = rawAnchor ? decodeURIComponent(rawAnchor) : undefined;

  if (!target) return { page: from, anchor }; // same-page `#anchor`

  if (target.startsWith("/")) {
    const route = target.endsWith("/") ? target : `${target}/`;
    return { page: byRoute.get(route) ?? null, anchor };
  }

  // Relative file reference (`pages.md`, `../reference/pdf-engine.md`).
  const resolved = normalize(resolve(dirname(from.file), target));
  const match = pages.find((p) => p.file === resolved);
  return { page: match ?? null, anchor };
}

describe("docs links", () => {
  it("finds the docs corpus", () => {
    // A resolver that silently sees zero pages would make every assertion below
    // pass on an empty set — the exact failure mode this suite exists to catch
    // elsewhere.
    expect(pages.length, "no markdown found under src/content/docs").toBeGreaterThan(20);
    expect(byRoute.has("/confluence/export/")).toBe(true);
  });

  it("points every internal link at a page that exists", () => {
    const broken: string[] = [];
    for (const page of pages) {
      for (const href of linksOf(page.text)) {
        const target = resolveLink(page, href);
        if (target && target.page === null) {
          broken.push(`${relative(REPO_ROOT, page.file)} → ${href}`);
        }
      }
    }
    expect(broken, `dead internal links:\n  ${broken.join("\n  ")}`).toEqual([]);
  });

  it("points every anchor at a heading that exists", () => {
    const broken: string[] = [];
    for (const page of pages) {
      for (const href of linksOf(page.text)) {
        const target = resolveLink(page, href);
        if (!target || !target.page || !target.anchor) continue;
        if (!target.page.anchors.has(target.anchor)) {
          broken.push(
            `${relative(REPO_ROOT, page.file)} → ${href} ` +
              `(page has: ${[...target.page.anchors].slice(0, 6).join(", ")}…)`
          );
        }
      }
    }
    expect(broken, `dead anchors:\n  ${broken.join("\n  ")}`).toEqual([]);
  });

  it("lists every docs page in the sidebar", async () => {
    // A page nobody links to and the sidebar does not list is reachable only by
    // search. That is how a whole new section gets written, merged, and never
    // seen — and how `recipes/export-automation` and `confluence/dynamic-macros`
    // stayed off the nav until this assertion was written.
    //
    // `/` is the landing page and `/getting-started/` is its own top-level entry
    // (`link:`, not an `items:` member), so neither appears as a nested route.
    const sidebar = await readFile(join(REPO_ROOT, "astro.config.mjs"), "utf8");
    const missing = pages
      .map((p) => p.route)
      .filter((route) => route !== "/" && route !== "/getting-started/")
      .filter((route) => !sidebar.includes(`'${route}'`) && !sidebar.includes(`"${route}"`));
    expect(
      missing,
      `docs pages absent from the astro.config.mjs sidebar:\n  ${missing.join("\n  ")}`
    ).toEqual([]);
  });
});
